// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Private-file primitives for the result-cache store.
//!
//! On Unix: directories are created 0700 and files 0600, every open passes
//! `O_NOFOLLOW` (a symlink at an entry path fails the open instead of being
//! followed), and an opened entry or directory is trusted only when the
//! current effective user owns it and no group/other bit can write it. Other
//! platforms rely on the per-user cache location and refuse symlinks with a
//! metadata check before the open, which is weaker (a race can still swap
//! the path); phase 1 states that rather than claiming parity.

use std::fs::{DirBuilder, File, Metadata, OpenOptions};
use std::io;
use std::path::Path;

#[cfg(unix)]
mod imp {
    use super::*;
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};

    pub(crate) fn options(base: &mut OpenOptions, mode: u32) -> &mut OpenOptions {
        base.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).mode(mode)
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

fn refuse_symlink(path: &Path) -> io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() => Err(io::Error::other("refusing a symlink")),
        _ => Ok(()),
    }
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
    refuse_symlink(path)?;
    let file = imp::options(OpenOptions::new().read(true), 0).open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Err(io::Error::other("entry is not a regular file"));
    }
    imp::private(&meta, 0o022).map_err(io::Error::other)?;
    Ok((file, meta))
}

/// Create a file that must not exist yet (0600).
pub(super) fn create_new(path: &Path) -> io::Result<File> {
    imp::options(OpenOptions::new().write(true).create_new(true), 0o600).open(path)
}

/// Open or create a per-key lock file (0600).
pub(super) fn open_lock(path: &Path) -> io::Result<File> {
    refuse_symlink(path)?;
    let file = imp::options(OpenOptions::new().read(true).write(true).create(true).truncate(false), 0o600).open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Err(io::Error::other("lock is not a regular file"));
    }
    imp::private(&meta, 0o022).map_err(io::Error::other)?;
    Ok(file)
}

/// Flush a directory's entries (the rename) to disk; best effort.
pub(super) fn sync_dir(dir: &Path) {
    #[cfg(unix)]
    if let Ok(d) = File::open(dir) {
        if let Err(error) = d.sync_all() {
            tracing::debug!(%error, "result cache: directory fsync failed");
        }
    }
    #[cfg(not(unix))]
    let _ = dir;
}
