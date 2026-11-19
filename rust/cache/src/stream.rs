// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The streaming writer, [`build_cache_to_path`](crate::build_cache_to_path)
//! (#9584 slice 3).
//!
//! The pipeline runs with `retain_meshes` off, in job chunks, and each
//! emitted mesh goes straight into the same [`SectionWriter`] the in-memory
//! writer uses. A chunk is final the moment the byte cap or the end closes
//! it, and its place in the file is the order it closed in, so it is appended
//! to a spool file at once. What stays in memory is the open chunks (at most
//! one per grid cell, each under the 8 MiB soft cap plus one mesh), the
//! 44-byte directory entries, the scalar sections and one job chunk of
//! meshes. When the pass ends, every byte before the first chunk record is
//! known; it goes into a temporary file, the spool is copied after it, and
//! the file is synced and renamed over the output.
//!
//! Both staging files live in the output's directory, so the rename is
//! atomic and the spool needs no space elsewhere. [`Staging`] removes them on
//! every error path, including a panic that unwinds. A process that is killed
//! or aborts (the release profile is `panic = "abort"`) runs no destructor and
//! leaves `.<output name>.<pid>.<n>.tmp` and `.spool` behind; a later build
//! skips a taken name rather than failing on it.

use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, BufWriter, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::build::{self, Geometry, Scalars};
use crate::format::Limits;
use crate::geometry::{ChunkBody, SectionWriter};
use crate::{pipeline, CacheError, CacheOptions, CacheStats};

/// Jobs per pipeline chunk. Each chunk's meshes are in memory together
/// while they are converted; larger chunks give the parallel mesher more to
/// share out. The output does not depend on it.
pub(crate) const BATCH_JOBS: usize = 1024;

const IO_BUFFER: usize = 1 << 20;

/// Staging names tried before giving up. Each taken one is a leftover or a
/// concurrent build, so this many taken names means something else is wrong.
const STAGING_ATTEMPTS: u32 = 1024;

fn io_error(context: impl Into<String>) -> impl FnOnce(io::Error) -> CacheError {
    let context = context.into();
    move |source| CacheError::Io { context, source }
}

/// The temporary output and the spool, removed on drop unless committed (the
/// spool always). Only files THIS invocation created are removed: if a name
/// is already taken (`create_new` fails), the existing file belongs to
/// someone else and is left alone.
struct Staging {
    temp: PathBuf,
    spool: PathBuf,
    temp_owned: bool,
    spool_owned: bool,
    committed: bool,
}

impl Staging {
    /// Name both files beside `output` and create them. A taken name,
    /// typically one a killed build left behind (with a fixed PID, as in a
    /// container, every retry would pick the same names), moves on to the
    /// next sequence number rather than failing or touching that file.
    fn create(output: &Path) -> Result<(Self, File), CacheError> {
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let Some(name) = output.file_name().map(OsStr::to_string_lossy) else {
            let error = io::Error::new(io::ErrorKind::InvalidInput, "not a file path");
            return Err(io_error(format!("output {}", output.display()))(error));
        };
        let pid = std::process::id();
        Self::create_unused(parent_dir(output), &name, || format!("{pid}.{}", SEQUENCE.fetch_add(1, Ordering::Relaxed)))
    }

    /// [`Staging::create_named`] with each `next_unique` in turn until both
    /// names are free, at most [`STAGING_ATTEMPTS`] times.
    fn create_unused(dir: &Path, name: &str, mut next_unique: impl FnMut() -> String) -> Result<(Self, File), CacheError> {
        let mut attempt = 1;
        loop {
            match Self::create_named(dir, name, &next_unique()) {
                Err(CacheError::Io { source, .. })
                    if source.kind() == io::ErrorKind::AlreadyExists && attempt < STAGING_ATTEMPTS =>
                {
                    attempt += 1;
                }
                result => return result,
            }
        }
    }

    /// Create the spool and reserve the temporary file under exactly these
    /// names. A taken name is an error, and the file is left alone.
    fn create_named(dir: &Path, name: &str, unique: &str) -> Result<(Self, File), CacheError> {
        let mut staging = Self {
            temp: dir.join(format!(".{name}.{unique}.tmp")),
            spool: dir.join(format!(".{name}.{unique}.spool")),
            temp_owned: false,
            spool_owned: false,
            committed: false,
        };
        let spool = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&staging.spool)
            .map_err(io_error(format!("create spool {}", staging.spool.display())))?;
        staging.spool_owned = true;
        // Reserved now, so a taken temporary name is found before the build
        // rather than after it. On failure `drop` removes the spool.
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staging.temp)
            .map_err(io_error(format!("create {}", staging.temp.display())))?;
        staging.temp_owned = true;
        Ok((staging, spool))
    }

    /// Write `prefix` then the spooled body into the temporary file, sync it,
    /// and rename it over `output`.
    fn commit(&mut self, prefix: &[u8], spool: Spool, body_length: u64, output: &Path) -> Result<(), CacheError> {
        let temp_context = || format!("write {}", self.temp.display());
        let mut spool = spool.file.into_inner().map_err(|error| io_error("flush spool")(error.into_error()))?;
        spool.seek(SeekFrom::Start(0)).map_err(io_error("rewind spool"))?;
        // The file `create_named` reserved, still empty.
        let mut temp = OpenOptions::new().write(true).truncate(true).open(&self.temp).map_err(io_error(temp_context()))?;
        temp.write_all(prefix).map_err(io_error(temp_context()))?;
        let copied = io::copy(&mut BufReader::with_capacity(IO_BUFFER, spool), &mut temp)
            .map_err(io_error(temp_context()))?;
        if copied != body_length {
            let short = io::Error::new(io::ErrorKind::UnexpectedEof, format!("spool holds {copied} of {body_length} bytes"));
            return Err(io_error("copy spool")(short));
        }
        temp.sync_all().map_err(io_error(temp_context()))?;
        drop(temp);
        fs::rename(&self.temp, output)
            .map_err(io_error(format!("rename {} to {}", self.temp.display(), output.display())))?;
        self.committed = true;
        sync_parent(output)
    }
}

impl Drop for Staging {
    fn drop(&mut self) {
        let mut doomed = Vec::new();
        if self.spool_owned {
            doomed.push(&self.spool);
        }
        if self.temp_owned && !self.committed {
            doomed.push(&self.temp);
        }
        for path in doomed {
            match fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                // Nothing to return to from a drop; say what was left behind.
                Err(error) => eprintln!("ifc-lite-cache: could not remove {}: {error}", path.display()),
            }
        }
    }
}

fn parent_dir(output: &Path) -> &Path {
    match output.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => dir,
        _ => Path::new("."),
    }
}

/// Make the rename itself durable: sync the directory entry (POSIX only;
/// elsewhere the rename is as durable as the platform makes it).
fn sync_parent(output: &Path) -> Result<(), CacheError> {
    #[cfg(unix)]
    {
        let dir = parent_dir(output);
        File::open(dir)
            .and_then(|dir| dir.sync_all())
            .map_err(io_error(format!("sync {}", dir.display())))?;
    }
    #[cfg(not(unix))]
    let _ = output;
    Ok(())
}

/// The spool as a chunk body: closed chunk records, appended in order.
struct Spool {
    file: BufWriter<File>,
}

impl ChunkBody for Spool {
    fn append(&mut self, bytes: &[u8]) -> Result<(), CacheError> {
        self.file.write_all(bytes).map_err(io_error("append to spool"))
    }
}

pub(crate) fn build_to_path(
    source: &[u8],
    output: &Path,
    options: &CacheOptions,
    limits: Limits,
    batch_jobs: usize,
) -> Result<CacheStats, CacheError> {
    // Declared before the spool, so the spool's handle is closed before the
    // staging files are removed (Windows refuses to remove an open file).
    let (mut staging, spool_file) = Staging::create(output)?;
    let mut spool = Spool { file: BufWriter::with_capacity(IO_BUFFER, spool_file) };
    // The data model first, so the geometry's early u32 refusal counts from
    // the section's real offset. (Running the geometry pass first does not
    // lower the peak: #9584's measurement read it slightly higher.)
    let scalars = Scalars::extract(source, options)?;
    let geometry = if options.include_geometry {
        let mut writer = SectionWriter::new(options.compress_geometry_chunks, scalars.geometry_start(), limits);
        let pass = pipeline::run_streaming(source, batch_jobs, |mesh| writer.push(&mesh, &mut spool))?;
        let head = writer.finish(pass.coordinate_info, &mut spool)?;
        Some(Geometry { head, schema: pass.schema })
    } else {
        None
    };
    let body_length = geometry.as_ref().map_or(0, |g| g.head.body_length);
    let (prefix, stats) = build::prefix(source, options, scalars, geometry, limits)?;
    staging.commit(&prefix, spool, body_length, output)?;
    Ok(stats)
}

#[cfg(test)]
#[path = "stream_tests.rs"]
mod tests;
