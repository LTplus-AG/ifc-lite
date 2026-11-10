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
//!     executable's identity (path, size, mtime, device and inode): any
//!     relink, including one that only changes third-party feature
//!     unification, misses.
//!   - Policy: the EFFECTIVE process-global output policy, read through the
//!     same accessors the pipeline calls
//!     (`ifc_lite_geometry::output_policy::effective_output_policy`, plus the
//!     degenerate backstop), never the raw environment, so a `OnceLock`
//!     initialised before an environment change and the programmatic
//!     overrides (`local_frame_set_enabled_override`, `set_cap`, ...) are
//!     keyed as the pipeline will see them.
//!   - Execution: the calling thread's rayon worker count.
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

/// The running executable: path, size, mtime, device and inode. Any rebuild
/// or relink changes it. `None` when it cannot be read; the caller bypasses.
fn executable_identity() -> Option<Vec<u8>> {
    let path = std::env::current_exe().ok()?;
    let meta = std::fs::metadata(&path).ok()?;
    let modified = meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?;
    let mut out = path.as_os_str().as_encoded_bytes().to_vec();
    out.extend_from_slice(&meta.len().to_le_bytes());
    out.extend_from_slice(&modified.as_nanos().to_le_bytes());
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        out.extend_from_slice(&meta.dev().to_le_bytes());
        out.extend_from_slice(&meta.ino().to_le_bytes());
    }
    Some(out)
}

/// Everything about the engine that keys an entry. Build and executable parts
/// are fixed for the process; the policy part is re-read per call.
#[derive(Clone, PartialEq, Eq, Debug)]
pub(super) struct EngineIdentity {
    build: Vec<u8>,
    policy: Vec<u8>,
}

impl EngineIdentity {
    /// Snapshot now. `None` when the executable identity is unreadable.
    pub(super) fn current(salt: &[u8]) -> Option<Self> {
        let mut build = BUILD_DIGEST.as_bytes().to_vec();
        build.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
        build.extend_from_slice(&executable_identity()?);
        build.extend_from_slice(&(salt.len() as u64).to_le_bytes());
        build.extend_from_slice(salt);
        Some(Self { build, policy: policy_bytes() })
    }

    pub(super) fn digest(&self) -> [u8; 32] {
        let mut h = Framed::new("ifc-lite-native-engine-v2");
        h.field(&self.build);
        h.field(&self.policy);
        h.finish()
    }

    /// The policy changed since this snapshot (a racing override): a result
    /// computed across the change must not be stored under this identity.
    pub(super) fn policy_changed(&self) -> bool {
        self.policy != policy_bytes()
    }
}

/// The effective output policy, as the pipeline reads it right now.
pub(super) fn policy_bytes() -> Vec<u8> {
    let mut out = ifc_lite_geometry::output_policy::effective_output_policy().canonical_bytes();
    out.push(u8::from(crate::element::degenerate_backstop_disabled()));
    out.extend_from_slice(&(rayon::current_num_threads() as u64).to_le_bytes());
    out
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
