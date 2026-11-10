// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The on-disk store: one namespace directory per entry format, entries named
//! only by their key digest.
//!
//! ```text
//! <root>/result-v1/          0700
//!     <key hex>.ifcr         0600  complete entries, only ever renamed into place
//!     <key hex>.lock         0600  per-key writer lock (advisory, cross-process)
//!     <key hex>.<pid>.<n>.tmp      a writer's file before its rename
//!     gc.lock                      held while evicting
//! ```
//!
//! Publication: take the key's lock without waiting (a busy lock means another
//! process is already writing the same result, so this one skips), recheck
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
const ENTRY_EXT: &str = "ifcr";
const FREE_SPACE_HEADROOM: u64 = 1 << 30;
const ORPHAN_TEMP_AGE: Duration = Duration::from_secs(60);

pub(super) struct Store {
    dir: PathBuf,
    max_bytes: u64,
    max_entry_bytes: u64,
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
        Ok(Self { dir, max_bytes, max_entry_bytes })
    }

    fn entry_path(&self, key: &str) -> PathBuf {
        self.dir.join(format!("{key}.{ENTRY_EXT}"))
    }

    fn lock_path(&self, key: &str) -> PathBuf {
        self.dir.join(format!("{key}.lock"))
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
        let mut bytes = Vec::with_capacity(len as usize);
        (&file).take(len + 1).read_to_end(&mut bytes).map_err(ReadError::Io)?;
        if bytes.len() as u64 != len {
            return Err(ReadError::Io(io::Error::other("entry changed size while it was read")));
        }
        Ok(Some(ReadEntry { bytes, generation: identity(&meta), file }))
    }

    /// Mark an entry used, for LRU eviction. Best effort.
    pub(super) fn touch(&self, entry: &ReadEntry) {
        if let Err(error) = entry.file.set_times(FileTimes::new().set_modified(SystemTime::now())) {
            tracing::debug!(%error, "result cache: could not refresh entry mtime");
        }
    }

    /// Remove the entry for `key` only if it is still the generation `seen`
    /// was read from, so a corrupt entry's removal can never take a
    /// concurrent writer's fresh replacement with it.
    pub(super) fn remove_if_same(&self, key: &str, seen: &ReadEntry) {
        let Ok(lock) = open_lock(&self.lock_path(key)) else { return };
        if lock.try_lock().is_err() {
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

    pub(super) fn publish(&self, key: &str, bytes: &[u8]) -> PublishOutcome {
        let len = bytes.len() as u64;
        if len > self.max_entry_bytes || len > self.max_bytes {
            return PublishOutcome::SkippedOversized { bytes: len, limit: self.max_entry_bytes.min(self.max_bytes) };
        }
        if available_bytes(&self.dir).is_some_and(|free| free < len.saturating_add(FREE_SPACE_HEADROOM)) {
            return PublishOutcome::SkippedLowDiskSpace;
        }
        let lock = match open_lock(&self.lock_path(key)) {
            Ok(lock) => lock,
            Err(e) => return PublishOutcome::Failed(format!("lock: {e}")),
        };
        match lock.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => return PublishOutcome::SkippedConcurrentWriter,
            Err(TryLockError::Error(e)) => return PublishOutcome::Failed(format!("lock: {e}")),
        }
        if self.same_entry_present(key, bytes) {
            return PublishOutcome::AlreadyPresent;
        }
        let outcome = match self.write_and_rename(key, bytes) {
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
    fn same_entry_present(&self, key: &str, bytes: &[u8]) -> bool {
        let header_len = super::envelope::HEADER_LEN.min(bytes.len());
        let Ok((file, meta)) = open_read(&self.entry_path(key)) else { return false };
        let mut head = vec![0u8; header_len];
        meta.len() == bytes.len() as u64 && (&file).read_exact(&mut head).is_ok() && head == bytes[..header_len]
    }

    fn write_and_rename(&self, key: &str, bytes: &[u8]) -> io::Result<()> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let temp = self.dir.join(format!("{key}.{}.{}.tmp", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        let written = create_new(&temp).and_then(|mut file| {
            file.write_all(bytes)?;
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
        if gc.try_lock().is_err() {
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
                if stale && self.key_is_idle(&stem) {
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
            let Ok(lock) = open_lock(&self.lock_path(&stem)) else { continue };
            if lock.try_lock().is_ok() && fs::remove_file(self.entry_path(&stem)).is_ok() {
                total = total.saturating_sub(len);
                let _ = fs::remove_file(self.lock_path(&stem));
            }
        }
    }

    /// No writer holds `key`'s lock right now.
    fn key_is_idle(&self, key: &str) -> bool {
        open_lock(&self.lock_path(key)).is_ok_and(|lock| lock.try_lock().is_ok())
    }

    #[cfg(test)]
    pub(super) fn dir(&self) -> &Path {
        &self.dir
    }
}
