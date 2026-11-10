// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Cache keys.
//!
//! `key = SHA-256("ifc-lite-native-result-v1" ‖ SHA-256(source) ‖ len(source)
//! ‖ request digest ‖ engine digest)`, every part length-framed.
//!
//! * Source: every byte the pass reads, never a sample.
//! * Request: a canonical encoding of every output-affecting
//!   [`ProcessingRequest`] field with explicit tags, sorted id sets, and
//!   `None` distinct from `Some(empty)`. The request is destructured in full,
//!   so a new field does not compile until it is classified here.
//! * Engine ([`EngineIdentity`]): what produced the bytes, at three levels.
//!   - Build: the `build.rs` digest (core/geometry/processing sources,
//!     `Cargo.lock`, rustc, target, profile, flags, this crate's features),
//!     the geometry crate's own resolved features
//!     (`ifc_lite_geometry::output_policy::BUILD_FEATURES`, which a downstream
//!     binary can change without touching this crate), and the running
//!     executable file's identity (size, mtime, ctime, device, inode; no
//!     path): a relink, including one that only changes third-party feature
//!     unification, writes a new file and misses.
//!   - Policy: the EFFECTIVE process-global output policy, read through the
//!     same accessors the pipeline calls
//!     (`ifc_lite_geometry::output_policy::effective_output_policy`, plus the
//!     degenerate backstop), never the raw environment, so a `OnceLock`
//!     initialised before an environment change and the programmatic
//!     overrides (`local_frame_set_enabled_override`, `set_cap`, ...) are
//!     keyed as the pipeline will see them.
//!   - Execution: the calling thread's rayon worker count. No mesh output is
//!     known to depend on it; it is keyed because that has not been shown
//!     across pool sizes, and it costs hits only between differently sized
//!     pools. Scheduling-dependent statistics (point-cache hit/miss counts)
//!     are not made reproducible by it; like timings they are the producer's.
//!
//!   The format version and a test-only salt are mixed in too.

use super::envelope::FORMAT_VERSION;
use super::BypassReason;
use crate::{Batching, Features, OpeningFilterMode, ProcessingRequest};
use ifc_lite_geometry::TessellationQuality;
use sha2::{Digest, Sha256};

/// Compile-time engine identity; see `build.rs`.
const BUILD_DIGEST: &str = env!("IFC_LITE_ENGINE_BUILD_DIGEST");

struct Framed(Sha256);

impl Framed {
    fn new(domain: &str) -> Self {
        let mut h = Self(Sha256::new());
        h.field(domain.as_bytes());
        h
    }
    fn field(&mut self, bytes: &[u8]) {
        self.0.update((bytes.len() as u64).to_le_bytes());
        self.0.update(bytes);
    }
    fn u8(&mut self, v: u8) {
        self.field(&[v]);
    }
    fn u64(&mut self, v: u64) {
        self.field(&v.to_le_bytes());
    }
    fn finish(self) -> [u8; 32] {
        self.0.finalize().into()
    }
}

pub(super) fn source_digest(content: &[u8]) -> [u8; 32] {
    Sha256::digest(content).into()
}

/// The canonical request digest, or why this request cannot be replayed.
pub(super) fn request_digest(req: &ProcessingRequest) -> Result<[u8; 32], BypassReason> {
    let ProcessingRequest {
        opening_filter,
        skip_voids,
        quality,
        layer_slicing,
        batching,
        features,
        retain_meshes,
        instancing,
        entity_ids,
        entity_index,
        cancel,
    } = req;
    // Execution controls first: a request that carries one is not cacheable.
    if cancel.is_some() {
        return Err(BypassReason::CancellationArmed);
    }
    if entity_index.is_some() {
        return Err(BypassReason::InjectedEntityIndex);
    }
    if !retain_meshes {
        return Err(BypassReason::MeshesNotRetained);
    }
    let mut h = Framed::new("ifc-lite-native-request-v1");
    h.u8(match opening_filter {
        OpeningFilterMode::Default => 0,
        OpeningFilterMode::IgnoreAll => 1,
        OpeningFilterMode::IgnoreOpaque => 2,
    });
    h.u8(u8::from(*skip_voids));
    h.u8(match quality {
        TessellationQuality::Lowest => 0,
        TessellationQuality::Low => 1,
        TessellationQuality::Medium => 2,
        TessellationQuality::High => 3,
        TessellationQuality::Highest => 4,
    });
    h.u8(u8::from(*layer_slicing));
    // Batching only chunks delivery, but `fast_first` reorders jobs; until
    // result-order independence is proven, every batching field keys.
    let Batching { initial, throughput, fast_first } = batching;
    h.u64(*initial as u64);
    h.u64(*throughput as u64);
    h.u8(u8::from(*fast_first));
    let Features { properties, presentation_layers, quick_metadata_bootstrap, finishes } = features;
    for flag in [properties, presentation_layers, quick_metadata_bootstrap, finishes] {
        h.u8(u8::from(*flag));
    }
    h.u8(u8::from(*instancing));
    match entity_ids {
        None => h.u8(0),
        Some(ids) => {
            h.u8(1);
            let mut sorted: Vec<u32> = ids.iter().copied().collect();
            sorted.sort_unstable();
            h.u64(sorted.len() as u64);
            let bytes: Vec<u8> = sorted.iter().flat_map(|id| id.to_le_bytes()).collect();
            h.field(&bytes);
        }
    }
    Ok(h.finish())
}

/// Identity of the file at `path` as the kernel tracks it: size, mtime,
/// ctime, device and inode. No path, so a moved binary keeps its entries.
/// ctime cannot be set by `touch`/`cp -p`/`utime`: any write or metadata
/// restore advances it, so an in-place edit that restores mtime still changes
/// this (PR #9614 review 2, R2-3). `None` when unreadable; the caller bypasses.
pub(super) fn file_identity(path: &std::path::Path) -> Option<Vec<u8>> {
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?;
    let mut out = meta.len().to_le_bytes().to_vec();
    out.extend_from_slice(&modified.as_nanos().to_le_bytes());
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        for v in [meta.ctime(), meta.ctime_nsec()] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        out.extend_from_slice(&meta.dev().to_le_bytes());
        out.extend_from_slice(&meta.ino().to_le_bytes());
    }
    Some(out)
}

/// Everything about the engine that keys an entry, plus the two counters that
/// say whether a pass may store its result under it.
#[derive(Clone, PartialEq, Eq, Debug)]
pub(super) struct EngineIdentity {
    build: Vec<u8>,
    policy: Vec<u8>,
    /// `ifc_lite_geometry::output_policy::policy_generation` at the snapshot.
    generation: u64,
    /// `ifc_lite_geometry::resource::stop_events` at the snapshot.
    stops: u64,
    /// `ifc_lite_core::scan_report_events` at the snapshot.
    reports: u64,
}

impl EngineIdentity {
    /// Snapshot now. `None` when the executable identity is unreadable or
    /// policy setters keep racing the read.
    pub(super) fn current(salt: &[u8]) -> Option<Self> {
        let mut build = BUILD_DIGEST.as_bytes().to_vec();
        build.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
        build.extend_from_slice(&file_identity(&std::env::current_exe().ok()?)?);
        build.extend_from_slice(&(salt.len() as u64).to_le_bytes());
        build.extend_from_slice(salt);
        // Stops first: a stop that lands while the policy is read is still seen.
        let stops = ifc_lite_geometry::resource::stop_events();
        let reports = ifc_lite_core::scan_report_events();
        let (generation, policy) = ifc_lite_geometry::output_policy::coherent_output_policy()?;
        let mut policy = policy.canonical_bytes();
        policy.push(u8::from(crate::element::degenerate_backstop_disabled()));
        policy.extend_from_slice(&(rayon::current_num_threads() as u64).to_le_bytes());
        Some(Self { build, policy, generation, stops, reports })
    }

    pub(super) fn digest(&self) -> [u8; 32] {
        let mut h = Framed::new("ifc-lite-native-engine-v2");
        h.field(&self.build);
        h.field(&self.policy);
        h.finish()
    }

    /// A policy setter ran since this snapshot, even if it restored the old
    /// value (A -> B -> A): work done in between may mix policies.
    pub(super) fn policy_changed(&self) -> bool {
        ifc_lite_geometry::output_policy::policy_generation() != self.generation
    }

    /// Some product, anywhere in the process, was refused, cancelled or
    /// degraded by resource state since this snapshot. Conservative: an
    /// unrelated caller's stop also counts.
    pub(super) fn resource_stopped(&self) -> bool {
        ifc_lite_geometry::resource::stop_events() != self.stops
    }

    /// A scan diagnostic (refused records, malformed file) was emitted through
    /// core's report sink since this snapshot. Conservative: another pass's
    /// report also counts.
    pub(super) fn scan_reported(&self) -> bool {
        ifc_lite_core::scan_report_events() != self.reports
    }
}

pub(super) fn cache_key(source: &[u8; 32], source_len: u64, request: &[u8; 32], engine: &[u8; 32]) -> [u8; 32] {
    let mut h = Framed::new("ifc-lite-native-result-v1");
    h.field(source);
    h.u64(source_len);
    h.field(request);
    h.field(engine);
    h.finish()
}

pub(super) fn hex(bytes: &[u8; 32]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::file_identity;

    /// PR #9614 review 2, R2-3: the reviewer's reproducer edited a binary in
    /// place to different bytes of the same length and restored its mtime,
    /// which left size/mtime/device/inode unchanged. ctime cannot be restored,
    /// so the identity must differ.
    #[cfg(unix)]
    #[test]
    fn an_in_place_edit_with_restored_mtime_changes_the_identity() {
        let dir = std::env::temp_dir().join(format!("ifc-lite-rc-exe-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("engine");
        std::fs::write(&path, b"BUILD_A and the rest of a binary").unwrap();
        let before = file_identity(&path).unwrap();
        let mtime = std::fs::metadata(&path).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&path, b"BUILD_B and the rest of a binary").unwrap();
        std::fs::File::options().write(true).open(&path).unwrap().set_modified(mtime).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().modified().unwrap(), mtime, "mtime restored");
        assert_ne!(file_identity(&path).unwrap(), before, "edited bytes with a restored mtime kept the identity");
        // A path is not part of it: a hard link to the same file agrees.
        let link = dir.join("engine-link");
        let _ = std::fs::remove_file(&link);
        std::fs::hard_link(&path, &link).unwrap();
        assert_eq!(file_identity(&link), file_identity(&path));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
