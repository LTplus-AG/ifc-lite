// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `produce_element_meshes` must hand back, alongside the #924 fingerprint, the
//! WORLD AABB of the geometry that fingerprint covers (#1891 follow-on).
//!
//! The diff engine's content matcher calls two content-identical entities
//! `moved` whenever their geometry hashes differ — but the hash conflates
//! moved, reshaped and re-tessellated, so that label is a guess. The box is the
//! signal that makes it checkable, which only works if it is (a) actually the
//! extent of the produced meshes, (b) in WORLD coordinates with the file's RTC
//! folded back in, and (c) gated by the same switch as the hash.
//!
//! Run against real fixture geometry, not a synthetic cube: the production path
//! reaches the hasher through `emit_sub_meshes` (many segments per element,
//! each in its own local frame with its own `origin`), which a single-mesh unit
//! test cannot exercise.

use ifc_lite_core::{build_entity_index, has_geometry_by_name, EntityDecoder, EntityScanner};
use ifc_lite_geometry::GeometryRouter;
use ifc_lite_processing::element::{
    produce_element_meshes, ElementJobKind, ElementMeshJob, GeometryHashConfig,
    MeshProductionContext, MeshProductionOptions, ProducedElementMeshes,
};
use rustc_hash::FxHashMap;
use std::sync::Arc;

const FIXTURE: &str = "../../tests/models/ara3d/AC20-FZK-Haus.ifc";

fn read_fixture() -> Option<Vec<u8>> {
    match std::fs::read(FIXTURE) {
        Ok(b) => Some(b),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!(
                "skipping geometry-hash AABB test: fixture missing at {FIXTURE} — \
                 run `pnpm fixtures` (sha256 in tests/models/manifest.json)"
            );
            None
        }
        Err(e) => panic!("failed to read fixture {FIXTURE}: {e}"),
    }
}

/// Produce every geometry element, with hashing configured as `hash`.
///
/// `router_rtc` is the offset the MESH pipeline shifts by (every produced
/// vertex comes back as `world - router_rtc`); `hash.world_rtc` is the offset
/// the HASHER folds back on. They are two independent knobs and a caller that
/// sets only one is not modelling a georeferenced file at all — see
/// [`reported_aabb_is_rtc_invariant`].
fn produce_all(
    content: &[u8],
    index: &Arc<ifc_lite_core::EntityIndex>,
    hash: Option<GeometryHashConfig>,
    router_rtc: [f64; 3],
) -> Vec<(u32, ProducedElementMeshes)> {
    let mut router = GeometryRouter::with_scale(1.0);
    router.set_rtc_offset((router_rtc[0], router_rtc[1], router_rtc[2]));
    let mut decoder = EntityDecoder::with_arc_index(content, index.clone());
    decoder.seed_unit_scales(router.unit_scale(), 1.0);

    let void_index = FxHashMap::default();
    let geometry_style_index = FxHashMap::default();
    let indexed_colour_full = FxHashMap::default();
    let element_material_colors = FxHashMap::default();
    let texture_index = FxHashMap::default();
    let ctx = MeshProductionContext {
        void_index: &void_index,
        geometry_style_index: &geometry_style_index,
        indexed_colour_full: &indexed_colour_full,
        element_material_colors: &element_material_colors,
        texture_index: &texture_index,
        site_local_rotation: None,
    };
    let opts = MeshProductionOptions { geometry_hash: hash };

    let mut jobs: Vec<(u32, usize, usize)> = Vec::new();
    let mut scanner = EntityScanner::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if has_geometry_by_name(type_name) {
            jobs.push((id, start, end));
        }
    }

    let mut out = Vec::new();
    for (id, start, end) in jobs {
        let Ok(entity) = decoder.decode_at_with_id(id, start, end) else {
            continue;
        };
        let ifc_type = entity.ifc_type;
        let produced = produce_element_meshes(
            &ElementMeshJob {
                id,
                ifc_type,
                entity: &entity,
                kind: ElementJobKind::Product,
                element_color: None,
                metadata: None,
            },
            &ctx,
            &opts,
            &mut decoder,
            &router,
        );
        out.push((id, produced));
    }
    out
}

fn cfg(rtc: [f64; 3]) -> Option<GeometryHashConfig> {
    Some(GeometryHashConfig {
        tolerance: ifc_lite_geometry::DEFAULT_GEOM_HASH_TOLERANCE,
        world_rtc: rtc,
    })
}

/// The reported box must contain every produced world vertex, and must be tight
/// against them on both ends of every axis.
///
/// A slack bound would pass on a box that is merely "big enough" — including
/// one accumulated from a wrong frame that happens to be larger. The tolerance
/// here is the `f32` storage step at this model's magnitude, nothing more: the
/// hasher reads pre-weld positions and `build_mesh_data` may drop degenerate
/// triangles afterwards, so the box may legitimately be a hair LARGER than the
/// surviving mesh, never smaller.
#[test]
fn reported_aabb_is_the_tight_world_extent_of_the_produced_meshes() {
    let Some(content) = read_fixture() else { return };
    let index = Arc::new(build_entity_index(&content));

    let mut checked = 0usize;
    for (id, produced) in produce_all(&content, &index, cfg([0.0; 3]), [0.0; 3]) {
        let Some(aabb) = produced.geometry_aabb else {
            continue;
        };
        assert!(
            produced.geometry_hash.is_some(),
            "#{id}: a box without a fingerprint would misalign the parallel FFI arrays"
        );

        let mut mn = [f64::INFINITY; 3];
        let mut mx = [f64::NEG_INFINITY; 3];
        let mut verts = 0usize;
        for m in &produced.meshes {
            for v in m.positions.chunks_exact(3) {
                verts += 1;
                for k in 0..3 {
                    let w = v[k] as f64 + m.origin[k];
                    mn[k] = mn[k].min(w);
                    mx[k] = mx[k].max(w);
                }
            }
        }
        if verts == 0 {
            continue;
        }

        // 1e-3 m: comfortably above the f32 step at this model's ~100 m scale
        // (~8e-6 m) and below any real geometric difference.
        const TOL: f64 = 1.0e-3;
        for k in 0..3 {
            assert!(
                aabb[k] <= mn[k] + TOL,
                "#{id} axis {k}: reported min {} is INSIDE the mesh min {} — the box \
                 would clip real geometry",
                aabb[k],
                mn[k]
            );
            assert!(
                aabb[k] >= mn[k] - TOL,
                "#{id} axis {k}: reported min {} is far below the mesh min {} — the box \
                 is not tight, so a move of that size would read as no move",
                aabb[k],
                mn[k]
            );
            assert!(
                aabb[3 + k] >= mx[k] - TOL,
                "#{id} axis {k}: reported max {} is INSIDE the mesh max {}",
                aabb[3 + k],
                mx[k]
            );
            assert!(
                aabb[3 + k] <= mx[k] + TOL,
                "#{id} axis {k}: reported max {} is far above the mesh max {}",
                aabb[3 + k],
                mx[k]
            );
        }
        checked += 1;
    }

    assert!(
        checked > 100,
        "only {checked} elements carried a box — the fixture or the hashing switch \
         regressed, so the bounds assertions above proved nothing"
    );
}

/// The box is in WORLD coordinates: a file that shifted its geometry by an RTC
/// offset and reports that offset must produce the SAME box as the unshifted
/// file. Without the fold-back, the diff engine would read every element of a
/// georeferenced revision as moved by the whole RTC.
///
/// RTC is TWO cooperating halves and the invariant is that they cancel:
/// `GeometryRouter::set_rtc_offset` makes the pipeline emit `world - rtc`, and
/// `GeometryHashConfig::world_rtc` makes the hasher add `rtc` back. Configuring
/// only the hasher (as the first version of this test did) leaves the geometry
/// standing still and reduces the assertion to "adding rtc adds rtc" — it
/// survives deleting the pipeline half outright, which is exactly the shape of
/// a test that cannot fail. Both knobs are set here, so the shifted run must
/// reproduce the unshifted box, and killing EITHER half moves every box by the
/// whole offset.
#[test]
fn reported_aabb_is_rtc_invariant() {
    let Some(content) = read_fixture() else { return };
    let index = Arc::new(build_entity_index(&content));

    let plain: FxHashMap<u32, [f64; 6]> = produce_all(&content, &index, cfg([0.0; 3]), [0.0; 3])
        .into_iter()
        .filter_map(|(id, p)| p.geometry_aabb.map(|a| (id, a)))
        .collect();
    let shift = [1234.5_f64, -678.25, 90.125];
    let shifted: FxHashMap<u32, [f64; 6]> = produce_all(&content, &index, cfg(shift), shift)
        .into_iter()
        .filter_map(|(id, p)| p.geometry_aabb.map(|a| (id, a)))
        .collect();

    assert!(plain.len() > 100, "expected the fixture's elements, got {}", plain.len());
    assert_eq!(plain.len(), shifted.len(), "the RTC must not change WHICH elements report");

    // The shifted run stores its vertices as `f32` around a ~1300 m world
    // magnitude, where one ULP is ~1.2e-4 m; the unshifted run sits at ~100 m.
    // 1e-3 m is that storage step with headroom and nothing more — a dropped
    // fold-back would miss by the offset itself (hundreds of metres).
    const TOL: f64 = 1.0e-3;
    for (id, a) in &plain {
        let b = shifted.get(id).unwrap_or_else(|| panic!("#{id} missing from the shifted run"));
        for k in 0..3 {
            assert!(
                (b[k] - a[k]).abs() < TOL && (b[3 + k] - a[3 + k]).abs() < TOL,
                "#{id} axis {k}: RTC-shifted box {b:?} is not the unshifted box {a:?} — \
                 the file's RTC choice leaked into the reported WORLD box, so every \
                 element of a georeferenced revision would read as moved by {shift:?}"
            );
        }
    }
}

/// The box rides the SAME switch as the fingerprint: with hashing off, nothing
/// is accumulated. Compare mode already costs GPU instancing (see
/// `gpu_meshes/batch.rs`), so this pass must not run when the feature is off.
#[test]
fn no_aabb_when_hashing_is_off() {
    let Some(content) = read_fixture() else { return };
    let index = Arc::new(build_entity_index(&content));
    let produced = produce_all(&content, &index, None, [0.0; 3]);
    assert!(!produced.is_empty(), "fixture produced no elements");
    for (id, p) in produced {
        assert!(
            p.geometry_aabb.is_none() && p.geometry_hash.is_none(),
            "#{id}: hashing is off, so neither fingerprint nor box may be computed"
        );
    }
}
