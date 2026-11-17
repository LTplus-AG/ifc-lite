// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! PR #9614 review 4, R4-1: an embedded texture binary that does not decode
//! exactly is refused and counted (`ifc_lite_geometry::binary_textures_refused`,
//! D18 / #7778). A hit never decodes textures, so at d67bcee0 a cached load
//! returned the same texture-less result with no refusal counted. A pass that
//! refuses a texture binary is now never stored, so every call counts it.
//!
//! Its own test binary: the counter is process-wide.

#![cfg(all(feature = "native-result-cache", not(target_arch = "wasm32")))]

use ifc_lite_geometry::binary_textures_refused;
use ifc_lite_processing::result_cache::{CacheMode, CacheOutcome, PublishOutcome, ResultCache, ResultCacheConfig};
use ifc_lite_processing::{result_fingerprint, ProcessingRequest};
use std::path::PathBuf;

#[test]
fn passes_that_refuse_a_texture_binary_are_never_replayed_silently() {
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../geometry/tests/fixtures/mapped_instances_synthetic.ifc");
    let clean = std::fs::read_to_string(fixture).expect("in-repo fixture");
    // The #7778 construction: a pixel texture whose binary has a non-zero
    // unused-bits indicator ("1..."), so it does not decode exactly.
    let refused = clean.replacen(
        "DATA;",
        "DATA;\n#900001=IFCPIXELTEXTURE(.T.,.T.,'MODULATE',$,$,1,1,3,(\"1FF0000\"));\n\
         #900002=IFCTEXTUREVERTEXLIST(((0.,0.),(1.,0.),(0.,1.)));\n\
         #900005=IFCINDEXEDTRIANGLETEXTUREMAP((#900001),#900004,#900002,((1,2,3)));",
        1,
    );
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join(format!("rc-r4-1-{}-{nanos}", std::process::id()));
    let cache = ResultCache::new(ResultCacheConfig::default().mode(CacheMode::ReadWrite).directory(&dir).min_free_bytes(0));
    let request = ProcessingRequest::full_pass();

    // Control: the clean file refuses nothing and caches.
    let before = binary_textures_refused();
    let cold = cache.process(clean.as_bytes(), &request);
    assert_eq!(binary_textures_refused(), before);
    assert!(matches!(cold.report.publish, PublishOutcome::Published { .. }), "{:?}", cold.report.publish);
    assert_eq!(cache.process(clean.as_bytes(), &request).report.outcome, CacheOutcome::Hit);

    let before = binary_textures_refused();
    let first = cache.process(refused.as_bytes(), &request);
    let refusals = binary_textures_refused() - before;
    assert!(refusals > 0, "the live pass refuses the binary");
    let before = binary_textures_refused();
    let second = cache.process(refused.as_bytes(), &request);
    assert_ne!(second.report.outcome, CacheOutcome::Hit, "a hit would drop the refusal");
    assert_eq!(binary_textures_refused() - before, refusals, "every call counts the same refusals");
    assert!(!matches!(first.report.publish, PublishOutcome::Published { .. }), "{:?}", first.report.publish);
    assert_eq!(result_fingerprint(&second.result, false), result_fingerprint(&first.result, false));
    let _ = std::fs::remove_dir_all(&dir);
}
