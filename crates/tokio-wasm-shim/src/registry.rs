//! Pure helpers for reasoning about the accounts registry (`accounts.toml`) and
//! sahpool database paths, used by the boot orphan sweep in [`crate::opfs`].
//!
//! Kept free of `web_sys` so it compiles — and unit-tests — on native too; the
//! sweep decision is where a mistake permanently deletes a user's account, so
//! it gets real test coverage rather than living inline in wasm-only code.

use std::path::Path;

/// True if `s` is shaped like an account uuid (8-4-4-4-12 hex).
/// ponytail: hand-rolled shape check, the shim has no `uuid` crate — good
/// enough to tell an account dir name from anything else.
pub fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 36 {
        return false;
    }
    b.iter().enumerate().all(|(i, &c)| match i {
        8 | 13 | 18 | 23 => c == b'-',
        _ => c.is_ascii_hexdigit(),
    })
}

/// Account uuid of a sahpool db logical path `/accounts/<uuid>/dc.db[...]`: the
/// parent directory's name, when it is uuid-shaped. `None` for any other shape
/// (so the sweep never deletes a path it does not understand).
pub fn account_uuid_of_db(db_path: &str) -> Option<&str> {
    let name = Path::new(db_path).parent()?.file_name()?.to_str()?;
    is_uuid(name).then_some(name)
}

/// True if `text` is a plausible `accounts.toml` as core writes it (its
/// serialization emits the scalar `selected_account` first). Binary garbage
/// (the iOS ~1 MB incident) or a 0-byte file fails this.
/// ponytail: prefix proxy, not a full TOML parse — the shim has no parser —
/// so the sweep also cross-checks the last-good backup before deleting
/// anything (see [`is_orphan_slot`]); upgrade path is a `toml` dependency.
pub fn is_plausible_registry(text: &str) -> bool {
    text.trim_start().starts_with("selected_account")
}

const EXPORT_TEMP_DB: &str = "dc_database_backup.sqlite";

/// Whether the sahpool db at `db_path` is an orphan slot the boot sweep may
/// reclaim. Deliberately conservative: a false positive permanently destroys a
/// live account's database, a false negative merely leaves a pool slot in use.
///
/// * `main` — `accounts.toml`; the caller only sweeps when it
///   [`is_plausible_registry`].
/// * `bak` — `accounts.toml.bak`, the last-good registry from before the most
///   recent overwrite.
///
/// Reclaim ONLY when the account uuid is in NEITHER main nor bak. A torn write
/// of main — a crash mid-write leaving a valid-looking prefix that is missing
/// some accounts, exactly what a disk-full / power-loss event produces — is
/// caught by the bak, which still lists every established account, so the sweep
/// never deletes their databases. A genuinely removed account is in neither.
///
/// A crashed provider-side backup export leftover (`dc_database_backup.sqlite`,
/// which lives under a *live* account dir) is also reclaimed: no export runs at
/// boot, so any such file is a leak.
pub fn is_orphan_slot(db_path: &str, main: &str, bak: Option<&str>) -> bool {
    if Path::new(db_path).file_name().and_then(|n| n.to_str()) == Some(EXPORT_TEMP_DB) {
        return true;
    }
    let Some(uuid) = account_uuid_of_db(db_path) else {
        return false; // unrecognized path shape → never delete
    };
    // ponytail: substring test, not a parsed-field lookup — uuids are unique
    // 36-char ids, so it can't false-match one live uuid against another, and
    // a removed uuid cannot appear in a TOML that no longer mentions it.
    let in_main = main.contains(uuid);
    let in_bak = bak.is_some_and(|b| b.contains(uuid));
    !in_main && !in_bak
}

#[cfg(test)]
mod tests {
    use super::*;

    const U1: &str = "11111111-1111-1111-1111-111111111111";
    const U2: &str = "22222222-2222-2222-2222-222222222222";
    const U3: &str = "33333333-3333-3333-3333-333333333333";

    fn toml_with(uuids: &[&str]) -> String {
        let mut s = String::from("selected_account = 1\nnext_id = 9\n");
        for (i, u) in uuids.iter().enumerate() {
            s += &format!("\n[[accounts]]\nid = {}\ndir = \"{u}\"\nuuid = \"{u}\"\n", i + 1);
        }
        s
    }
    fn db(uuid: &str) -> String {
        format!("/accounts/{uuid}/dc.db")
    }

    #[test]
    fn uuid_shape() {
        assert!(is_uuid(U1));
        assert!(!is_uuid("not-a-uuid"));
        assert!(!is_uuid("11111111-1111-1111-1111-11111111111")); // 35 chars
        assert!(!is_uuid("g1111111-1111-1111-1111-111111111111")); // non-hex
    }

    #[test]
    fn extracts_account_uuid() {
        assert_eq!(account_uuid_of_db(&db(U1)), Some(U1));
        assert_eq!(account_uuid_of_db(&format!("/accounts/{U1}/dc.db-wal")), Some(U1));
        assert_eq!(account_uuid_of_db("/accounts/dc.db"), None); // no uuid dir
        assert_eq!(account_uuid_of_db("dc.db"), None);
    }

    #[test]
    fn plausible_gate() {
        assert!(is_plausible_registry(&toml_with(&[U1])));
        assert!(!is_plausible_registry("")); // 0 bytes
        assert!(!is_plausible_registry("\u{fffd}\u{fffd}garbage")); // not a config
    }

    #[test]
    fn live_account_never_reclaimed() {
        let main = toml_with(&[U1, U2]);
        assert!(!is_orphan_slot(&db(U1), &main, None));
        assert!(!is_orphan_slot(&db(U2), &main, Some(&toml_with(&[U1, U2]))));
    }

    #[test]
    fn removed_account_reclaimed() {
        // U3's dir/registry entry is gone from both main and bak → leaked slot.
        let main = toml_with(&[U1, U2]);
        let bak = toml_with(&[U1, U2]);
        assert!(is_orphan_slot(&db(U3), &main, Some(&bak)));
    }

    #[test]
    fn torn_main_missing_uuid_is_saved_by_bak() {
        // The regression the fix targets: a crash left main truncated before U2's
        // block, but bak (the previous complete registry) still lists U2. U2's
        // db must NOT be reclaimed.
        let torn_main = "selected_account = 1\nnext_id = 9\n\n[[accounts]]\nid = 1\ndir = \"".to_string() + U1 + "\"\nuuid = \"" + U1 + "\"\n\n[[accounts]]\nid = 2\ndir = \"22222222-2222";
        assert!(is_plausible_registry(&torn_main)); // passes the coarse gate…
        assert!(!torn_main.contains(U2)); // …yet U2's full uuid was cut off
        let bak = toml_with(&[U1, U2]);
        assert!(!is_orphan_slot(&db(U2), &torn_main, Some(&bak)), "bak must save U2");
        // U1, fully present in main, is obviously kept.
        assert!(!is_orphan_slot(&db(U1), &torn_main, Some(&bak)));
    }

    #[test]
    fn crashed_export_leftover_reclaimed_even_under_live_account() {
        let main = toml_with(&[U1]); // U1 is live
        let leftover = format!("/accounts/{U1}/dc_database_backup.sqlite");
        assert!(is_orphan_slot(&leftover, &main, Some(&main)));
    }

    #[test]
    fn unknown_path_never_reclaimed() {
        let main = toml_with(&[U1]);
        assert!(!is_orphan_slot("/accounts/dc.db", &main, None));
        assert!(!is_orphan_slot("/weird/path", &main, None));
    }
}
