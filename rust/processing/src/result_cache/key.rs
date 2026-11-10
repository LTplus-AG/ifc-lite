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
//! * Engine: the build digest from `build.rs` (crate sources, `Cargo.lock`,
//!   rustc, target, profile, flags, features), the entry format version, and
//!   every `IFC_LITE_*` / `IFCLITE_*` environment variable, since several
//!   change geometry at runtime (`IFC_LITE_RECT_FAST`, `IFC_LITE_VOID_2D`,
//!   ...). `IFC_LITE_CACHE_DIR` (location) and `IFC_LITE_REQUIRE_FIXTURES`
//!   (test harness) are left out.

use super::envelope::FORMAT_VERSION;
use super::BypassReason;
use crate::{Batching, Features, OpeningFilterMode, ProcessingRequest};
use ifc_lite_geometry::TessellationQuality;
use sha2::{Digest, Sha256};

/// Compile-time engine identity; see `build.rs`.
const BUILD_DIGEST: &str = env!("IFC_LITE_ENGINE_BUILD_DIGEST");
/// `IFC_LITE_*` variables that cannot change output: the cache location and
/// the test harness's fixture requirement.
const NON_OUTPUT_ENV: &[&str] = &["IFC_LITE_CACHE_DIR", "IFC_LITE_REQUIRE_FIXTURES"];

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

/// This process's engine identity. `salt` is a test hook standing in for a
/// different build or format; production passes an empty salt.
pub(super) fn engine_digest(salt: &[u8]) -> [u8; 32] {
    let mut h = Framed::new("ifc-lite-native-engine-v1");
    h.field(BUILD_DIGEST.as_bytes());
    h.u64(u64::from(FORMAT_VERSION));
    h.field(salt);
    let mut knobs: Vec<(Vec<u8>, Vec<u8>)> = std::env::vars_os()
        .filter_map(|(k, v)| {
            let name = k.to_str()?;
            let output_affecting = (name.starts_with("IFC_LITE_") || name.starts_with("IFCLITE_"))
                && !NON_OUTPUT_ENV.contains(&name);
            output_affecting.then(|| (k.as_encoded_bytes().to_vec(), v.as_encoded_bytes().to_vec()))
        })
        .collect();
    knobs.sort();
    h.u64(knobs.len() as u64);
    for (k, v) in &knobs {
        h.field(k);
        h.field(v);
    }
    h.finish()
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
