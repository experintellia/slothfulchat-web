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
        Err(e) if persist && tokio::fs::sync_is_file(ACCOUNTS_CONFIG) => {
            let orig = format!("{e:#}");
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

    let mut entries = tokio::fs::read_dir("/accounts").await.map_err(io)?;
    let mut uuids: Vec<String> = Vec::new();
    while let Some(entry) = entries.next_entry().await.map_err(io)? {
        if !entry.metadata().await.map_err(io)?.is_dir() {
            continue;
        }
        match entry.path().file_name().and_then(|n| n.to_str()) {
            Some(name) if uuid::Uuid::parse_str(name).is_ok() => uuids.push(name.to_owned()),
            _ => {}
        }
    }
    uuids.sort();

    // Stage 1: the last-good backup keeps ids, selected_account and account
    // order. Only usable when it lists exactly the accounts that exist on
    // disk — a stale one would silently hide (or list nonexistent) accounts.
    if let Ok(bak) = tokio::fs::read(ACCOUNTS_CONFIG_BAK).await {
        let bak = String::from_utf8_lossy(&bak).into_owned();
        if !bak.is_empty() && config_uuids(&bak) == uuids {
            tokio::fs::write(ACCOUNTS_CONFIG, &bak).await.map_err(io)?;
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

    // Stage 2: rebuild from the account dirs.
    // InnerConfig schema (vendor/core/src/accounts.rs); accounts_order is
    // #[serde(default)] and may be omitted, but `accounts` is required — with
    // no [[accounts]] tables below it must be written as an explicit empty
    // array or the rebuilt file itself fails to parse. ids are reassigned
    // from 1.
    let mut toml = format!(
        "selected_account = {}\nnext_id = {}\n",
        if uuids.is_empty() { 0 } else { 1 },
        uuids.len() + 1
    );
    if uuids.is_empty() {
        toml += "accounts = []\n";
    }
    for (i, uuid) in uuids.iter().enumerate() {
        toml += &format!(
            "\n[[accounts]]\nid = {}\ndir = \"{uuid}\"\nuuid = \"{uuid}\"\n",
            i + 1
        );
    }
    log::warn!(
        "rebuilt accounts.toml with {} account(s):\n{toml}",
        uuids.len()
    );
    tokio::fs::write(ACCOUNTS_CONFIG, toml).await.map_err(io)?;
    Accounts::new(PathBuf::from("/accounts"), true)
        .await
        .map_err(|e| format!("rebuilt accounts.toml is still unusable: {e:#}"))
}

/// Extracts the sorted account uuids out of an accounts.toml body (the
/// `uuid` keys of the `[[accounts]]` tables). Real TOML parse — a string
/// scrape would silently rot with core's serialization format and disable
/// the heal's backup stage. Unparseable/malformed input yields an empty
/// list, which never matches a non-empty dir set.
fn config_uuids(text: &str) -> Vec<String> {
    let Ok(value) = text.parse::<toml::Value>() else {
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
}
