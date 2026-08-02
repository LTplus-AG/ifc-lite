// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression gate for the faceted-brep CartesianPoint re-parse amplification
//! (case-047/048, ~176x CPU on shared-point steel breps).
//!
//! `EntityDecoder::get_polyloop_coords_cached` memoizes parsed CartesianPoint
//! coordinates so a point shared across many faceted-brep parts is parsed once
//! rather than re-parsed per part. That cache is carried by a PERSISTENT
//! per-rayon-worker store (`worker_point_caches` in `processor/mod.rs`) that
//! survives across throughput chunks AND rayon job splits — the fix that made
//! P4's per-`map_init` hoist actually fire under real parallel execution.
//!
//! The committed fixture `shared_point_faceted_brep.ifc` is a synthetic model of
//! 12 IfcFacetedBrep parts that all reference ONE shared pool of 196
//! CartesianPoints (a 14x14 grid), each part owning its own faces/loops. It
//! mimics the case-047/048 shape: many parts, one shared point list, per-part
//! cost dominated by (re-)resolving those shared points. Generated, no real
//! project data (see the FILE_DESCRIPTION provenance line in the fixture).
//!
//! Pinning a single-thread rayon pool makes the assertion deterministic and
//! independent of the CI machine's core count: every part is meshed by worker 0,
//! which owns one persistent cache, so each of the 196 shared points is parsed
//! EXACTLY ONCE for the whole model. If the cache is dropped, reset per part, or
//! re-fragmented per rayon split (the pre-fix behavior), `point_cache_misses`
//! balloons well above the shared-pool size and this gate fails.

use ifc_lite_processing::process_geometry;

const FIXTURE: &str = "../geometry/tests/fixtures/shared_point_faceted_brep.ifc";

/// Distinct CartesianPoints shared by every part (the 14x14 grid in the fixture).
const SHARED_POINTS: u64 = 196;
/// Faceted-brep parts in the fixture, each referencing the whole shared pool.
const PARTS: usize = 12;

fn fixture_path() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(FIXTURE)
}

#[test]
fn shared_point_faceted_breps_parse_each_point_once() {
    let bytes = std::fs::read(fixture_path())
        .expect("committed synthetic fixture shared_point_faceted_brep.ifc must be present");

    // Force a single-thread pool so the persistent per-worker cache serves the
    // WHOLE model from one map: the miss count becomes deterministic (= the shared
    // pool size) regardless of how many cores CI has. `process_geometry`'s internal
    // rayon `par_iter` runs on the current pool, so `install` binds it here.
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(1)
        .build()
        .expect("build single-thread rayon pool");
    let result = pool.install(|| process_geometry(&bytes));

    // The fixture is all faceted-brep geometry: every part must mesh.
    assert_eq!(
        result.stats.total_meshes, PARTS,
        "expected {PARTS} faceted-brep meshes, got {}",
        result.stats.total_meshes
    );

    let hits = result.stats.point_cache_hits;
    let misses = result.stats.point_cache_misses;

    // The shared pool is parsed exactly once for the whole model. A regression
    // that re-parses the pool per part or per rayon split pushes `misses` up
    // toward `SHARED_POINTS * PARTS` (2352) instead of 196.
    assert_eq!(
        misses, SHARED_POINTS,
        "each shared CartesianPoint must be parsed exactly once across all parts \
         (single-thread pool); got {misses} misses vs {SHARED_POINTS} shared points. \
         A higher count means the per-worker point cache stopped memoizing across parts."
    );

    // Sanity: the parts genuinely re-reference the shared pool many times, so the
    // cache does real work (hits dominate). Every reference beyond the first parse
    // is a hit, across all 12 parts and all faces.
    assert!(
        hits > misses * 10,
        "expected the shared pool to be re-referenced far more than parsed \
         (hits={hits}, misses={misses})"
    );
}
