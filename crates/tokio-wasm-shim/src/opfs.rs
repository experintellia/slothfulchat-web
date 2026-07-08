//! OPFS persistence for the wasm core (M5).
//!
//! Two independent pieces, both switched on by [`enable_persistence`]:
//!
//! 1. **SQLite → OPFS**: installs the `opfs-sahpool` VFS from `sqlite-wasm-vfs`
//!    as the *default* sqlite VFS, so every database rusqlite opens lands in
//!    OPFS under `.opfs-sahpool/.opaque/*` (opaque pool files with the real
//!    path embedded in a header). DB files never touch the memfs, so there is
//!    no double storage.
//! 2. **memfs → OPFS mirror**: the in-memory fs is hydrated from the OPFS
//!    directory `memfs/` at startup, and every mutation is written through
//!    asynchronously by a single FIFO flusher task (single-threaded worker,
//!    no races). Dirty paths are deduplicated and the *current* memfs state
//!    is snapshotted at flush time, so the mirror converges to last-state.
//!
//! Also hosts the sqlite VFS byte-level import/export helpers the patched
//! core uses for backup IMEX; they dispatch to whichever VFS is the default
//! (sahpool when persistence is on, the memory VFS otherwise).

use std::cell::RefCell;
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use futures::channel::mpsc::{unbounded, UnboundedReceiver, UnboundedSender};
use futures::StreamExt;
use js_sys::Uint8Array;
use sqlite_wasm_vfs::sahpool::{install as install_sahpool, OpfsSAHPoolCfgBuilder, OpfsSAHPoolUtil};
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;
use web_sys::{
    FileSystemDirectoryHandle, FileSystemFileHandle, FileSystemGetDirectoryOptions,
    FileSystemGetFileOptions, FileSystemReadWriteOptions, FileSystemRemoveOptions,
    FileSystemSyncAccessHandle, WorkerGlobalScope,
};

use crate::fs::{self, Snapshot};

/// OPFS directory mirroring the memfs root ("/" ↔ "memfs/").
/// Keeps the mirror clearly separated from sahpool's `.opfs-sahpool` dir.
const MIRROR_DIR: &str = "memfs";

static ENABLED: AtomicBool = AtomicBool::new(false);
/// Paths queued for flushing; dedupes queue entries (last state wins anyway).
static PENDING: Mutex<Option<(UnboundedSender<PathBuf>, HashSet<PathBuf>)>> = Mutex::new(None);

thread_local! {
    /// sahpool management handle; `Some` = persistence is on (util is not Send).
    static SAHPOOL: RefCell<Option<OpfsSAHPoolUtil>> = const { RefCell::new(None) };
}

fn js_err(err: JsValue) -> String {
    format!("{err:?}")
}

/// Installs the sahpool sqlite VFS (as default), hydrates the memfs from
/// OPFS and starts the write-through flusher. Call once, in a dedicated
/// worker, before opening any database.
pub async fn enable_persistence() -> Result<(), String> {
    // ponytail: fixed pool of 32 OPFS files (db+wal+journal per account plus
    // temp/backup copies); grow via SAHPOOL add_capacity if that ever limits.
    let cfg = OpfsSAHPoolCfgBuilder::new().initial_capacity(32).build();
    let util = install_sahpool::<sqlite_wasm_rs::WasmOsCallback>(&cfg, true)
        .await
        .map_err(|e| format!("failed to install opfs-sahpool vfs: {e}"))?;
    SAHPOOL.with(|c| *c.borrow_mut() = Some(util));

    let root = mirror_root().await.map_err(js_err)?;
    hydrate(&root).await.map_err(|e| format!("opfs hydrate failed: {}", js_err(e)))?;

    let (tx, rx) = unbounded();
    *PENDING.lock().unwrap() = Some((tx, HashSet::new()));
    ENABLED.store(true, Ordering::Relaxed);
    wasm_bindgen_futures::spawn_local(flusher(root, rx));
    Ok(())
}

/// Queues `path` (normalized, absolute) for asynchronous OPFS reconciliation.
/// No-op unless persistence is enabled.
pub(crate) fn mark_dirty(path: &Path) {
    if !ENABLED.load(Ordering::Relaxed) {
        return;
    }
    let mut guard = PENDING.lock().unwrap();
    if let Some((tx, pending)) = guard.as_mut() {
        if pending.insert(path.to_path_buf()) {
            let _ = tx.unbounded_send(path.to_path_buf());
        }
    }
}

async fn flusher(root: FileSystemDirectoryHandle, mut rx: UnboundedReceiver<PathBuf>) {
    while let Some(path) = rx.next().await {
        // un-mark before snapshotting so later mutations re-queue the path
        if let Some((_, pending)) = PENDING.lock().unwrap().as_mut() {
            pending.remove(&path);
        }
        if let Err(err) = reconcile(&root, &path).await {
            web_sys::console::warn_2(
                &JsValue::from_str(&format!("opfs write-through failed for {path:?}")),
                &err,
            );
        }
    }
}

/// Makes the OPFS mirror match the current memfs state at `path`.
async fn reconcile(root: &FileSystemDirectoryHandle, path: &Path) -> Result<(), JsValue> {
    match fs::snapshot(path) {
        Snapshot::File(data) => {
            let dir = ensure_dirs(root, path.parent().unwrap_or(Path::new("/"))).await?;
            let name = file_name(path)?;
            let create = FileSystemGetFileOptions::new();
            create.set_create(true);
            let handle: FileSystemFileHandle =
                JsFuture::from(dir.get_file_handle_with_options(&name, &create))
                    .await?
                    .into();
            // Sync access handle, NOT createWritable(): WebKit only shipped
            // FileSystemWritableFileStream in Safari 18.4 and we saw it hand
            // back ~1MB of garbage as accounts.toml on iOS. SAH is the older
            // API the sahpool sqlite VFS already trusts on the same devices.
            // Write first, truncate to the new length last — no empty-file
            // window if the worker dies mid-reconcile.
            let sah: FileSystemSyncAccessHandle =
                JsFuture::from(handle.create_sync_access_handle())
                    .await?
                    .into();
            let write = |data: &[u8]| -> Result<(), JsValue> {
                let opts = FileSystemReadWriteOptions::new();
                opts.set_at(0.0);
                let written = sah.write_with_u8_array_and_options(data, &opts)?;
                if written as usize != data.len() {
                    return Err(JsValue::from_str(&format!(
                        "opfs: partial write ({written} of {} bytes)",
                        data.len()
                    )));
                }
                sah.truncate_with_f64(data.len() as f64)?;
                sah.flush()?;
                Ok(())
            };
            let result = write(&data);
            sah.close();
            result?;
        }
        Snapshot::Dir => {
            ensure_dirs(root, path).await?;
        }
        Snapshot::Missing => {
            // walk to the parent without creating; missing on the way = already gone
            let mut dir = root.clone();
            for part in normal_components(path.parent().unwrap_or(Path::new("/"))) {
                match JsFuture::from(dir.get_directory_handle(&part)).await {
                    Ok(handle) => dir = handle.into(),
                    Err(_) => return Ok(()),
                }
            }
            let opts = FileSystemRemoveOptions::new();
            opts.set_recursive(true);
            // NotFound is fine (e.g. removed twice, or never flushed)
            let _ = JsFuture::from(dir.remove_entry_with_options(&file_name(path)?, &opts)).await;
        }
    }
    Ok(())
}

fn file_name(path: &Path) -> Result<String, JsValue> {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(str::to_owned)
        .ok_or_else(|| JsValue::from_str(&format!("opfs: no file name in {path:?}")))
}

fn normal_components(path: &Path) -> impl Iterator<Item = String> + '_ {
    path.components().filter_map(|c| match c {
        Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
        _ => None,
    })
}

/// Creates (if needed) and returns the OPFS directory handle for memfs `path`.
async fn ensure_dirs(
    root: &FileSystemDirectoryHandle,
    path: &Path,
) -> Result<FileSystemDirectoryHandle, JsValue> {
    let create = FileSystemGetDirectoryOptions::new();
    create.set_create(true);
    let mut dir = root.clone();
    for part in normal_components(path) {
        dir = JsFuture::from(dir.get_directory_handle_with_options(&part, &create))
            .await?
            .into();
    }
    Ok(dir)
}

/// OPFS root → `memfs/` mirror directory handle. `window()` is unavailable in
/// a worker; go through the worker global scope instead.
async fn mirror_root() -> Result<FileSystemDirectoryHandle, JsValue> {
    let scope: WorkerGlobalScope = js_sys::global()
        .dyn_into()
        .map_err(|_| JsValue::from_str("opfs: not running in a worker"))?;
    let root: FileSystemDirectoryHandle =
        JsFuture::from(scope.navigator().storage().get_directory())
            .await?
            .into();
    let create = FileSystemGetDirectoryOptions::new();
    create.set_create(true);
    Ok(
        JsFuture::from(root.get_directory_handle_with_options(MIRROR_DIR, &create))
            .await?
            .into(),
    )
}

/// Loads the whole OPFS mirror into the memfs (files and empty dirs — core
/// checks blobdir existence on startup, so dirs matter).
async fn hydrate(root: &FileSystemDirectoryHandle) -> Result<(), JsValue> {
    let mut stack = vec![(root.clone(), PathBuf::from("/"))];
    while let Some((dir, path)) = stack.pop() {
        let iter = dir.entries();
        loop {
            let next: js_sys::IteratorNext = JsFuture::from(iter.next()?).await?.into();
            if next.done() {
                break;
            }
            let entry: js_sys::Array = next.value().into();
            let name = entry
                .get(0)
                .as_string()
                .ok_or_else(|| JsValue::from_str("opfs: entry without a name"))?;
            let handle = entry.get(1);
            let child = path.join(&name);
            let kind = js_sys::Reflect::get(&handle, &JsValue::from_str("kind"))?.as_string();
            if kind.as_deref() == Some("directory") {
                fs::insert_hydrated_dir(child.clone());
                stack.push((handle.into(), child));
            } else {
                let file: web_sys::File =
                    JsFuture::from(FileSystemFileHandle::from(handle).get_file())
                        .await?
                        .into();
                let buf = JsFuture::from(file.array_buffer()).await?;
                fs::insert_hydrated_file(child, Uint8Array::new(&buf).to_vec());
            }
        }
    }
    Ok(())
}

// --- sqlite VFS byte-level import/export (backup IMEX side channel) ---
//
// The patched core swaps whole database files as byte blobs (wasm sqlite has
// no sqlcipher_export). These helpers target whichever VFS currently is the
// sqlite default, so the core patch stays VFS-agnostic.

/// Replaces database `name` in the default sqlite VFS with `bytes`,
/// removing stale wal/journal leftovers first. All connections to `name`
/// must be closed.
pub fn sqlite_vfs_import(name: &str, bytes: &[u8]) -> Result<(), String> {
    SAHPOOL.with(|c| match c.borrow().as_ref() {
        Some(util) => {
            let _ = util.delete_db(name); // overwrite: core pre-creates dc.db on account open
            let _ = util.delete_db(&format!("{name}-wal"));
            let _ = util.delete_db(&format!("{name}-journal"));
            util.import_db(name, bytes).map_err(|e| e.to_string())
        }
        None => {
            let vfs = sqlite_wasm_rs::MemVfsUtil::<sqlite_wasm_rs::WasmOsCallback>::new();
            vfs.delete_db(name);
            vfs.delete_db(&format!("{name}-wal"));
            vfs.delete_db(&format!("{name}-journal"));
            vfs.import_db(name, bytes).map_err(|e| e.to_string())
        }
    })
}

/// Exports database `name` from the default sqlite VFS and deletes it there.
pub fn sqlite_vfs_take(name: &str) -> Result<Vec<u8>, String> {
    SAHPOOL.with(|c| match c.borrow().as_ref() {
        Some(util) => {
            let bytes = util.export_db(name).map_err(|e| e.to_string())?;
            let _ = util.delete_db(name);
            Ok(bytes)
        }
        None => {
            let vfs = sqlite_wasm_rs::MemVfsUtil::<sqlite_wasm_rs::WasmOsCallback>::new();
            let bytes = vfs.export_db(name).map_err(|e| e.to_string())?;
            vfs.delete_db(name);
            Ok(bytes)
        }
    })
}
