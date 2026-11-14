// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The on-disk store: one namespace directory per entry format, entries named
//! only by their key digest.
//!
//! ```text
//! <root>/result-v1/          0700
//!     <key hex>.ifcr         0600  complete entries, only ever renamed into place
//!     <key hex>.<pid>.<n>.tmp      a writer's file before its rename
//!     locks/<00..ff>.lock    0600  256 writer-lock stripes, by the key's first byte
//!     gc.lock                      held while evicting
//! ```
//!
//! Lock files are permanent: nothing ever unlinks or replaces one, so every
//! process that opens a stripe locks the same inode. (Per-key lock files that
//! eviction removed let a writer holding the old inode and a writer holding a
//! recreated one both "own" a key; PR #9614 review finding 3.) A stripe is
//! shared by the keys that start with the same byte, so a writer can skip
//! because an unrelated key in its stripe is being written; that costs one
//! publication, never correctness.
//!
//! Publication: take the key's stripe without waiting (a busy stripe usually
//! means another process is writing this result, so this one skips), recheck
//! for an identical entry, write a temp file, fsync it, rename it over the
//! entry path, fsync the directory. Readers open whole entries, so they see
//! the old file or the new one, never a prefix. A crash leaves a `.tmp` that
//! no reader opens; eviction removes it once its key lock is free.
//!
//! Policy (phase 1, chosen not measured): 10 GiB per directory, 1 GiB per
//! entry, refuse a write that would leave less than 1 GiB free. After each
//! publish, if the directory exceeds its budget, the least recently used
//! entries (mtime, refreshed on every read-write hit) are removed until it is
//! back under 90 %. The walk happens on publish, never on lookup.

use super::fs_private::{available_bytes, create_new, identity, open_lock, open_read, private_dir, sync_dir};
use super::PublishOutcome;
use std::fs::{self, File, FileTimes, TryLockError};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

pub(super) const NAMESPACE: &str = "result-v1";
const LOCKS: &str = "locks";
const ENTRY_EXT: &str = "ifcr";
const FREE_SPACE_HEADROOM: u64 = 1 << 30;
const ORPHAN_TEMP_AGE: Duration = Duration::from_secs(60);

/// `try_lock`, retried for up to ~10 ms. These locks belong to an open file
/// description, so a child process forked by ANY thread of this process holds
/// a copy of every lock this process had open at that instant until its exec
/// closes it (`O_CLOEXEC`). A store that spawns nothing still lives in hosts
/// (and test binaries) that do. A real writer holds a stripe for its whole
/// write, far longer than that window, so the retry only absorbs the fork
/// copy; a stripe still busy afterwards is reported as before.
fn try_lock_briefly(file: &File) -> Result<(), TryLockError> {
    let mut attempt = 0;
    loop {
        match file.try_lock() {
            Err(TryLockError::WouldBlock) if attempt < 20 => {
                attempt += 1;
                std::thread::sleep(Duration::from_micros(500));
            }
            other => return other,
        }
    }
}

pub(super) struct Store {
    dir: PathBuf,
    max_bytes: u64,
    max_entry_bytes: u64,
    min_free_bytes: u64,
}

pub(super) enum ReadError {
    Oversized(u64),
    Io(io::Error),
}

/// An entry as read, with the file generation it came from.
pub(super) struct ReadEntry {
    pub(super) bytes: Vec<u8>,
    file: File,
    generation: (u64, u64),
}

impl Store {
    /// The namespace directory under `root`, created (0700) when `create`.
    pub(super) fn open(root: &Path, create: bool, max_bytes: u64, max_entry_bytes: u64) -> io::Result<Self> {
        let dir = root.join(NAMESPACE);
        private_dir(&dir, create)?;
        // Read-only stores never lock; a writable one needs the stripe directory.
        if create {
            private_dir(&dir.join(LOCKS), true)?;
        }
        Ok(Self { dir, max_bytes, max_entry_bytes, min_free_bytes: FREE_SPACE_HEADROOM })
    }

    /// Free space a write must leave behind (default 1 GiB).
    pub(super) fn with_min_free(mut self, bytes: u64) -> Self {
        self.min_free_bytes = bytes;
        self
    }

    fn entry_path(&self, key: &str) -> PathBuf {
        self.dir.join(format!("{key}.{ENTRY_EXT}"))
    }

    /// The key's permanent lock stripe.
    pub(super) fn lock_path(&self, key: &str) -> PathBuf {
        let stripe = key.get(..2).filter(|s| s.bytes().all(|b| b.is_ascii_hexdigit())).unwrap_or("00");
        self.dir.join(LOCKS).join(format!("{stripe}.lock"))
    }

    /// `Ok(None)` when there is no entry for `key`.
    pub(super) fn read(&self, key: &str) -> Result<Option<ReadEntry>, ReadError> {
        let (file, meta) = match open_read(&self.entry_path(key)) {
            Ok(opened) => opened,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(ReadError::Io(e)),
        };
        let len = meta.len();
        if len > self.max_entry_bytes {
            return Err(ReadError::Oversized(len));
        }
        let capacity = usize::try_from(len).map_err(|_| ReadError::Oversized(len))?;
        let mut bytes = Vec::with_capacity(capacity);
        (&file).take(len + 1).read_to_end(&mut bytes).map_err(ReadError::Io)?;
        if bytes.len() as u64 != len {
            return Err(ReadError::Io(io::Error::other("entry changed size while it was read")));
        }
        Ok(Some(ReadEntry { bytes, generation: identity(&meta), file }))
    }

    /// Mark an entry used, for LRU eviction. Best effort.
    ///
    /// Always through the handle the entry was read and validated through, never
    /// a second open by path: on Unix the owner may set times on it, and on
    /// Windows it was opened with `FILE_WRITE_ATTRIBUTES` (`fs_private`).
    pub(super) fn touch(&self, entry: &ReadEntry) {
        let refreshed = entry.file.set_times(FileTimes::new().set_modified(SystemTime::now()));
        if let Err(error) = refreshed {
            tracing::debug!(%error, "result cache: could not refresh entry mtime");
        }
    }

    /// Remove the entry for `key` only if it is still the generation `seen`
    /// was read from, so a corrupt entry's removal can never take a
    /// concurrent writer's fresh replacement with it.
    pub(super) fn remove_if_same(&self, key: &str, seen: &ReadEntry) {
        let Ok(lock) = open_lock(&self.lock_path(key)) else { return };
        if try_lock_briefly(&lock).is_err() {
            return;
        }
        let path = self.entry_path(key);
        if let Ok((_, meta)) = open_read(&path) {
            if identity(&meta) == seen.generation {
                if let Err(error) = fs::remove_file(&path) {
                    tracing::debug!(%error, "result cache: could not remove a corrupt entry");
                }
            }
        }
    }

    #[cfg(test)]
    pub(super) fn publish(&self, key: &str, bytes: &[u8]) -> PublishOutcome {
        self.publish_parts(key, &[bytes])
    }

    /// Publish an entry given as consecutive parts (header, then sections),
    /// so the encoder never builds a second, concatenated copy.
    pub(super) fn publish_parts(&self, key: &str, parts: &[&[u8]]) -> PublishOutcome {
        let len = parts.iter().map(|p| p.len() as u64).sum::<u64>();
        if len > self.max_entry_bytes || len > self.max_bytes {
            return PublishOutcome::SkippedOversized { bytes: len, limit: self.max_entry_bytes.min(self.max_bytes) };
        }
        if available_bytes(&self.dir).is_some_and(|free| free < len.saturating_add(self.min_free_bytes)) {
            return PublishOutcome::SkippedLowDiskSpace;
        }
        let lock = match open_lock(&self.lock_path(key)) {
            Ok(lock) => lock,
            Err(e) => return PublishOutcome::Failed(format!("lock: {e}")),
        };
        match try_lock_briefly(&lock) {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => return PublishOutcome::SkippedConcurrentWriter,
            Err(TryLockError::Error(e)) => return PublishOutcome::Failed(format!("lock: {e}")),
        }
        if self.same_entry_present(key, len, parts.first().copied().unwrap_or_default()) {
            return PublishOutcome::AlreadyPresent;
        }
        let outcome = match self.write_and_rename(key, parts) {
            Ok(()) => PublishOutcome::Published { bytes: len },
            Err(e) => PublishOutcome::Failed(e.to_string()),
        };
        drop(lock);
        if matches!(outcome, PublishOutcome::Published { .. }) {
            self.evict(key);
        }
        outcome
    }

    /// An entry already holds exactly these bytes' header: the same key,
    /// identity, lengths and directory checksums.
    fn same_entry_present(&self, key: &str, len: u64, first: &[u8]) -> bool {
        let header_len = super::envelope::HEADER_LEN.min(first.len());
        let Ok((file, meta)) = open_read(&self.entry_path(key)) else { return false };
        let mut head = vec![0u8; header_len];
        meta.len() == len && (&file).read_exact(&mut head).is_ok() && head == first[..header_len]
    }

    fn write_and_rename(&self, key: &str, parts: &[&[u8]]) -> io::Result<()> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let temp = self.dir.join(format!("{key}.{}.{}.tmp", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        let written = create_new(&temp).and_then(|mut file| {
            for part in parts {
                file.write_all(part)?;
            }
            file.sync_all()
        });
        let renamed = written.and_then(|()| fs::rename(&temp, self.entry_path(key)));
        if renamed.is_err() {
            let _ = fs::remove_file(&temp);
        }
        renamed?;
        sync_dir(&self.dir);
        Ok(())
    }

    /// Remove orphaned temp files and, over budget, least recently used
    /// entries (never `keep`). Skipped while another process evicts.
    fn evict(&self, keep: &str) {
        let Ok(gc) = open_lock(&self.dir.join("gc.lock")) else { return };
        if try_lock_briefly(&gc).is_err() {
            return;
        }
        let Ok(listing) = fs::read_dir(&self.dir) else { return };
        let mut entries = Vec::new();
        let mut total = 0u64;
        for item in listing.flatten() {
            let name = item.file_name().to_string_lossy().into_owned();
            let Ok(meta) = item.metadata() else { continue };
            let stem = name.split('.').next().unwrap_or_default().to_string();
            if !meta.is_file() || stem.len() != 64 || !stem.bytes().all(|b| b.is_ascii_hexdigit()) {
                continue;
            }
            let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            if name.ends_with(".tmp") {
                let stale = modified.elapsed().is_ok_and(|age| age > ORPHAN_TEMP_AGE);
                // Hold the stripe while removing: no writer of this key can be
                // between creating and renaming its temp file meanwhile.
                let held = stale.then(|| self.hold_stripe(&stem)).flatten();
                if held.is_some() {
                    let _ = fs::remove_file(item.path());
                }
            } else if name.ends_with(ENTRY_EXT) {
                total = total.saturating_add(meta.len());
                entries.push((modified, meta.len(), stem));
            }
        }
        if total <= self.max_bytes {
            return;
        }
        entries.sort();
        let target = self.max_bytes / 10 * 9;
        for (_, len, stem) in entries {
            if total <= target {
                break;
            }
            if stem == keep {
                continue;
            }
            let Some(_stripe) = self.hold_stripe(&stem) else { continue };
            if fs::remove_file(self.entry_path(&stem)).is_ok() {
                total = total.saturating_sub(len);
            }
        }
    }

    /// `key`'s stripe, locked, if no writer holds it; unlocked on drop.
    fn hold_stripe(&self, key: &str) -> Option<File> {
        let lock = open_lock(&self.lock_path(key)).ok()?;
        try_lock_briefly(&lock).is_ok().then_some(lock)
    }

    #[cfg(test)]
    pub(super) fn dir(&self) -> &Path {
        &self.dir
    }
}
