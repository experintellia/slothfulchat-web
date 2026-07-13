//! Browser entry point for chatmail core.
//!
//! Mirrors deltachat-rpc-server, with stdio replaced by a JS callback
//! (core → JS) and [`DeltaChat::receive`] (JS → core). Both sides carry
//! plain JSON-RPC strings, so the standard `@deltachat/jsonrpc-client`
//! TypeScript package works on top unchanged.

use std::path::PathBuf;
use std::sync::Arc;

use deltachat_jsonrpc::api::{Accounts, CommandApi};
use futures_lite::stream::StreamExt;
use tokio::sync::RwLock;
use wasm_bindgen::prelude::*;
use yerpc::{RpcClient, RpcSession};

#[wasm_bindgen]
pub struct DeltaChat {
    session: RpcSession<CommandApi>,
}

/// Starts chatmail core with the accounts directory at `/accounts` (in-memory
/// filesystem) and returns a handle speaking JSON-RPC.
///
/// `on_message` is called with every outgoing JSON-RPC message (responses and
/// event notifications) as a string.
///
/// `ws_proxy_url` (optional, e.g. `ws://localhost:8641`) points at a
/// WebSocket→TCP proxy for IMAP/SMTP/DNS; without it all networking errors.
///
/// `persist` enables OPFS persistence: sqlite databases via the opfs-sahpool
/// VFS, everything else via an OPFS mirror of the in-memory fs (hydrated
/// here, written through on every change). Off = fully ephemeral (tests).
#[wasm_bindgen]
pub async fn init(
    on_message: js_sys::Function,
    ws_proxy_url: Option<String>,
    persist: bool,
) -> Result<DeltaChat, JsValue> {
    console_error_panic_hook::set_once();
    let _ = console_log::init_with_level(log::Level::Info);

    if let Some(url) = ws_proxy_url {
        deltachat::net::ws_tcp::set_ws_proxy_url(url);
    }

    if persist {
        // must run before Accounts::new: makes sahpool the default sqlite VFS
        // and loads the persisted fs tree (accounts.toml, blobs) into memfs
        tokio::fs::enable_persistence()
            .await
            .map_err(|e| JsValue::from_str(&format!("failed to enable persistence: {e}")))?;
    }

    let accounts = match Accounts::new(PathBuf::from("/accounts"), true).await {
        Ok(accounts) => accounts,
        // A corrupted accounts.toml otherwise bricks the app forever (seen on
        // iOS: the OPFS mirror handed back ~1MB of garbage for it). The sqlite
        // DBs live in the sahpool VFS and are unaffected, so rebuilding the
        // account list recovers everything.
        //
        // But only heal when the config is ACTUALLY bad. A storage failure —
        // e.g. the sahpool pool exhausted → sqlite SQLITE_CANTOPEN, the post-#75
        // boot incident — surfaces through `Accounts::new` exactly like a corrupt
        // config would, yet rebuilding the registry cannot fix it: the heal then
        // quarantines a perfectly VALID accounts.toml, rebuilds it identically
        // and fails the same way (a quarantine loop on every boot). Gate the heal
        // on the config being implausible for the account dirs on disk.
        Err(e) if persist && tokio::fs::sync_is_file(ACCOUNTS_CONFIG) => {
            let orig = format!("{e:#}");
            let text = tokio::fs::read_to_string(ACCOUNTS_CONFIG)
                .await
                .unwrap_or_default();
            let disk_uuids = disk_account_uuids().await.unwrap_or_default();
            if config_is_plausible(&text, &disk_uuids) {
                return Err(JsValue::from_str(&format!(
                    "failed to create accounts: {orig} (accounts.toml is valid and matches the \
                     account dirs; not healing — the failure is elsewhere, e.g. sqlite storage)"
                )));
            }
            heal_accounts_config(&orig).await.map_err(|heal| {
                JsValue::from_str(&format!(
                    "failed to create accounts: {orig} (self-heal failed: {heal})"
                ))
            })?
        }
        Err(e) => {
            return Err(JsValue::from_str(&format!(
                "failed to create accounts: {e:#}"
            )))
        }
    };
    let accounts = Arc::new(RwLock::new(accounts));
    let state = CommandApi::from_arc(accounts).await;

    let (client, mut out_receiver) = RpcClient::new();
    let session = RpcSession::new(client, state);

    wasm_bindgen_futures::spawn_local(async move {
        while let Some(message) = out_receiver.next().await {
            match serde_json::to_string(&message) {
                Ok(message) => {
                    let _ = on_message.call1(&JsValue::NULL, &JsValue::from_str(&message));
                }
                Err(err) => log::error!("failed to serialize RPC message: {err}"),
            }
        }
    });

    Ok(DeltaChat { session })
}

const ACCOUNTS_CONFIG: &str = "/accounts/accounts.toml";
/// Last-good copy, refreshed by the fs shim before every accounts.toml
/// overwrite (crates/tokio-wasm-shim/src/opfs.rs).
const ACCOUNTS_CONFIG_BAK: &str = "/accounts/accounts.toml.bak";

/// The account uuids present on disk: the uuid-named dirs directly under
/// `/accounts` (a dir name IS its account uuid). Sorted. Shared by the
/// self-heal rebuild and the heal gate ([`config_is_plausible`]).
async fn disk_account_uuids() -> std::io::Result<Vec<String>> {
    let mut entries = tokio::fs::read_dir("/accounts").await?;
    let mut uuids: Vec<String> = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        if !entry.metadata().await?.is_dir() {
            continue;
        }
        match entry.path().file_name().and_then(|n| n.to_str()) {
            Some(name) if uuid::Uuid::parse_str(name).is_ok() => uuids.push(name.to_owned()),
            _ => {}
        }
    }
    uuids.sort();
    Ok(uuids)
}

/// Whether `text` is a usable accounts.toml for the accounts on disk — the gate
/// that keeps the self-heal from firing on non-config failures. A storage error
/// (e.g. the sahpool pool exhausted → sqlite CANTOPEN, post-#75) reaches
/// `Accounts::new`'s error arm just like a corrupt config would, but rebuilding
/// the registry cannot fix it, and quarantining a VALID config is pure damage
/// (it loops). So the heal runs only when THIS returns false.
///
/// Plausible = parses as a TOML document with integer `selected_account` and
/// `next_id`, and an `accounts` array whose every entry has an integer id ≥ 1
/// and a string uuid, AND every listed uuid has a dir on disk. (A registry that
/// references a nonexistent dir IS heal-worthy — the rebuild drops the ghost. A
/// disk dir NOT yet in the config is fine: that is a freshly created account.)
fn config_is_plausible(text: &str, disk_uuids: &[String]) -> bool {
    // `toml::from_str`, NOT `str::parse::<toml::Value>()`: toml 0.9's FromStr
    // parses a lone value and rejects a whole document.
    let Ok(value) = toml::from_str::<toml::Value>(text) else {
        return false;
    };
    if value
        .get("selected_account")
        .and_then(|v| v.as_integer())
        .is_none()
    {
        return false;
    }
    if value.get("next_id").and_then(|v| v.as_integer()).is_none() {
        return false;
    }
    let Some(accounts) = value.get("accounts").and_then(|v| v.as_array()) else {
        return false;
    };
    let disk: std::collections::HashSet<&str> = disk_uuids.iter().map(String::as_str).collect();
    for account in accounts {
        match account.get("id").and_then(|v| v.as_integer()) {
            Some(id) if id >= 1 => {}
            _ => return false,
        }
        let Some(uuid) = account.get("uuid").and_then(|v| v.as_str()) else {
            return false;
        };
        if !disk.contains(uuid) {
            return false; // registry lists an account with no dir on disk → heal
        }
    }
    true
}

/// Last-resort recovery for a corrupted accounts.toml: dump the contents to
/// the console, quarantine the file to accounts.toml.broken (kept in OPFS
/// for forensics), then restore the last-good backup — or, when the backup
/// is missing/stale/unusable, rebuild the file from the account directories,
/// whose names are the account uuids (`AccountConfig { id, dir, uuid }`,
/// dir == uuid). Returns the freshly opened account manager.
async fn heal_accounts_config(cause: &str) -> Result<Accounts, String> {
    let io = |e: std::io::Error| e.to_string();
    let bytes = tokio::fs::read(ACCOUNTS_CONFIG).await.map_err(io)?;
    let hex: Vec<String> = bytes.iter().take(64).map(|b| format!("{b:02x}")).collect();
    log::error!(
        "accounts.toml is corrupt ({cause}); quarantining to accounts.toml.broken and restoring \
         from backup / the account dirs.\nsize: {} bytes\nfirst 64 bytes: {}\nfirst 4 KiB (lossy):\n{}",
        bytes.len(),
        hex.join(" "),
        String::from_utf8_lossy(&bytes[..bytes.len().min(4096)])
    );
    tokio::fs::rename(ACCOUNTS_CONFIG, "/accounts/accounts.toml.broken")
        .await
        .map_err(io)?;

    let uuids = disk_account_uuids().await.map_err(io)?;

    let bak = tokio::fs::read(ACCOUNTS_CONFIG_BAK)
        .await
        .ok()
        .map(|b| String::from_utf8_lossy(&b).into_owned());

    // Stage 1: the last-good backup keeps ids, selected_account and account
    // order. Only usable verbatim when it lists exactly the accounts that
    // exist on disk — a stale one would silently hide (or list nonexistent)
    // accounts. This exact-match path is the strongest recovery.
    if let Some(bak) = &bak {
        if !bak.is_empty() && config_uuids(bak) == uuids {
            tokio::fs::write(ACCOUNTS_CONFIG, bak).await.map_err(io)?;
            match Accounts::new(PathBuf::from("/accounts"), true).await {
                Ok(accounts) => {
                    log::warn!("restored accounts.toml from the last-good backup");
                    return Ok(accounts);
                }
                Err(e) => log::warn!(
                    "backup accounts.toml is unusable too ({e:#}); rebuilding from the account dirs"
                ),
            }
        }
    }

    // Stage 2: rebuild from the account dirs, using the backup (even when its
    // uuid set no longer matches disk exactly) as *id hints* so surviving
    // accounts keep their numbering; new dirs get fresh ids. Renumbering from
    // 1 would break every persisted account reference (issue #75).
    let toml = rebuild_config(&uuids, bak.as_deref());
    log::warn!(
        "rebuilt accounts.toml with {} account(s):\n{toml}",
        uuids.len()
    );
    tokio::fs::write(ACCOUNTS_CONFIG, &toml).await.map_err(io)?;
    Accounts::new(PathBuf::from("/accounts"), true)
        .await
        .map_err(|e| format!("rebuilt accounts.toml is still unusable: {e:#}"))
}

/// Per-account id hints salvaged from a (possibly stale) accounts.toml.bak.
struct ConfigHints {
    /// uuid → id from the backup.
    ids: std::collections::HashMap<String, u32>,
    /// uuid the backup had selected, if that id resolved to an account.
    selected_uuid: Option<String>,
    /// the backup's `next_id` (0 if absent), so we never reissue an id it had
    /// already handed out to an account since deleted.
    next_id: u32,
    /// the backup's `accounts_order` (ids), preserved where the ids survive.
    order: Vec<u32>,
}

/// Tolerant parse of the backup into id hints. Returns `None` when the backup
/// is unparseable OR internally inconsistent (an account without id/uuid,
/// duplicate ids, duplicate uuids, id < 1) — such hints can't be trusted, so
/// the caller renumbers from scratch instead.
fn parse_hints(bak: &str) -> Option<ConfigHints> {
    use std::collections::{HashMap, HashSet};
    // Ids above this are rejected as implausible: core issues ids sequentially
    // from 1, so such a value signals corruption, and letting one through risks
    // the `saturating_add` in rebuild_config pinning at u32::MAX and colliding
    // (two "next" ids both saturate to the same value → duplicate id).
    const MAX_PLAUSIBLE_ID: i64 = 1_000_000;
    // `toml::from_str`, NOT `str::parse::<toml::Value>()`: in toml 0.9 the
    // FromStr impl parses a single *value*, so it rejects a whole document.
    let value = toml::from_str::<toml::Value>(bak).ok()?;
    let accounts = value.get("accounts")?.as_array()?;
    let mut ids: HashMap<String, u32> = HashMap::new();
    let mut id_set: HashSet<u32> = HashSet::new();
    let mut id_to_uuid: HashMap<u32, String> = HashMap::new();
    for account in accounts {
        let id = account.get("id")?.as_integer()?;
        let uuid = account.get("uuid")?.as_str()?.to_owned();
        if id > MAX_PLAUSIBLE_ID {
            return None; // implausibly large id → distrust the whole hints
        }
        let id = u32::try_from(id).ok().filter(|&id| id >= 1)?;
        if !id_set.insert(id) {
            return None; // duplicate id
        }
        if ids.insert(uuid.clone(), id).is_some() {
            return None; // duplicate uuid
        }
        id_to_uuid.insert(id, uuid);
    }
    let selected_uuid = value
        .get("selected_account")
        .and_then(|v| v.as_integer())
        .and_then(|v| u32::try_from(v).ok())
        .and_then(|id| id_to_uuid.get(&id).cloned());
    let next_id_raw = value.get("next_id").and_then(|v| v.as_integer());
    if next_id_raw.is_some_and(|v| v > MAX_PLAUSIBLE_ID) {
        return None; // implausibly large next_id → distrust the whole hints
    }
    let next_id = next_id_raw.and_then(|v| u32::try_from(v).ok()).unwrap_or(0);
    let order = value
        .get("accounts_order")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_integer())
                .filter_map(|v| u32::try_from(v).ok())
                .collect()
        })
        .unwrap_or_default();
    Some(ConfigHints {
        ids,
        selected_uuid,
        next_id,
        order,
    })
}

/// Rebuilds an accounts.toml body from the account directories on disk.
///
/// `disk_uuids` are the uuid-named dirs (sorted internally, so caller order
/// does not matter). `bak` is the raw backup body, if any. When the backup
/// parses into consistent [`ConfigHints`], surviving uuids keep their backup
/// id, selection and order; brand-new uuids get ids after the highest one
/// already in use (respecting the backup's `next_id`). Otherwise (no backup /
/// unusable hints) ids are assigned from 1 in uuid-sorted order — the
/// historical behavior.
///
/// The output parses as core's `InnerConfig` (vendor/core/src/accounts.rs):
/// `accounts_order` is `#[serde(default)]` (omitted when empty), but `accounts`
/// is required — with no `[[accounts]]` tables it must be an explicit `[]`.
fn rebuild_config(disk_uuids: &[String], bak: Option<&str>) -> String {
    use std::collections::HashSet;

    let hints = bak.and_then(parse_hints);

    // Sort here so the numbering (and the new-uuid id order) is deterministic
    // regardless of the caller's dir-iteration order.
    let mut disk: Vec<&String> = disk_uuids.iter().collect();
    disk.sort();

    // Assign an id to every disk uuid, and compute the next unissued id.
    let mut assigned: Vec<(u32, &String)> = Vec::new();
    let next_id = if let Some(hints) = &hints {
        let mut max_used = 0u32;
        let mut new_uuids: Vec<&String> = Vec::new();
        for &uuid in &disk {
            match hints.ids.get(uuid) {
                Some(&id) => {
                    assigned.push((id, uuid));
                    max_used = max_used.max(id);
                }
                None => new_uuids.push(uuid),
            }
        }
        // New ids start past the highest surviving id, never below the
        // backup's next_id (so a since-deleted account's id is not reused).
        let mut next = max_used.saturating_add(1).max(hints.next_id).max(1);
        for uuid in new_uuids {
            assigned.push((next, uuid));
            next = next.saturating_add(1);
        }
        // Keep the backup's next_id floor even when no new uuid consumed it:
        // ids below it were provably handed out before (to accounts since
        // deleted), and reissuing one would let stale per-account state keyed
        // on the id bleed into a future account.
        next
    } else {
        for (i, &uuid) in disk.iter().enumerate() {
            assigned.push((i as u32 + 1, uuid));
        }
        disk.len() as u32 + 1
    };
    assigned.sort_by_key(|(id, _)| *id);

    // selected_account: the backup's selection if its uuid still exists, else
    // the lowest-id account, else 0 (no accounts).
    let selected = hints
        .as_ref()
        .and_then(|h| h.selected_uuid.as_ref())
        .and_then(|uuid| assigned.iter().find(|(_, u)| *u == uuid).map(|(id, _)| *id))
        .unwrap_or_else(|| assigned.iter().map(|(id, _)| *id).min().unwrap_or(0));

    // accounts_order: the backup's order filtered to surviving ids, then any
    // remaining ids appended (sorted, for a deterministic file).
    let assigned_ids: HashSet<u32> = assigned.iter().map(|(id, _)| *id).collect();
    let mut order: Vec<u32> = Vec::new();
    if let Some(hints) = &hints {
        for id in &hints.order {
            if assigned_ids.contains(id) && !order.contains(id) {
                order.push(*id);
            }
        }
    }
    let mut remaining: Vec<u32> = assigned
        .iter()
        .map(|(id, _)| *id)
        .filter(|id| !order.contains(id))
        .collect();
    remaining.sort_unstable();
    order.extend(remaining);

    let mut toml = format!("selected_account = {selected}\nnext_id = {next_id}\n");
    if !order.is_empty() {
        let ids: Vec<String> = order.iter().map(u32::to_string).collect();
        toml += &format!("accounts_order = [{}]\n", ids.join(", "));
    }
    if assigned.is_empty() {
        toml += "accounts = []\n";
    }
    for (id, uuid) in &assigned {
        toml += &format!("\n[[accounts]]\nid = {id}\ndir = \"{uuid}\"\nuuid = \"{uuid}\"\n");
    }
    toml
}

/// Extracts the sorted account uuids out of an accounts.toml body (the
/// `uuid` keys of the `[[accounts]]` tables). Real TOML parse — a string
/// scrape would silently rot with core's serialization format and disable
/// the heal's backup stage. Unparseable/malformed input yields an empty
/// list, which never matches a non-empty dir set.
fn config_uuids(text: &str) -> Vec<String> {
    // `toml::from_str`, NOT `str::parse::<toml::Value>()`: toml 0.9's FromStr
    // parses a lone value and rejects a document, which would silently disable
    // this whole stage (empty list never equals a non-empty dir set).
    let Ok(value) = toml::from_str::<toml::Value>(text) else {
        return Vec::new();
    };
    let Some(accounts) = value.get("accounts").and_then(|a| a.as_array()) else {
        return Vec::new();
    };
    let mut uuids: Vec<String> = accounts
        .iter()
        .filter_map(|account| account.get("uuid").and_then(|u| u.as_str()))
        .map(str::to_owned)
        .collect();
    if uuids.len() != accounts.len() {
        return Vec::new(); // an account entry without a uuid = malformed
    }
    uuids.sort();
    uuids
}

fn fs_err(err: std::io::Error) -> JsValue {
    JsValue::from_str(&err.to_string())
}

#[wasm_bindgen]
impl DeltaChat {
    /// Feeds one incoming JSON-RPC message (request string) to core.
    /// Responses arrive via the `on_message` callback passed to `init`.
    pub fn receive(&self, message: String) {
        let session = self.session.clone();
        wasm_bindgen_futures::spawn_local(async move {
            session.handle_incoming(&message).await;
        });
    }

    // fs side channel into the in-memory filesystem core runs on
    // (blob display, temp files, backup import/export).

    pub fn fs_read(&self, path: String) -> Result<js_sys::Uint8Array, JsValue> {
        let data = tokio::fs::sync_read(&path).map_err(fs_err)?;
        Ok(js_sys::Uint8Array::from(data.as_slice()))
    }

    /// Creates parent directories automatically.
    pub fn fs_write(&self, path: String, data: &[u8]) -> Result<(), JsValue> {
        tokio::fs::sync_write(&path, data).map_err(fs_err)
    }

    /// Removes a file or a directory tree.
    pub fn fs_remove(&self, path: String) -> Result<(), JsValue> {
        tokio::fs::sync_remove(&path).map_err(fs_err)
    }

    pub fn fs_exists(&self, path: String) -> bool {
        tokio::fs::sync_exists(&path)
    }

    pub fn fs_mkdirp(&self, path: String) -> Result<(), JsValue> {
        tokio::fs::sync_create_dir_all(&path).map_err(fs_err)
    }

    /// Awaits until every queued OPFS write-through is durable. Used after a
    /// backup import so the imported blobs are persisted before the RPC
    /// resolves — otherwise a reload before the async flusher drains them
    /// rebuilds the memfs from OPFS without those blobs (#77). No-op unless
    /// persistence is enabled.
    pub async fn fs_flush(&self) {
        tokio::fs::flush_pending().await;
    }
}

#[cfg(test)]
mod tests {
    use super::{config_is_plausible, rebuild_config};

    // Re-parses a rebuilt body and pulls out the fields the tests assert on.
    // Doubles as a check that every emitted body is valid TOML.
    fn parse(body: &str) -> (u32, u32, Vec<u32>, Vec<(u32, String)>) {
        let value: toml::Value = toml::from_str(body).expect("rebuilt toml must parse");
        let selected = value["selected_account"].as_integer().unwrap() as u32;
        let next_id = value["next_id"].as_integer().unwrap() as u32;
        let order: Vec<u32> = value
            .get("accounts_order")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().map(|v| v.as_integer().unwrap() as u32).collect())
            .unwrap_or_default();
        let accounts = value["accounts"].as_array().unwrap();
        let accounts = accounts
            .iter()
            .map(|a| {
                let id = a["id"].as_integer().unwrap() as u32;
                let uuid = a["uuid"].as_str().unwrap().to_owned();
                assert_eq!(a["dir"].as_str().unwrap(), uuid, "dir must equal uuid");
                (id, uuid)
            })
            .collect();
        (selected, next_id, order, accounts)
    }

    fn u(n: u8) -> String {
        // deterministic, uuid-shaped, already sort-stable in this byte
        format!("00000000-0000-0000-0000-0000000000{n:02x}")
    }

    #[test]
    fn no_bak_renumbers_from_one_uuid_sorted() {
        let disk = vec![u(2), u(1), u(3)];
        let mut sorted = disk.clone();
        sorted.sort();
        let (selected, next_id, _order, accounts) = parse(&rebuild_config(&disk, None));
        assert_eq!(selected, 1);
        assert_eq!(next_id, 4);
        assert_eq!(
            accounts,
            vec![
                (1, sorted[0].clone()),
                (2, sorted[1].clone()),
                (3, sorted[2].clone())
            ]
        );
    }

    #[test]
    fn garbage_bak_renumbers_from_one() {
        let disk = vec![u(1), u(2)];
        let (selected, next_id, _order, accounts) =
            parse(&rebuild_config(&disk, Some("this is not toml {{{")));
        assert_eq!(selected, 1);
        assert_eq!(next_id, 3);
        assert_eq!(accounts, vec![(1, u(1)), (2, u(2))]);
    }

    #[test]
    fn partial_overlap_keeps_ids_new_gets_next() {
        // bak knew accounts 7 and 4; disk still has 7's uuid plus a brand-new
        // one; account 4's uuid is gone.
        let bak = format!(
            "selected_account = 7\nnext_id = 9\naccounts_order = [4, 7]\n\
             \n[[accounts]]\nid = 7\ndir = \"{a}\"\nuuid = \"{a}\"\n\
             \n[[accounts]]\nid = 4\ndir = \"{b}\"\nuuid = \"{b}\"\n",
            a = u(7),
            b = u(4),
        );
        let mut disk = vec![u(7), u(9)]; // u(9) is new
        disk.sort();
        let (selected, next_id, order, accounts) = parse(&rebuild_config(&disk, Some(&bak)));
        // u(7) keeps id 7; the new uuid gets the backup's next_id (9).
        assert!(accounts.contains(&(7, u(7))));
        assert!(accounts.contains(&(9, u(9))));
        assert_eq!(accounts.len(), 2);
        assert_eq!(next_id, 10);
        assert_eq!(selected, 7); // selected uuid survived
                                 // order: bak order filtered to survivors (7), then new ids appended (9).
        assert_eq!(order, vec![7, 9]);
    }

    #[test]
    fn bak_next_id_floor_survives_without_new_uuids() {
        // bak had handed out ids up to 8 (next_id = 9) to accounts since
        // deleted; only id 2 survives and NO new dir exists. The rebuilt
        // next_id must stay 9 — dropping to 3 would reissue ids that stale
        // per-account state may still reference.
        let bak = format!(
            "selected_account = 2\nnext_id = 9\n\
             \n[[accounts]]\nid = 2\ndir = \"{a}\"\nuuid = \"{a}\"\n\
             \n[[accounts]]\nid = 7\ndir = \"{gone}\"\nuuid = \"{gone}\"\n",
            a = u(2),
            gone = u(7),
        );
        let disk = vec![u(2)];
        let (selected, next_id, _order, accounts) = parse(&rebuild_config(&disk, Some(&bak)));
        assert_eq!(accounts, vec![(2, u(2))]);
        assert_eq!(next_id, 9);
        assert_eq!(selected, 2);
    }

    #[test]
    fn duplicate_id_hints_are_ignored() {
        // two accounts share id 1 → hints unusable → renumber from 1.
        let bak = format!(
            "selected_account = 1\nnext_id = 2\n\
             \n[[accounts]]\nid = 1\ndir = \"{a}\"\nuuid = \"{a}\"\n\
             \n[[accounts]]\nid = 1\ndir = \"{b}\"\nuuid = \"{b}\"\n",
            a = u(5),
            b = u(6),
        );
        let mut disk = vec![u(5), u(6)];
        disk.sort();
        let (selected, next_id, _order, accounts) = parse(&rebuild_config(&disk, Some(&bak)));
        assert_eq!(selected, 1);
        assert_eq!(next_id, 3);
        assert_eq!(accounts, vec![(1, disk[0].clone()), (2, disk[1].clone())]);
    }

    #[test]
    fn selected_account_falls_back_when_selection_gone() {
        // bak selected an account whose uuid no longer exists on disk.
        let bak = format!(
            "selected_account = 3\nnext_id = 4\n\
             \n[[accounts]]\nid = 2\ndir = \"{a}\"\nuuid = \"{a}\"\n\
             \n[[accounts]]\nid = 3\ndir = \"{gone}\"\nuuid = \"{gone}\"\n",
            a = u(2),
            gone = u(3),
        );
        let disk = vec![u(2)]; // only account 2 survives
        let (selected, next_id, _order, accounts) = parse(&rebuild_config(&disk, Some(&bak)));
        assert_eq!(accounts, vec![(2, u(2))]);
        assert_eq!(selected, 2); // lowest surviving id, since selection is gone
        assert_eq!(next_id, 4); // the bak's next_id floor, not max surviving + 1
    }

    #[test]
    fn empty_dir_set() {
        let (selected, next_id, order, accounts) = parse(&rebuild_config(&[], None));
        assert_eq!(selected, 0);
        assert_eq!(next_id, 1);
        assert!(order.is_empty());
        assert!(accounts.is_empty());
    }

    // One `[[accounts]]` table for uuid `a` with the given id.
    fn account_entry(id: u32, a: &str) -> String {
        format!("\n[[accounts]]\nid = {id}\ndir = \"{a}\"\nuuid = \"{a}\"\n")
    }

    #[test]
    fn plausible_valid_config_matching_disk() {
        let cfg = format!(
            "selected_account = 1\nnext_id = 2\n{}",
            account_entry(1, &u(1))
        );
        assert!(config_is_plausible(&cfg, &[u(1)]));
        // an empty registry with no dirs is also plausible (fresh origin).
        assert!(config_is_plausible(
            "selected_account = 0\nnext_id = 1\naccounts = []\n",
            &[]
        ));
    }

    #[test]
    fn implausible_when_unparseable() {
        assert!(!config_is_plausible("this is not toml {{{", &[u(1)]));
    }

    #[test]
    fn implausible_when_missing_key() {
        // next_id absent
        let no_next = format!("selected_account = 1\n{}", account_entry(1, &u(1)));
        assert!(!config_is_plausible(&no_next, &[u(1)]));
        // accounts array absent
        assert!(!config_is_plausible(
            "selected_account = 0\nnext_id = 1\n",
            &[]
        ));
    }

    #[test]
    fn implausible_when_id_below_one() {
        let cfg = format!(
            "selected_account = 0\nnext_id = 1\n{}",
            account_entry(0, &u(1))
        );
        assert!(!config_is_plausible(&cfg, &[u(1)]));
    }

    #[test]
    fn implausible_when_listed_uuid_has_no_dir() {
        // registry references an account whose dir is gone → heal-worthy ghost.
        let cfg = format!(
            "selected_account = 1\nnext_id = 2\n{}",
            account_entry(1, &u(1))
        );
        assert!(!config_is_plausible(&cfg, &[])); // nothing on disk
        assert!(!config_is_plausible(&cfg, &[u(2)])); // a different dir on disk
    }

    #[test]
    fn plausible_ignores_extra_disk_dirs() {
        // a brand-new dir not yet in the config is not a reason to heal.
        let cfg = format!(
            "selected_account = 1\nnext_id = 3\n{}",
            account_entry(1, &u(1))
        );
        assert!(config_is_plausible(&cfg, &[u(1), u(2)]));
    }

    #[test]
    fn empty_dir_set_with_bak() {
        let bak = format!(
            "selected_account = 1\nnext_id = 2\n\
             \n[[accounts]]\nid = 1\ndir = \"{a}\"\nuuid = \"{a}\"\n",
            a = u(1),
        );
        let (selected, next_id, _order, accounts) = parse(&rebuild_config(&[], Some(&bak)));
        assert_eq!(selected, 0);
        // the bak's next_id floor holds even with no survivors: id 1 was
        // provably issued to the (now gone) account
        assert_eq!(next_id, 2);
        assert!(accounts.is_empty());
    }
}
