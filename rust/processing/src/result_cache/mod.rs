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

mod config;
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

pub use config::{default_directory, CacheMode, PassHook, ResultCacheConfig};
pub use report::{BypassReason, CacheOutcome, CacheReport, CacheWork, MissReason, PublishOutcome};
use config::HookSink;

use crate::{ProcessingRequest, ProcessingResult};
use envelope::EntryIdentity;
use std::time::Instant;
use store::{ReadEntry, ReadError, Store};

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
        // Inside an execution account, source stop or terminal domain the
        // pass can be refused or degraded by that scope; a hit would hand back
        // a complete result the scope would not have produced, and a stored
        // result could be a degraded one (PR #9614 review 2, R2-2).
        if ifc_lite_geometry::resource::ambient_scope_active() {
            report.outcome = CacheOutcome::Bypass(BypassReason::AmbientResourceScope);
            return self.run_live(content, request, report, None);
        }
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
            Ok(_) if engine.policy_changed() => {
                // A setter ran while the entry was read: the snapshot the key
                // named is no longer the policy, so do not return it. The live
                // run is not stored either (its policy may be mixed).
                report.outcome = CacheOutcome::Miss(MissReason::PolicyChangedDuringLookup);
                let publish = writable.then_some(Publish { store: &store, id: &id, key_hex: &key_hex, engine: &engine });
                self.run_live(content, request, report, publish)
            }
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
        let result = match &self.config.pass_hook {
            Some(hook) => crate::process(content, request, &mut HookSink(hook, 0)),
            None => crate::process(content, request, &mut ()),
        };
        report.work.process = started.elapsed();
        if let Some(Publish { engine, .. }) = &publish {
            // Any policy setter during the pass, even one undone before it
            // ended, may have produced mixed output that is not this key's.
            let skip = if engine.policy_changed() {
                Some(PublishOutcome::SkippedPolicyChanged)
            } else if engine.resource_stopped() {
                Some(PublishOutcome::SkippedResourceStop)
            } else {
                None
            };
            if let Some(skip) = skip {
                report.publish = skip;
                return CachedProcessing { result, report };
            }
        }
        if let Some(Publish { store, id, key_hex, .. }) = publish {
            let limit = self.config.max_entry_bytes.min(self.config.max_bytes);
            let at_least = envelope::payload_lower_bound(&result);
            if at_least > limit {
                // Certainly too big: refuse before encoding (no copy at all).
                report.publish = PublishOutcome::SkippedOversized { bytes: at_least, limit };
                return CachedProcessing { result, report };
            }
            let started = Instant::now();
            let encoded = envelope::encode_parts(&result, id);
            report.work.encode = started.elapsed();
            report.publish = match encoded {
                Ok(entry) => {
                    let started = Instant::now();
                    let outcome = store.publish_parts(key_hex, &entry.parts());
                    report.work.write = started.elapsed();
                    if matches!(outcome, PublishOutcome::Published { .. }) {
                        report.work.entry_bytes_written = entry.len() as u64;
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
