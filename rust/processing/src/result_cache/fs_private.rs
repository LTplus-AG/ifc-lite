// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Private-file primitives for the result-cache store.
//!
//! On Unix: directories are created 0700 and files 0600. A file is opened
//! only after `lstat` shows a regular file, with `O_NOFOLLOW | O_NONBLOCK`
//! (a symlink fails the open; a FIFO or device swapped in after the check
//! cannot block it), and the opened handle must still be that same regular
//! file (device and inode), owned by the effective user with no group/other
//! permission bit at all (0o077). Directories are checked by path (`lstat`:
//! a real directory, ours, no group/other bits); their ancestors are trusted
//! and followed. Other platforms check the file type by path before the open,
//! which a race can defeat, and skip the owner/mode checks; phase 1 states
//! that rather than claiming parity.

use std::fs::{DirBuilder, File, Metadata, OpenOptions};
use std::io;
use std::path::Path;

#[cfg(unix)]
mod imp {
    use super::*;
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};

    pub(crate) fn options(base: &mut OpenOptions, mode: u32) -> &mut OpenOptions {
        base.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK).mode(mode)
    }

    pub(crate) fn builder() -> DirBuilder {
        let mut b = DirBuilder::new();
        b.recursive(true).mode(0o700);
        b
    }

    fn euid() -> u32 {
        // SAFETY: geteuid takes no arguments, cannot fail and touches no memory.
        unsafe { libc::geteuid() }
    }

    /// Owned by us and not writable by anyone else.
    pub(crate) fn private(meta: &Metadata, group_other_mask: u32) -> Result<(), &'static str> {
        if meta.uid() != euid() {
            return Err("owned by another user");
        }
        if meta.mode() & group_other_mask != 0 {
            return Err("accessible to group or other users");
        }
        Ok(())
    }

    pub(crate) fn identity(meta: &Metadata) -> (u64, u64) {
        (meta.dev(), meta.ino())
    }

    // The statvfs field widths differ by platform (u32 on macOS, u64 on Linux).
    #[allow(clippy::unnecessary_cast)]
    pub(crate) fn available_bytes(dir: &Path) -> Option<u64> {
        use std::os::unix::ffi::OsStrExt;
        let path = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
        // SAFETY: `path` is a valid NUL-terminated string that outlives the
        // call; `stat` is a plain-old-data out parameter statvfs fills.
        let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
        let rc = unsafe { libc::statvfs(path.as_ptr(), &mut stat) };
        (rc == 0).then(|| (stat.f_bavail as u64).saturating_mul(stat.f_frsize as u64))
    }
}

#[cfg(not(unix))]
mod imp {
    use super::*;

    pub(crate) fn options(base: &mut OpenOptions, _mode: u32) -> &mut OpenOptions {
        base
    }
    pub(crate) fn builder() -> DirBuilder {
        let mut b = DirBuilder::new();
        b.recursive(true);
        b
    }
    pub(crate) fn private(_meta: &Metadata, _mask: u32) -> Result<(), &'static str> {
        Ok(())
    }
    pub(crate) fn identity(meta: &Metadata) -> (u64, u64) {
        let modified = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok());
        (meta.len(), modified.map_or(0, |d| d.as_nanos() as u64))
    }
    pub(crate) fn available_bytes(_dir: &Path) -> Option<u64> {
        None
    }
}

pub(super) use imp::{available_bytes, identity};

/// `lstat` says a regular file (`NotFound` passes through as itself).
fn regular_by_path(path: &Path) -> io::Result<Metadata> {
    let meta = std::fs::symlink_metadata(path)?;
    if meta.file_type().is_file() {
        Ok(meta)
    } else {
        Err(io::Error::other("not a regular file (symlink, directory, FIFO, socket or device)"))
    }
}

/// The opened handle is still the regular, private file `lstat` saw.
fn same_private_file(file: &File, seen: &Metadata) -> io::Result<Metadata> {
    let meta = file.metadata()?;
    if !meta.is_file() || identity(&meta) != identity(seen) {
        return Err(io::Error::other("path changed while it was opened"));
    }
    imp::private(&meta, 0o077).map_err(io::Error::other)?;
    Ok(meta)
}

/// Create `dir` (0700) if asked, then require a private real directory.
pub(super) fn private_dir(dir: &Path, create: bool) -> io::Result<()> {
    if create {
        imp::builder().create(dir)?;
    }
    let meta = std::fs::symlink_metadata(dir)?;
    if !meta.is_dir() {
        return Err(io::Error::other("cache path is not a directory (or is a symlink)"));
    }
    imp::private(&meta, 0o077).map_err(io::Error::other)
}

/// Open an existing entry read-only without following a symlink, and require
/// a private regular file.
pub(super) fn open_read(path: &Path) -> io::Result<(File, Metadata)> {
    // A writer may rename a new entry into place between the `lstat` and the
    // open; that is a newer complete entry, not tampering, so look again
    // (bounded) rather than report a spurious failure.
    for _ in 0..3 {
        let seen = regular_by_path(path)?;
        let file = imp::options(OpenOptions::new().read(true), 0).open(path)?;
        if identity(&file.metadata()?) != identity(&seen) {
            continue;
        }
        let meta = same_private_file(&file, &seen)?;
        return Ok((file, meta));
    }
    Err(io::Error::other("entry kept changing while it was opened"))
}

/// Create a file that must not exist yet (0600).
pub(super) fn create_new(path: &Path) -> io::Result<File> {
    imp::options(OpenOptions::new().write(true).create_new(true), 0o600).open(path)
}

/// Open or create a per-key lock file (0600).
pub(super) fn open_lock(path: &Path) -> io::Result<File> {
    match regular_by_path(path) {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    let file = imp::options(OpenOptions::new().read(true).write(true).create(true).truncate(false), 0o600).open(path)?;
    let seen = file.metadata()?;
    same_private_file(&file, &seen)?;
    Ok(file)
}

/// Flush a directory's entries (the rename) to disk; best effort. The temp
/// file is fsynced before its rename, so a crash can lose a new entry (a later
/// miss) but never leave a torn one under an entry name; a failed directory
/// fsync is logged, not reported, because the entry is already complete.
pub(super) fn sync_dir(dir: &Path) {
    #[cfg(unix)]
    if let Ok(d) = {
        use std::os::unix::fs::OpenOptionsExt;
        OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY | libc::O_CLOEXEC).open(dir)
    } {
        if let Err(error) = d.sync_all() {
            tracing::debug!(%error, "result cache: directory fsync failed");
        }
    }
    #[cfg(not(unix))]
    let _ = dir;
}
