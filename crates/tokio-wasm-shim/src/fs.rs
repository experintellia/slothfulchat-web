//! In-memory filesystem mirroring the subset of `tokio::fs` chatmail core uses.
//!
//! M5: optionally persistent — [`crate::opfs::enable_persistence`] hydrates
//! the tree from OPFS at startup and every mutation below calls
//! `opfs::mark_dirty` to queue an asynchronous write-through.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::{self, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::pin::Pin;
use std::sync::Mutex;
use std::task::{Context, Poll};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::io::{AsyncRead, AsyncSeek, AsyncWrite, ReadBuf};

#[derive(Clone)]
enum Node {
    File { data: Vec<u8>, modified: SystemTime },
    Dir,
}

static FS: Mutex<BTreeMap<PathBuf, Node>> = Mutex::new(BTreeMap::new());

use crate::opfs::{mark_dirty, purge_pool_files_under};
// re-exported here so the core can reach persistence entry points via `tokio::fs::*`
pub use crate::opfs::{enable_persistence, flush_pending, sqlite_vfs_import, sqlite_vfs_take};

/// Point-in-time state of one memfs path, for the OPFS write-through.
pub(crate) enum Snapshot {
    File(Vec<u8>),
    Dir,
    Missing,
}

pub(crate) fn snapshot(path: &Path) -> Snapshot {
    match FS.lock().unwrap().get(&normalize(path)) {
        Some(Node::File { data, .. }) => Snapshot::File(data.clone()),
        Some(Node::Dir) => Snapshot::Dir,
        None => Snapshot::Missing,
    }
}

/// Inserts a file loaded from OPFS (with its parent dirs) WITHOUT marking it
/// dirty — hydration must not echo back into the write-through queue.
pub(crate) fn insert_hydrated_file(path: PathBuf, data: Vec<u8>) {
    let path = normalize(&path);
    let mut fs = FS.lock().unwrap();
    let mut parent = path.clone();
    while parent.pop() && parent != Path::new("/") {
        fs.entry(parent.clone()).or_insert(Node::Dir);
    }
    fs.insert(
        path,
        Node::File {
            data,
            modified: now(),
        },
    );
}

/// Dir twin of [`insert_hydrated_file`].
pub(crate) fn insert_hydrated_dir(path: PathBuf) {
    FS.lock().unwrap().insert(normalize(&path), Node::Dir);
}

/// `SystemTime::now()` panics on wasm32-unknown-unknown; epoch + JS clock doesn't.
fn now() -> SystemTime {
    UNIX_EPOCH + Duration::from_millis(js_sys::Date::now() as u64)
}

fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::from("/");
    for component in path.components() {
        match component {
            Component::RootDir | Component::Prefix(_) | Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(part) => out.push(part),
        }
    }
    out
}

fn not_found() -> io::Error {
    io::Error::new(io::ErrorKind::NotFound, "memfs: no such file or directory")
}

fn is_dir_err() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, "memfs: is a directory")
}

pub async fn read(path: impl AsRef<Path>) -> io::Result<Vec<u8>> {
    sync_read(path)
}

/// Synchronous read: `std::fs` is unsupported on wasm32-unknown-unknown,
/// core's sync (`block_in_place`) I/O paths call these `sync_*` variants instead.
pub fn sync_read(path: impl AsRef<Path>) -> io::Result<Vec<u8>> {
    match FS.lock().unwrap().get(&normalize(path.as_ref())) {
        Some(Node::File { data, .. }) => Ok(data.clone()),
        Some(Node::Dir) => Err(is_dir_err()),
        None => Err(not_found()),
    }
}

pub async fn read_to_string(path: impl AsRef<Path>) -> io::Result<String> {
    let bytes = read(path).await?;
    String::from_utf8(bytes).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

fn write_sync(path: &Path, contents: &[u8]) {
    let path = normalize(path);
    let mut fs = FS.lock().unwrap();
    // Auto-create parent directories: core calls create_dir_all before writes,
    // being permissive here just removes an error source.
    let mut parent = path.clone();
    while parent.pop() && parent != Path::new("/") {
        fs.entry(parent.clone()).or_insert(Node::Dir);
    }
    fs.insert(
        path.clone(),
        Node::File {
            data: contents.to_vec(),
            modified: now(),
        },
    );
    drop(fs);
    mark_dirty(&path);
}

pub async fn write(path: impl AsRef<Path>, contents: impl AsRef<[u8]>) -> io::Result<()> {
    sync_write(path, contents)
}

/// Synchronous write (see [`sync_read`]).
pub fn sync_write(path: impl AsRef<Path>, contents: impl AsRef<[u8]>) -> io::Result<()> {
    write_sync(path.as_ref(), contents.as_ref());
    Ok(())
}

pub async fn create_dir(path: impl AsRef<Path>) -> io::Result<()> {
    let path = normalize(path.as_ref());
    FS.lock().unwrap().insert(path.clone(), Node::Dir);
    mark_dirty(&path);
    Ok(())
}

pub async fn create_dir_all(path: impl AsRef<Path>) -> io::Result<()> {
    sync_create_dir_all(path)
}

/// Synchronous create_dir_all (see [`sync_read`]).
pub fn sync_create_dir_all(path: impl AsRef<Path>) -> io::Result<()> {
    let path = normalize(path.as_ref());
    let mut fs = FS.lock().unwrap();
    let mut current = PathBuf::from("/");
    for component in path.components().skip(1) {
        current.push(component);
        fs.entry(current.clone()).or_insert(Node::Dir);
    }
    drop(fs);
    mark_dirty(&path);
    Ok(())
}

/// Synchronous remove of a file or directory tree (see [`sync_read`]).
pub fn sync_remove(path: impl AsRef<Path>) -> io::Result<()> {
    let prefix = normalize(path.as_ref());
    let mut fs = FS.lock().unwrap();
    let keys: Vec<PathBuf> = fs
        .keys()
        .filter(|k| *k == &prefix || k.starts_with(&prefix))
        .cloned()
        .collect();
    if keys.is_empty() {
        return Err(not_found());
    }
    for key in keys {
        fs.remove(&key);
    }
    drop(fs);
    mark_dirty(&prefix);
    // Free the sahpool slots of any dbs that lived under this subtree — the
    // memfs removal above cannot, since sqlite files never touch the memfs.
    // (core's `remove_account` removes account dirs via a subtree path; see
    // opfs.rs::purge_pool_files_under.)
    purge_pool_files_under(&prefix);
    Ok(())
}

pub async fn remove_file(path: impl AsRef<Path>) -> io::Result<()> {
    let path = normalize(path.as_ref());
    // bind before matching: the scrutinee temporary would hold the FS lock
    // across mark_dirty, which re-locks for the accounts.toml write-through
    let removed = FS.lock().unwrap().remove(&path);
    match removed {
        Some(_) => {
            mark_dirty(&path);
            // Exact-path variant of the pool-slot reclaim (see sync_remove);
            // harmless completeness — core removes db dirs via the subtree paths.
            purge_pool_files_under(&path);
            Ok(())
        }
        None => Err(not_found()),
    }
}

pub async fn remove_dir(path: impl AsRef<Path>) -> io::Result<()> {
    remove_file(path).await
}

pub async fn remove_dir_all(path: impl AsRef<Path>) -> io::Result<()> {
    let prefix = normalize(path.as_ref());
    let mut fs = FS.lock().unwrap();
    let keys: Vec<PathBuf> = fs
        .keys()
        .filter(|k| *k == &prefix || k.starts_with(&prefix))
        .cloned()
        .collect();
    if keys.is_empty() {
        return Err(not_found());
    }
    for key in keys {
        fs.remove(&key);
    }
    drop(fs);
    mark_dirty(&prefix);
    // Free the sahpool slots of any dbs under this subtree — the memfs removal
    // cannot (sqlite files never touch the memfs). core's `remove_account`
    // removes the account dir through this path; see opfs.rs.
    purge_pool_files_under(&prefix);
    Ok(())
}

pub async fn rename(from: impl AsRef<Path>, to: impl AsRef<Path>) -> io::Result<()> {
    sync_rename(from, to)
}

/// Synchronous rename (see [`sync_read`]).
///
/// Note: this does NOT touch sahpool pool files, which are keyed by their
/// original logical path — a memfs rename would not move them. Core only
/// renames files (e.g. the write-tmp-then-rename of accounts.toml), never a
/// dir containing sqlite dbs, so renaming a db-bearing dir is unsupported here.
pub fn sync_rename(from: impl AsRef<Path>, to: impl AsRef<Path>) -> io::Result<()> {
    let from = normalize(from.as_ref());
    let to = normalize(to.as_ref());
    let mut fs = FS.lock().unwrap();
    let keys: Vec<PathBuf> = fs
        .keys()
        .filter(|k| *k == &from || k.starts_with(&from))
        .cloned()
        .collect();
    if keys.is_empty() {
        return Err(not_found());
    }
    let mut moved = Vec::new();
    for key in keys {
        let node = fs.remove(&key).unwrap();
        let suffix = key.strip_prefix(&from).unwrap();
        // `to.join("")` appends a trailing slash ("/accounts/accounts.toml/"),
        // and such a key never component-compares equal to the real path — it
        // slips past the accounts.toml write-through guard and the file rots
        // to 0 bytes in OPFS (issue #75). When `key` IS `from` (single-file
        // rename — core writes accounts.toml exactly this way, via
        // write-tmp-then-rename), the target is simply `to`.
        let target = if suffix.as_os_str().is_empty() {
            to.clone()
        } else {
            to.join(suffix)
        };
        fs.insert(target.clone(), node);
        moved.push(target);
    }
    drop(fs);
    mark_dirty(&from); // deletes the whole old subtree in OPFS
    for target in moved {
        mark_dirty(&target);
    }
    Ok(())
}

pub async fn copy(from: impl AsRef<Path>, to: impl AsRef<Path>) -> io::Result<u64> {
    sync_copy(from, to)
}

/// Synchronous copy (see [`sync_read`]).
pub fn sync_copy(from: impl AsRef<Path>, to: impl AsRef<Path>) -> io::Result<u64> {
    let data = sync_read(from)?;
    let len = data.len() as u64;
    sync_write(to, data)?;
    Ok(len)
}

pub async fn canonicalize(path: impl AsRef<Path>) -> io::Result<PathBuf> {
    let path = normalize(path.as_ref());
    if FS.lock().unwrap().contains_key(&path) {
        Ok(path)
    } else {
        Err(not_found())
    }
}

pub async fn try_exists(path: impl AsRef<Path>) -> io::Result<bool> {
    Ok(FS.lock().unwrap().contains_key(&normalize(path.as_ref())))
}

/// Synchronous existence check. `std::path::Path::exists()` always returns
/// false on wasm32-unknown-unknown (std::fs is unsupported), so callers use
/// this instead.
pub fn sync_exists(path: impl AsRef<Path>) -> bool {
    FS.lock().unwrap().contains_key(&normalize(path.as_ref()))
}

/// Synchronous directory check (see [`sync_exists`]).
pub fn sync_is_dir(path: impl AsRef<Path>) -> bool {
    matches!(
        FS.lock().unwrap().get(&normalize(path.as_ref())),
        Some(Node::Dir)
    )
}

/// Synchronous file check (see [`sync_exists`]).
pub fn sync_is_file(path: impl AsRef<Path>) -> bool {
    matches!(
        FS.lock().unwrap().get(&normalize(path.as_ref())),
        Some(Node::File { .. })
    )
}

/// Counts the immediate sub-directories of `path` in the memfs. The OPFS
/// boot-time capacity reserve uses it to size the sahpool to the live account
/// count (the dirs directly under `/accounts`); see `opfs::enable_persistence`.
pub(crate) fn count_child_dirs(path: impl AsRef<Path>) -> usize {
    let dir = normalize(path.as_ref());
    FS.lock()
        .unwrap()
        .iter()
        .filter(|(k, v)| k.parent() == Some(dir.as_path()) && matches!(v, Node::Dir))
        .count()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileType {
    is_dir: bool,
}

impl FileType {
    pub fn is_dir(&self) -> bool {
        self.is_dir
    }

    pub fn is_file(&self) -> bool {
        !self.is_dir
    }

    pub fn is_symlink(&self) -> bool {
        false
    }
}

#[derive(Clone, Debug)]
pub struct Metadata {
    len: u64,
    is_dir: bool,
    modified: SystemTime,
}

impl Metadata {
    pub fn len(&self) -> u64 {
        self.len
    }

    pub fn is_dir(&self) -> bool {
        self.is_dir
    }

    pub fn is_file(&self) -> bool {
        !self.is_dir
    }

    pub fn is_symlink(&self) -> bool {
        false
    }

    pub fn file_type(&self) -> FileType {
        FileType {
            is_dir: self.is_dir,
        }
    }

    pub fn modified(&self) -> io::Result<SystemTime> {
        Ok(self.modified)
    }

    pub fn created(&self) -> io::Result<SystemTime> {
        Ok(self.modified)
    }

    pub fn accessed(&self) -> io::Result<SystemTime> {
        Ok(self.modified)
    }
}

fn metadata_sync(path: &Path) -> io::Result<Metadata> {
    match FS.lock().unwrap().get(&normalize(path)) {
        Some(Node::File { data, modified }) => Ok(Metadata {
            len: data.len() as u64,
            is_dir: false,
            modified: *modified,
        }),
        Some(Node::Dir) => Ok(Metadata {
            len: 0,
            is_dir: true,
            modified: UNIX_EPOCH,
        }),
        None => Err(not_found()),
    }
}

pub async fn metadata(path: impl AsRef<Path>) -> io::Result<Metadata> {
    metadata_sync(path.as_ref())
}

/// ponytail: memfs has no symlinks, so this is plain `metadata`.
pub async fn symlink_metadata(path: impl AsRef<Path>) -> io::Result<Metadata> {
    metadata_sync(path.as_ref())
}

/// ponytail: memfs has no hard links; degrades to a byte copy.
pub async fn hard_link(src: impl AsRef<Path>, dst: impl AsRef<Path>) -> io::Result<()> {
    copy(src, dst).await.map(|_| ())
}

/// ponytail: memfs has no symlinks; always errors.
pub async fn read_link(_path: impl AsRef<Path>) -> io::Result<PathBuf> {
    Err(io::Error::new(
        io::ErrorKind::InvalidInput,
        "memfs: symlinks are not supported",
    ))
}

#[derive(Debug)]
pub struct DirEntry {
    path: PathBuf,
}

impl DirEntry {
    pub fn path(&self) -> PathBuf {
        self.path.clone()
    }

    pub fn file_name(&self) -> OsString {
        self.path
            .file_name()
            .map(|n| n.to_os_string())
            .unwrap_or_default()
    }

    pub async fn metadata(&self) -> io::Result<Metadata> {
        metadata_sync(&self.path)
    }

    pub async fn file_type(&self) -> io::Result<FileType> {
        Ok(metadata_sync(&self.path)?.file_type())
    }
}

pub struct ReadDir {
    entries: std::vec::IntoIter<PathBuf>,
}

impl ReadDir {
    pub async fn next_entry(&mut self) -> io::Result<Option<DirEntry>> {
        Ok(self.entries.next().map(|path| DirEntry { path }))
    }
}

/// Drop-in replacement for `tokio_stream::wrappers::ReadDirStream` call sites.
impl futures::Stream for ReadDir {
    type Item = io::Result<DirEntry>;

    fn poll_next(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        Poll::Ready(self.entries.next().map(|path| Ok(DirEntry { path })))
    }
}

pub async fn read_dir(path: impl AsRef<Path>) -> io::Result<ReadDir> {
    let dir = normalize(path.as_ref());
    let fs = FS.lock().unwrap();
    if !fs.contains_key(&dir) && dir != Path::new("/") {
        return Err(not_found());
    }
    let entries: Vec<PathBuf> = fs
        .keys()
        .filter(|k| k.parent() == Some(dir.as_path()))
        .cloned()
        .collect();
    Ok(ReadDir {
        entries: entries.into_iter(),
    })
}

#[derive(Clone, Debug, Default)]
pub struct OpenOptions {
    read: bool,
    write: bool,
    append: bool,
    truncate: bool,
    create: bool,
    create_new: bool,
}

impl OpenOptions {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn read(&mut self, read: bool) -> &mut Self {
        self.read = read;
        self
    }

    pub fn write(&mut self, write: bool) -> &mut Self {
        self.write = write;
        self
    }

    pub fn append(&mut self, append: bool) -> &mut Self {
        self.append = append;
        self.write = self.write || append;
        self
    }

    pub fn truncate(&mut self, truncate: bool) -> &mut Self {
        self.truncate = truncate;
        self
    }

    pub fn create(&mut self, create: bool) -> &mut Self {
        self.create = create;
        self
    }

    pub fn create_new(&mut self, create_new: bool) -> &mut Self {
        self.create_new = create_new;
        self
    }

    pub async fn open(&self, path: impl AsRef<Path>) -> io::Result<File> {
        let path = normalize(path.as_ref());
        // Directories open fine too: core opens parent dirs only to sync_all()
        // them, and sync is a no-op here.
        let exists = FS.lock().unwrap().contains_key(&path);
        if self.create_new && exists {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "memfs: file already exists",
            ));
        }
        if !exists {
            if self.create || self.create_new {
                write_sync(&path, &[]);
            } else {
                return Err(not_found());
            }
        } else if self.truncate {
            write_sync(&path, &[]);
        }
        let pos = if self.append {
            metadata_sync(&path)?.len()
        } else {
            0
        };
        Ok(File { path, pos })
    }
}

#[derive(Debug)]
pub struct File {
    path: PathBuf,
    pos: u64,
}

impl File {
    pub async fn open(path: impl AsRef<Path>) -> io::Result<File> {
        OpenOptions::new().read(true).open(path).await
    }

    pub async fn create(path: impl AsRef<Path>) -> io::Result<File> {
        OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(path)
            .await
    }

    pub async fn metadata(&self) -> io::Result<Metadata> {
        metadata_sync(&self.path)
    }

    pub async fn set_len(&self, size: u64) -> io::Result<()> {
        {
            let mut fs = FS.lock().unwrap();
            match fs.get_mut(&self.path) {
                Some(Node::File { data, modified }) => {
                    data.resize(size as usize, 0);
                    *modified = now();
                }
                _ => return Err(not_found()),
            }
        }
        mark_dirty(&self.path);
        Ok(())
    }

    pub async fn sync_all(&self) -> io::Result<()> {
        Ok(())
    }

    pub async fn sync_data(&self) -> io::Result<()> {
        Ok(())
    }
}

impl AsyncRead for File {
    fn poll_read(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let fs = FS.lock().unwrap();
        let data = match fs.get(&self.path) {
            Some(Node::File { data, .. }) => data,
            _ => return Poll::Ready(Err(not_found())),
        };
        let start = (self.pos as usize).min(data.len());
        let n = (data.len() - start).min(buf.remaining());
        buf.put_slice(&data[start..start + n]);
        drop(fs);
        self.pos += n as u64;
        Poll::Ready(Ok(()))
    }
}

impl AsyncWrite for File {
    fn poll_write(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let mut fs = FS.lock().unwrap();
        let (data, modified) = match fs.get_mut(&self.path) {
            Some(Node::File { data, modified }) => (data, modified),
            _ => return Poll::Ready(Err(not_found())),
        };
        let pos = self.pos as usize;
        if data.len() < pos {
            data.resize(pos, 0);
        }
        if pos + buf.len() > data.len() {
            data.resize(pos + buf.len(), 0);
        }
        data[pos..pos + buf.len()].copy_from_slice(buf);
        *modified = now();
        drop(fs);
        mark_dirty(&self.path);
        self.pos += buf.len() as u64;
        Poll::Ready(Ok(buf.len()))
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

impl AsyncSeek for File {
    fn start_seek(mut self: Pin<&mut Self>, position: SeekFrom) -> io::Result<()> {
        let len = metadata_sync(&self.path)?.len() as i64;
        let new_pos = match position {
            SeekFrom::Start(n) => n as i64,
            SeekFrom::End(n) => len + n,
            SeekFrom::Current(n) => self.pos as i64 + n,
        };
        if new_pos < 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "memfs: seek before start",
            ));
        }
        self.pos = new_pos as u64;
        Ok(())
    }

    fn poll_complete(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<u64>> {
        Poll::Ready(Ok(self.pos))
    }
}
