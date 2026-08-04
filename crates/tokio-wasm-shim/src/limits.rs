//! Allocation bound for the memfs, kept pure so it compiles (and is
//! unit-tested) on every target — see [`crate::registry`] for the same trick.

use std::io;

/// Largest single file the memfs will hold.
///
/// Every memfs file is a `Vec<u8>` in wasm linear memory — a 4 GiB address
/// space that also has to fit the sqlite pool, core itself, and the *clone*
/// `fs::snapshot` makes of each file for the OPFS write-through (so a file
/// costs ~2x its length at peak). Lengths reaching the allocation sites are
/// untrusted: a backup's tar header declares entry sizes as a `u64`, and a
/// tiny crafted or corrupt archive can declare a near-4 GiB sparse file, whose
/// `Vec::resize` aborts the whole worker instead of failing the import.
///
/// 1 GiB is far above anything legitimate — the largest budget the app itself
/// commits to is the 300 MiB chat-export media budget, and a backup bigger
/// than that cannot be imported anyway (the browser materializes the whole
/// selected file before staging it, see `runtime.ts`'s `MAX_STAGED_FILE_BYTES`).
pub const MAX_FILE_LEN: u64 = 1 << 30;

/// Converts an untrusted file length into an allocation size, refusing
/// anything above [`MAX_FILE_LEN`] (and anything that would not fit a 32-bit
/// `usize` at all) with an `io::Error` the caller can propagate.
pub fn checked_len(size: u64) -> io::Result<usize> {
    match usize::try_from(size) {
        Ok(len) if size <= MAX_FILE_LEN => Ok(len),
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "memfs: file length exceeds the 1 GiB limit",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oversized_lengths_error_instead_of_allocating() {
        assert_eq!(checked_len(0).unwrap(), 0);
        assert_eq!(checked_len(MAX_FILE_LEN).unwrap(), MAX_FILE_LEN as usize);
        // what M-04 describes: a tiny archive declaring a huge sparse entry
        assert!(checked_len(MAX_FILE_LEN + 1).is_err());
        assert!(checked_len(u32::MAX as u64).is_err());
        assert!(checked_len(u64::MAX).is_err());
    }
}
