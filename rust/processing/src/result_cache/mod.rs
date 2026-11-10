// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Native warm-load cache of complete processing results (phase 1).
//!
//! A [`ResultCache`] wraps [`process`](crate::process): on a full pass whose
//! source bytes, output-affecting request fields and engine identity match a
//! stored entry, it replays that entry's exact [`ProcessingResult`] (every
//! mesh, instance, frame, transform, metadata field, diagnostic and refusal
//! count, in order, float bits intact) instead of processing. Otherwise it
//! runs the unchanged pipeline and, in [`CacheMode::ReadWrite`], stores the
//! result. `process` itself stays pure: callers that never build a cache never
//! reach this module, and [`CacheMode::Off`] calls straight through without
//! hashing anything.
//!
//! What it does not do (phase 1): replay sink events (the cached entry point
//! takes no sink, so streaming and callback consumers keep calling `process`),
//! cache a cancellable pass, trust an injected entity index, or cache the
//! prepared-source tier (index/discovery). A request it cannot replay reports
//! [`CacheOutcome::Bypass`] and runs live; it never returns a hit with missing
//! outputs.
//!
//! Trust model: entries live in a per-user private directory (0700/0600,
//! owner-checked, `O_NOFOLLOW`, digest-only names, see `store.rs`). Every
//! entry is treated as untrusted input: bounded reads, checked arithmetic,
//! per-section SHA-256 verified before anything is decoded, and any failure is
//! a warning plus a miss and a recompute, never a panic or a partial result.
//! The checksums detect damage, not authorship: a process running as the same
//! user can write a self-consistent entry with wrong geometry, and this cache
//! cannot tell. Environments that need that guarantee need authenticated
//! entries or a separate trusted writer, which phase 1 does not provide.
//!
//! Keys, layout and store policy: `key.rs`, `envelope.rs`, `store.rs`.

mod envelope;
mod fs_private;
mod key;
mod mesh_codec;
mod meta_codec;
mod store;
mod wire;
mod report;
#[cfg(test)]
#[path = "codec_tests.rs"]
mod codec_tests;
#[cfg(test)]
#[path = "store_tests.rs"]
mod store_tests;

pub use report::{BypassReason, CacheOutcome, CacheReport, CacheWork, MissReason, PublishOutcome};

use crate::{ProcessingRequest, ProcessingResult};
use envelope::EntryIdentity;
use std::path::PathBuf;
use std::time::Instant;
use store::{ReadEntry, ReadError, Store};

/// What a [`ResultCache`] may do. Off unless a caller opts in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CacheMode {
    /// Call [`process`](crate::process) directly; no hashing, no file access.
    #[default]
    Off,
    /// Replay entries; never create, write or touch anything.
    ReadOnly,
    /// Replay entries; store new results; refresh last-use times; evict.
    ReadWrite,
}

/// Where and how much. Defaults: off, the platform cache directory, 10 GiB
/// per directory, 1 GiB per entry. The limits are policy choices, not
/// measured optima.
#[non_exhaustive]
#[derive(Debug, Clone)]
pub struct ResultCacheConfig {
    pub mode: CacheMode,
    /// `None`: [`default_directory`]. Entries go in a `result-v1` directory
    /// beneath it.
    pub directory: Option<PathBuf>,
    pub max_bytes: u64,
    pub max_entry_bytes: u64,
    /// Test hook: mixed into the engine identity to stand for a different
    /// build or entry format. Empty in production.
    #[doc(hidden)]
    pub engine_salt: Vec<u8>,
}

impl Default for ResultCacheConfig {
    fn default() -> Self {
        Self { mode: CacheMode::Off, directory: None, max_bytes: 10 << 30, max_entry_bytes: 1 << 30, engine_salt: Vec::new() }
    }
}

impl ResultCacheConfig {
    pub fn mode(mut self, mode: CacheMode) -> Self {
        self.mode = mode;
        self
    }
    pub fn directory(mut self, directory: impl Into<PathBuf>) -> Self {
        self.directory = Some(directory.into());
        self
    }
    pub fn max_bytes(mut self, bytes: u64) -> Self {
        self.max_bytes = bytes;
        self
    }
    pub fn max_entry_bytes(mut self, bytes: u64) -> Self {
        self.max_entry_bytes = bytes;
        self
    }
    #[doc(hidden)]
    pub fn engine_salt(mut self, salt: &[u8]) -> Self {
        self.engine_salt = salt.to_vec();
        self
    }
}

/// The per-user default root: `IFC_LITE_CACHE_DIR` if set, else
/// `$XDG_CACHE_HOME/ifc-lite/native` or `~/.cache/ifc-lite/native` (Linux and
/// other Unix), `~/Library/Caches/ifc-lite/native` (macOS),
/// `%LOCALAPPDATA%\ifc-lite\native` (Windows).
pub fn default_directory() -> Option<PathBuf> {
    let env_dir = |name: &str| std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from);
    if let Some(dir) = env_dir("IFC_LITE_CACHE_DIR") {
        return Some(dir);
    }
    let base = if cfg!(windows) {
        env_dir("LOCALAPPDATA")
    } else if cfg!(target_os = "macos") {
        env_dir("HOME").map(|h| h.join("Library").join("Caches"))
    } else {
        env_dir("XDG_CACHE_HOME").filter(|p| p.is_absolute()).or_else(|| env_dir("HOME").map(|h| h.join(".cache")))
    };
    base.map(|b| b.join("ifc-lite").join("native"))
}

/// A result and what the cache did to produce it.
pub struct CachedProcessing {
    pub result: ProcessingResult,
    pub report: CacheReport,
}

/// A reusable cache context. Cheap to build; holds no open files.
#[derive(Debug, Clone, Default)]
pub struct ResultCache {
    config: ResultCacheConfig,
}

/// Why a stored entry was not used. Display text goes into warnings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CodecError {
    Truncated,
    Overflow,
    BadMagic,
    Unsupported(u32),
    Layout(&'static str),
    IdentityMismatch,
    Checksum(&'static str),
    Malformed(&'static str, &'static str),
    Invariant(&'static str),
}

impl std::fmt::Display for CodecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Truncated => f.write_str("truncated"),
            Self::Overflow => f.write_str("length or count overflows"),
            Self::BadMagic => f.write_str("not a result-cache entry"),
            Self::Unsupported(v) => write!(f, "unsupported entry format version {v}"),
            Self::Layout(what) => write!(f, "bad layout: {what}"),
            Self::IdentityMismatch => f.write_str("entry identity does not match its key"),
            Self::Checksum(section) => write!(f, "{section} checksum mismatch"),
            Self::Malformed(section, what) => write!(f, "malformed {section}: {what}"),
            Self::Invariant(what) => write!(f, "invariant: {what}"),
        }
    }
}

impl ResultCache {
    pub fn new(config: ResultCacheConfig) -> Self {
        Self { config }
    }

    pub fn config(&self) -> &ResultCacheConfig {
        &self.config
    }

    /// Process `content` as `request` asks, replaying a stored result when one
    /// matches. The pass runs without a sink (see the module docs).
    pub fn process(&self, content: &[u8], request: &ProcessingRequest) -> CachedProcessing {
        let mut report = CacheReport::new(CacheOutcome::Off);
        if self.config.mode == CacheMode::Off {
            return self.run_live(content, request, report, None);
        }
        let request_digest = match key::request_digest(request) {
            Ok(digest) => digest,
            Err(reason) => {
                report.outcome = CacheOutcome::Bypass(reason);
                return self.run_live(content, request, report, None);
            }
        };
        let writable = self.config.mode == CacheMode::ReadWrite;
        let Some(root) = self.config.directory.clone().or_else(default_directory) else {
            report.outcome = CacheOutcome::Bypass(BypassReason::Unavailable("no cache directory".into()));
            return self.run_live(content, request, report, None);
        };
        let store = match Store::open(&root, writable, self.config.max_bytes, self.config.max_entry_bytes) {
            Ok(store) => Some(store),
            Err(e) if !writable && e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => {
                report.warn(format!("result cache unavailable at {}: {e}", root.display()));
                report.outcome = CacheOutcome::Bypass(BypassReason::Unavailable(e.to_string()));
                return self.run_live(content, request, report, None);
            }
        };

        // Snapshot the engine (build, executable, effective output policy)
        // before anything runs, so the key names the policy the pass will use.
        let Some(engine) = key::EngineIdentity::current(&self.config.engine_salt) else {
            report.warn("result cache: executable identity unreadable".into());
            report.outcome = CacheOutcome::Bypass(BypassReason::Unavailable("no engine identity".into()));
            return self.run_live(content, request, report, None);
        };
        let started = Instant::now();
        let source_sha256 = key::source_digest(content);
        report.work.hash = started.elapsed();
        report.work.bytes_hashed = content.len() as u64;
        let engine_digest = engine.digest();
        let source_len = content.len() as u64;
        let id = EntryIdentity {
            key: key::cache_key(&source_sha256, source_len, &request_digest, &engine_digest),
            source_sha256,
            source_len,
            request_digest,
            engine_digest,
        };
        let key_hex = key::hex(&id.key);
        report.key = Some(key_hex.clone());
        let Some(store) = store else {
            report.outcome = CacheOutcome::Miss(MissReason::Absent);
            return self.run_live(content, request, report, None);
        };
        match lookup(&store, &key_hex, &id, self.config.max_entry_bytes, &mut report) {
            Ok((mut result, entry)) => {
                if writable {
                    store.touch(&entry);
                }
                result.stats.from_cache = true;
                report.outcome = CacheOutcome::Hit;
                CachedProcessing { result, report }
            }
            Err((reason, entry)) => {
                if let (true, Some(entry)) = (writable, entry.as_ref()) {
                    store.remove_if_same(&key_hex, entry);
                }
                report.outcome = CacheOutcome::Miss(reason);
                let publish = writable.then_some(Publish { store: &store, id: &id, key_hex: &key_hex, engine: &engine });
                self.run_live(content, request, report, publish)
            }
        }
    }

    /// The unchanged pipeline, then (read-write misses only) publication.
    fn run_live(
        &self,
        content: &[u8],
        request: &ProcessingRequest,
        mut report: CacheReport,
        publish: Option<Publish<'_>>,
    ) -> CachedProcessing {
        let started = Instant::now();
        let result = crate::process(content, request, &mut ());
        report.work.process = started.elapsed();
        if let Some(Publish { engine, .. }) = &publish {
            if engine.policy_changed() {
                // A racing override changed the output policy during the pass:
                // the result may mix both, and it is not this key's.
                report.publish = PublishOutcome::SkippedPolicyChanged;
                return CachedProcessing { result, report };
            }
        }
        if let Some(Publish { store, id, key_hex, .. }) = publish {
            let started = Instant::now();
            let encoded = envelope::encode_entry(&result, id);
            report.work.encode = started.elapsed();
            report.publish = match encoded {
                Ok(bytes) => {
                    let started = Instant::now();
                    let outcome = store.publish(key_hex, &bytes);
                    report.work.write = started.elapsed();
                    if matches!(outcome, PublishOutcome::Published { .. }) {
                        report.work.entry_bytes_written = bytes.len() as u64;
                    }
                    outcome
                }
                Err(e) => PublishOutcome::Unencodable(e.to_string()),
            };
            if let PublishOutcome::Failed(why) | PublishOutcome::Unencodable(why) = &report.publish {
                report.warn(format!("result cache: not stored: {why}"));
            }
        }
        CachedProcessing { result, report }
    }
}

/// Where a read-write miss publishes, and the engine snapshot it was keyed on.
struct Publish<'a> {
    store: &'a Store,
    id: &'a EntryIdentity,
    key_hex: &'a str,
    engine: &'a key::EngineIdentity,
}

type Lookup = Result<(ProcessingResult, ReadEntry), (MissReason, Option<ReadEntry>)>;

/// Read, validate and decode one entry, timing each step into `report`.
fn lookup(store: &Store, key_hex: &str, id: &EntryIdentity, limit: u64, report: &mut CacheReport) -> Lookup {
    let started = Instant::now();
    let read = store.read(key_hex);
    report.work.read = started.elapsed();
    let entry = match read {
        Ok(Some(entry)) => entry,
        Ok(None) => return Err((MissReason::Absent, None)),
        Err(ReadError::Oversized(bytes)) => {
            report.warn(format!("result cache: entry {key_hex} is {bytes} bytes, over the per-entry limit"));
            return Err((MissReason::Oversized { bytes, limit }, None));
        }
        Err(ReadError::Io(e)) => {
            report.warn(format!("result cache: could not read entry {key_hex}: {e}"));
            return Err((MissReason::ReadFailed(e.to_string()), None));
        }
    };
    report.work.entry_bytes_read = entry.bytes.len() as u64;
    let started = Instant::now();
    let layout = envelope::validate_entry(&entry.bytes, id);
    report.work.validate = started.elapsed();
    let decoded = layout.and_then(|layout| {
        let started = Instant::now();
        let decoded = envelope::decode_entry(&entry.bytes, &layout);
        report.work.decode = started.elapsed();
        decoded
    });
    match decoded {
        Ok(result) => {
            report.work.bytes_decoded = (entry.bytes.len() - envelope::BODY_START) as u64;
            Ok((result, entry))
        }
        Err(e) => {
            report.warn(format!("result cache: rejected entry {key_hex}: {e}"));
            let reason = match e {
                CodecError::Unsupported(version) => MissReason::Unsupported(version),
                CodecError::IdentityMismatch => MissReason::IdentityMismatch,
                other => MissReason::Corrupt(other.to_string()),
            };
            Err((reason, Some(entry)))
        }
    }
}
