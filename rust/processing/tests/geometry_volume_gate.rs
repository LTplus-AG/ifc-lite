// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `produce_element_meshes` must hand back a per-element VOLUME only where the
//! mesher proved the geometry is a single closed orientable solid (#1891), and
//! nothing at all elsewhere.
//!
//! The unit tests in `geom_hash_tests.rs` pin the arithmetic on a synthetic
//! cube. What they cannot exercise is the thing that made this hard: on the real
//! production path an element arrives as many sub-meshes through
//! `emit_sub_meshes`, each in its own local frame, each separately oriented, and
//! the gate has to be applied to the right one. So these run against fixture
//! geometry and assert the two properties that would catch a wrong number
//! without needing a ground-truth volume to compare against:
//!
//!  * no element may report a volume larger than its OWN bounding box — that is
//!    geometrically impossible, and it is exactly what a summed-over-overlapping
//!    -items volume does (987 elements across the corpus, before the gate);
//!  * the gate must still admit the bulk of the model (70 of this fixture's 107
//!    elements with geometry), or "correct" would have been achieved by
//!    refusing everything — and each of the three refusal reasons must actually
//!    occur, so no clause is dead.

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
                "skipping geometry-volume gate test: fixture missing at {FIXTURE} — \
                 run `pnpm fixtures` (sha256 in tests/models/manifest.json)"
            );
            None
        }
        Err(e) => panic!("failed to read fixture {FIXTURE}: {e}"),
    }
}

fn produce_all(
    content: &[u8],
    index: &Arc<ifc_lite_core::EntityIndex>,
    hash: Option<GeometryHashConfig>,
) -> Vec<(u32, ProducedElementMeshes)> {
    let router = GeometryRouter::with_scale(1.0);
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
        out.push((
            id,
            produce_element_meshes(
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
            ),
        ));
    }
    out
}

fn cfg(rtc: [f64; 3]) -> Option<GeometryHashConfig> {
    Some(GeometryHashConfig {
        tolerance: ifc_lite_geometry::DEFAULT_GEOM_HASH_TOLERANCE,
        world_rtc: rtc,
    })
}

fn box_volume(a: &[f64; 6]) -> f64 {
    (a[3] - a[0]).max(0.0) * (a[4] - a[1]).max(0.0) * (a[5] - a[2]).max(0.0)
}

/// The load-bearing property, checked on every element the gate admits: a solid
/// cannot enclose more than its own bounding box. This is the single assertion
/// that a summed-over-items volume fails — it fired on 987 elements across the
/// fixture corpus when the multi-segment sum was allowed — and it needs no
/// ground truth to evaluate.
///
/// It also checks the other end: a volume must be POSITIVE and not absurdly
/// small relative to the box, so a gate that started emitting zeros would fail
/// here rather than pass by being harmlessly tiny.
#[test]
fn no_reported_volume_exceeds_its_own_bounding_box() {
    let Some(content) = read_fixture() else { return };
    let index = Arc::new(build_entity_index(&content));

    let mut with_volume = 0usize;
    let mut without_volume = 0usize;
    let mut boxlike = 0usize;
    let mut refused_open = 0usize;
    let mut refused_multi_segment = 0usize;
    let mut refused_multi_component = 0usize;
    for (id, p) in produce_all(&content, &index, cfg([0.0; 3])) {
        let Some(closure) = p.geometry_closure else {
            assert!(
                p.geometry_volume.is_none(),
                "#{id}: a volume without a closure verdict means the gate was bypassed"
            );
            continue;
        };
        let Some(volume) = p.geometry_volume else {
            without_volume += 1;
            if !closure.all_closed { refused_open += 1; }
            if closure.segments > 1 { refused_multi_segment += 1; }
            if !closure.all_single_component { refused_multi_component += 1; }
            assert!(
                !closure.is_trustworthy_solid(),
                "#{id}: the verdict says this IS a single closed solid, so a volume was owed"
            );
            continue;
        };
        with_volume += 1;
        assert!(
            closure.is_trustworthy_solid() && closure.bits() == 0b1111,
            "#{id}: a volume shipped with flags {:#06b} — the flags must agree with the gate",
            closure.bits()
        );
        assert!(
            volume > 0.0 && volume.is_finite(),
            "#{id}: reported a non-positive / non-finite volume {volume}"
        );

        let aabb = p
            .geometry_aabb
            .unwrap_or_else(|| panic!("#{id}: a volume without a box"));
        let bv = box_volume(&aabb);
        // 1e-6 relative slack: the box is built from the same corners, so an
        // axis-aligned solid lands on the box EXACTLY; the slack only absorbs
        // f64 rounding, not a real over-count.
        assert!(
            volume <= bv * (1.0 + 1e-6) + 1e-12,
            "#{id}: volume {volume} exceeds its own AABB volume {bv} — impossible for a solid, \
             so the gate let through a sum over overlapping pieces"
        );
        if bv > 1e-9 && (volume / bv - 1.0).abs() < 1e-4 {
            boxlike += 1;
        }
    }

    // This fixture yields 107 elements with geometry: 70 pass the gate, 37 do
    // not. The floors sit under those, loose enough to survive a tessellation
    // change and tight enough that a gate stuck open or shut fails here.
    assert!(
        with_volume >= 50,
        "only {with_volume} elements reported a volume — the gate refuses (almost) everything, \
         which passes the impossibility assertion above for the wrong reason"
    );
    assert!(
        without_volume >= 20,
        "only {without_volume} elements were refused — the gate is not gating, so the open / \
         multi-item cases it exists to refuse are getting numbers anyway"
    );
    // Each clause must actually fire on real geometry, not just on the unit
    // tests' synthetic verdicts. If a clause stops matching anything, the gate
    // has silently widened and only these counts would notice.
    assert!(
        refused_open >= 1 && refused_multi_segment >= 1 && refused_multi_component >= 1,
        "the three refusal reasons must all occur in this fixture, got open={refused_open} \
         multi_segment={refused_multi_segment} multi_component={refused_multi_component}"
    );
    // Walls, slabs and openings in this fixture are axis-aligned boxes, whose
    // true volume IS their AABB volume. Their agreeing to 1e-4 is a real check
    // of the arithmetic against fixture geometry, not just an inequality.
    assert!(
        boxlike >= 10,
        "only {boxlike} elements matched their bounding box exactly; this fixture is full of \
         axis-aligned boxes, so the divergence sum is not reproducing their known volume"
    );
}

/// Volume is a property of the shape, not of where the file put it. A revision
/// that chose a different RTC offset must report the SAME volume — otherwise a
/// quantity-conservation check across two revisions would fire on every element
/// of a georeferenced model.
#[test]
fn reported_volume_is_rtc_invariant() {
    let Some(content) = read_fixture() else { return };
    let index = Arc::new(build_entity_index(&content));

    let plain: FxHashMap<u32, f64> = produce_all(&content, &index, cfg([0.0; 3]))
        .into_iter()
        .filter_map(|(id, p)| p.geometry_volume.map(|v| (id, v)))
        .collect();
    let shifted: FxHashMap<u32, f64> = produce_all(&content, &index, cfg([412_000.5, -5_310_000.25, 90.125]))
        .into_iter()
        .filter_map(|(id, p)| p.geometry_volume.map(|v| (id, v)))
        .collect();

    assert!(plain.len() >= 50, "expected the fixture's elements, got {}", plain.len());
    assert_eq!(
        plain.len(),
        shifted.len(),
        "the RTC must not change WHICH elements are trusted with a volume"
    );
    for (id, v) in &plain {
        let s = shifted
            .get(id)
            .unwrap_or_else(|| panic!("#{id} missing from the shifted run"));
        assert!(
            (s - v).abs() <= v.abs() * 1e-9,
            "#{id}: volume moved from {v} to {s} under a 5,000 km RTC shift — the accumulator \
             is referencing the world origin instead of the geometry"
        );
    }
}

/// The volume rides the SAME switch as the fingerprint. Compare mode already
/// costs GPU instancing, so nothing here may run when the feature is off.
#[test]
fn no_volume_when_hashing_is_off() {
    let Some(content) = read_fixture() else { return };
    let index = Arc::new(build_entity_index(&content));
    let produced = produce_all(&content, &index, None);
    assert!(!produced.is_empty(), "fixture produced no elements");
    for (id, p) in produced {
        assert!(
            p.geometry_volume.is_none() && p.geometry_closure.is_none(),
            "#{id}: hashing is off, so neither volume nor closure verdict may be computed"
        );
    }
}
