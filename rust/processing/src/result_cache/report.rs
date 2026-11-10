// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! What a [`ResultCache::process`](super::ResultCache::process) call did.
//!
//! The work counters are the CURRENT call's cost (hash, read, validate,
//! decode, or the live pass and publication). A replayed result's
//! `ProcessingStats` durations are the producer's, kept verbatim; they are not
//! this call's work.

use std::time::Duration;

/// How the result was obtained.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum CacheOutcome {
    /// The cache was off: the pipeline ran, nothing was hashed or read.
    Off,
    /// This request cannot be replayed (or the cache is unusable); the
    /// pipeline ran and nothing was stored.
    Bypass(BypassReason),
    /// A stored result was replayed; the pipeline did not run.
    Hit,
    /// No usable entry; the pipeline ran (and, read-write, published).
    Miss(MissReason),
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum BypassReason {
    /// A cancellable pass may return a partial result.
    CancellationArmed,
    /// An injected entity index is not verified against the bytes.
    InjectedEntityIndex,
    /// `retain_meshes == false`: nothing worth replaying.
    MeshesNotRetained,
    /// The cache directory could not be opened or is not private.
    Unavailable(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum MissReason {
    /// No entry for this key.
    Absent,
    /// An entry failed validation or decoding.
    Corrupt(String),
    /// An entry written in another format version.
    Unsupported(u32),
    /// An entry under this key describes a different source, request or engine.
    IdentityMismatch,
    /// An entry over the per-entry limit; not read.
    Oversized { bytes: u64, limit: u64 },
    /// The entry could not be opened or read (permissions, symlink, I/O).
    ReadFailed(String),
}

/// What happened to the live result afterwards.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
#[non_exhaustive]
pub enum PublishOutcome {
    /// Read-only, off, bypassed or a hit.
    #[default]
    NotAttempted,
    Published { bytes: u64 },
    /// An identical entry was already stored.
    AlreadyPresent,
    SkippedOversized { bytes: u64, limit: u64 },
    /// Another process holds this key's writer lock and is storing it.
    SkippedConcurrentWriter,
    /// Less than the write plus 1 GiB of headroom is free.
    SkippedLowDiskSpace,
    /// The result breaks a structural invariant the decoder enforces.
    Unencodable(String),
    Failed(String),
}

/// The current call's work. Durations are wall time on this machine; byte
/// counts are exact.
#[derive(Debug, Clone, Default)]
pub struct CacheWork {
    /// Source bytes hashed for the key (0 when off or bypassed).
    pub bytes_hashed: u64,
    pub hash: Duration,
    /// Entry bytes read from disk.
    pub entry_bytes_read: u64,
    pub read: Duration,
    /// Header, directory and every section checksum.
    pub validate: Duration,
    /// Section payload bytes decoded into the result (hits only).
    pub bytes_decoded: u64,
    pub decode: Duration,
    /// The live pipeline (misses, bypasses, off).
    pub process: Duration,
    pub encode: Duration,
    pub write: Duration,
    pub entry_bytes_written: u64,
}

#[derive(Debug, Clone)]
pub struct CacheReport {
    pub outcome: CacheOutcome,
    pub publish: PublishOutcome,
    pub work: CacheWork,
    /// Hex cache key, once one was computed.
    pub key: Option<String>,
    /// Bounded warnings (also sent to `tracing`).
    pub warnings: Vec<String>,
}

const MAX_WARNINGS: usize = 8;

impl CacheReport {
    pub(super) fn new(outcome: CacheOutcome) -> Self {
        Self { outcome, publish: PublishOutcome::NotAttempted, work: CacheWork::default(), key: None, warnings: Vec::new() }
    }

    pub(super) fn warn(&mut self, message: String) {
        tracing::warn!(target: "ifc_lite_processing::result_cache", "{message}");
        if self.warnings.len() < MAX_WARNINGS {
            self.warnings.push(message);
        }
    }

    /// Short stable label for logs and probes.
    pub fn outcome_label(&self) -> &'static str {
        match self.outcome {
            CacheOutcome::Off => "off",
            CacheOutcome::Bypass(_) => "bypass",
            CacheOutcome::Hit => "hit",
            CacheOutcome::Miss(_) => "miss",
        }
    }
}
