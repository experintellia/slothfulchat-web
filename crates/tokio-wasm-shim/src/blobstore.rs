//! SQLite-backed files created by streamed imports. Keep their index in memfs
//! and read payloads through SQLite's incremental BLOB API.

use std::cell::RefCell;
use std::io;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, Transaction};

pub(crate) const DATABASE: &str = "/restored-attachments.db";

thread_local! {
    static STORE: RefCell<Option<Connection>> = const { RefCell::new(None) };
}

fn sql_error(error: rusqlite::Error) -> io::Error {
    io::Error::other(format!("encrypted attachment store: {error}"))
}

pub(crate) fn open(key: &str) -> io::Result<Vec<(PathBuf, StoredFile)>> {
    let db = Connection::open(DATABASE).map_err(sql_error)?;
    db.pragma_update(None, "key", key).map_err(sql_error)?;
    db.execute_batch(
        "PRAGMA temp_store=MEMORY;
         PRAGMA synchronous=FULL;
         PRAGMA secure_delete=ON;
         PRAGMA cache_size=-2048;
         CREATE TABLE IF NOT EXISTS files (
             id INTEGER PRIMARY KEY,
             path TEXT NOT NULL UNIQUE,
             data BLOB NOT NULL
         ) STRICT;
         DELETE FROM files WHERE path GLOB '/.storage-transfer/*';",
    )
    .map_err(sql_error)?;
    let files = {
        let mut statement = db.prepare("SELECT path, id, length(data) FROM files").map_err(sql_error)?;
        let rows = statement
            .query_map([], |row| Ok((PathBuf::from(row.get::<_, String>(0)?), StoredFile {
                id: row.get(1)?,
                len: row.get(2)?,
            })))
            .map_err(sql_error)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_error)?
    };
    STORE.with(|slot| *slot.borrow_mut() = Some(db));
    Ok(files)
}

pub(crate) fn is_open() -> bool {
    STORE.with(|slot| slot.borrow().is_some())
}

fn with_store<T>(operation: impl FnOnce(&mut Connection) -> rusqlite::Result<T>) -> io::Result<T> {
    STORE.with(|slot| {
        let mut slot = slot.borrow_mut();
        let db = slot.as_mut().ok_or_else(|| io::Error::other("attachment store is closed"))?;
        operation(db).map_err(sql_error)
    })
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct StoredFile {
    id: i64,
    pub len: usize,
}

pub(crate) fn insert(path: &Path, bytes: &[u8]) -> io::Result<StoredFile> {
    with_store(|db| {
        db.execute("INSERT INTO files(path, data) VALUES (?, ?)", (path.to_str(), bytes))?;
        Ok(StoredFile { id: db.last_insert_rowid(), len: bytes.len() })
    })
}

impl StoredFile {
    pub(crate) fn read(self, at: usize, dest: &mut [u8]) -> io::Result<usize> {
        if dest.is_empty() || at >= self.len {
            return Ok(0);
        }
        with_store(|db| db.blob_open("main", "files", "data", self.id, true)?.read_at(dest, at))
    }

    pub(crate) fn replace(&mut self, bytes: &[u8]) -> io::Result<()> {
        with_store(|db| self.replace_in(db, bytes))
    }

    pub(crate) fn replace_in(&mut self, db: &Connection, bytes: &[u8]) -> rusqlite::Result<()> {
        db.execute("UPDATE files SET data=? WHERE id=?", (bytes, self.id))?;
        self.len = bytes.len();
        Ok(())
    }

    pub(crate) fn resize(&mut self, end: usize) -> io::Result<()> {
        with_store(|db| resize(db, *self, end))?;
        self.len = end;
        Ok(())
    }

    pub(crate) fn write(&mut self, at: usize, bytes: &[u8]) -> io::Result<()> {
        let end = self.len.max(at + bytes.len());
        with_store(|db| {
            let tx = db.transaction()?;
            resize(&tx, *self, end)?;
            tx.blob_open("main", "files", "data", self.id, false)?.write_at(bytes, at)?;
            tx.commit()
        })?;
        self.len = end;
        Ok(())
    }
}

fn resize(db: &Connection, file: StoredFile, end: usize) -> rusqlite::Result<()> {
    if end > file.len {
        db.execute(
            "UPDATE files SET data=CAST(data || zeroblob(?) AS BLOB) WHERE id=?",
            (end - file.len, file.id),
        )?;
    } else if end < file.len {
        db.execute("UPDATE files SET data=substr(data,1,?) WHERE id=?", (end, file.id))?;
    }
    Ok(())
}

pub(crate) fn remove(files: impl Iterator<Item = StoredFile>) -> io::Result<()> {
    let mut files = files.peekable();
    if files.peek().is_none() {
        return Ok(());
    }
    change(|tx| {
        for file in files {
            delete(tx, file)?;
        }
        Ok(())
    })
}

pub(crate) fn change(operation: impl FnOnce(&Transaction<'_>) -> rusqlite::Result<()>) -> io::Result<()> {
    with_store(|db| {
        let tx = db.transaction()?;
        operation(&tx)?;
        tx.commit()
    })
}

pub(crate) fn delete(db: &Connection, file: StoredFile) -> rusqlite::Result<()> {
    db.execute("DELETE FROM files WHERE id=?", [file.id])?;
    Ok(())
}

pub(crate) fn rename(db: &Connection, file: StoredFile, to: &Path) -> rusqlite::Result<()> {
    db.execute("UPDATE files SET path=? WHERE id=?", (to.to_str(), file.id))?;
    Ok(())
}
