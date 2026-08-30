// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #1623: multi-item mapped sources with per-occurrence `MappingTarget`s.
//!
//! Phase 2's don't-bake path only instances SINGLE-solid `IfcRepresentationMap`s;
//! MULTI-item sources (Tekla assemblies, multi-part MEP, metering skids) fall through
//! to the normal flat materialize. Before this fix the flat path RE-HASHED each
//! occurrence's post-`MappingTarget` geometry into `rep_identity`, so every distinct
//! target got a unique id — collation (GLB export #1443, which composes
//! `local_transform`) saw N singletons and rendered the whole class flat.
//!
//! The fix records the per-occurrence target in `InstanceMeta.local_transform` and
//! keeps the canonical, pre-target content hash as `rep_identity`, so occurrences that
//! share a map but differ only by target collate under ONE template per source solid.
//! This test drives the REAL pipeline on a 2-solid map instanced four times with four
//! distinct targets and proves: (1) the occurrences collate into two shared templates
//! (one per source solid, four occurrences each), (2) each keeps its own target in
//! `local_transform`, and (3) the template-relative transform collate/GLB export would
//! compute reproduces every occurrence's baked world triangles.

use ifc_lite_geometry::{compose_instance_world_row_major, instance_rel_row_major_f32};
use ifc_lite_processing::{
    process_geometry_streaming_filtered_with_options, MeshData, OpeningFilterMode,
    ProcessingResult, StreamingOptions,
};
use rustc_hash::FxHashMap;

fn fixture_bytes(name: &str) -> Vec<u8> {
    let path = format!(
        "{}/../geometry/tests/fixtures/{name}",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"))
}

fn run(content: &[u8]) -> ProcessingResult {
    process_geometry_streaming_filtered_with_options(
        content,
        OpeningFilterMode::Default,
        StreamingOptions::default(),
        |_, _, _| {},
        |_| {},
        |_| {},
    )
}

/// World vertices of a mesh = `origin + position` per vertex (the renderer's
/// reconstruction), as an `f64` triple list.
fn world_vertices(m: &MeshData) -> Vec<[f64; 3]> {
    let n = m.positions.len() / 3;
    (0..n)
        .map(|v| {
            [
                m.origin[0] + m.positions[v * 3] as f64,
                m.origin[1] + m.positions[v * 3 + 1] as f64,
                m.origin[2] + m.positions[v * 3 + 2] as f64,
            ]
        })
        .collect()
}

/// Apply a row-major mat4 to a homogeneous point (perspective divided).
fn apply(t: &[f32; 16], p: [f64; 3]) -> [f64; 3] {
    let (x, y, z) = (p[0], p[1], p[2]);
    let wx = t[0] as f64 * x + t[1] as f64 * y + t[2] as f64 * z + t[3] as f64;
    let wy = t[4] as f64 * x + t[5] as f64 * y + t[6] as f64 * z + t[7] as f64;
    let wz = t[8] as f64 * x + t[9] as f64 * y + t[10] as f64 * z + t[11] as f64;
    let ww = t[12] as f64 * x + t[13] as f64 * y + t[14] as f64 * z + t[15] as f64;
    [wx / ww, wy / ww, wz / ww]
}

fn max_vertex_error(a: &[[f64; 3]], b: &[[f64; 3]]) -> f64 {
    assert_eq!(
        a.len(),
        b.len(),
        "vertex count mismatch ({} vs {})",
        a.len(),
        b.len()
    );
    a.iter()
        .zip(b)
        .map(|(p, q)| ((p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2) + (p[2] - q[2]).powi(2)).sqrt())
        .fold(0.0f64, f64::max)
}

#[test]
fn multi_item_mapped_per_occurrence_target_collates_under_shared_template() {
    let bytes = fixture_bytes("mapped_instances_multi_item.ifc");
    let res = run(&bytes);

    // Instanceable meshes carrying always-on InstanceMeta, grouped by rep_identity.
    let mut groups: FxHashMap<u128, Vec<&MeshData>> = FxHashMap::default();
    for m in &res.meshes {
        if m.positions.is_empty() {
            continue;
        }
        if let Some(im) = m.instance.as_ref() {
            if im.instanceable {
                groups.entry(im.rep_identity).or_default().push(m);
            }
        }
    }

    // Two distinct source solids ⇒ two templates. Before the fix each of the eight
    // sub-meshes carried a UNIQUE (re-hashed) rep_identity, so there were eight
    // singleton "groups" and nothing collated.
    assert_eq!(
        groups.len(),
        2,
        "expected 2 rep_identity templates (one per source solid), got {} — the \
         per-occurrence-target re-hash was not removed",
        groups.len()
    );

    // Near-origin model ⇒ no RTC; the reconstruction below composes in the pre-RTC
    // frame with rtc = 0. Guard the assumption.
    for m in &res.meshes {
        assert!(
            m.origin.iter().all(|c| c.abs() < 1.0),
            "unexpected RTC origin {:?}; reconstruction assumes rtc = 0",
            m.origin
        );
    }
    let rtc = [0.0f64; 3];
    let tol = 1e-4; // model metres; f32 recompose at ~35 m coordinates.

    for (rep, occ) in &groups {
        assert_eq!(
            occ.len(),
            4,
            "rep_identity {rep:#x}: expected 4 collated occurrences, got {}",
            occ.len()
        );

        // Each occurrence keeps its own per-occurrence MappingTarget in local_transform
        // (the fix), and the four targets are distinct (four distinct placements under
        // ONE shared template — not four unique templates).
        let mut seen: Vec<[f64; 16]> = Vec::new();
        for m in occ {
            let lt = m
                .instance
                .as_ref()
                .unwrap()
                .local_transform
                .unwrap_or_else(|| {
                    panic!(
                        "rep_identity {rep:#x}: occurrence {} lost its MappingTarget \
                         (local_transform = None)",
                        m.express_id
                    )
                });
            assert!(
                !seen.iter().any(|s| s == &lt),
                "rep_identity {rep:#x}: two occurrences share a local_transform — the \
                 distinct per-occurrence targets were not recorded"
            );
            seen.push(lt);
        }

        // Correctness: collating these occurrences is geometrically valid. Take
        // occurrence 0 as the template; the template-relative transform that
        // `collate_refs` / GLB export (#1443) would compute reproduces every other
        // occurrence's baked world triangles.
        let reference = occ[0];
        let m_ref = compose_instance_world_row_major(reference.instance.as_ref().unwrap());
        let ref_world = world_vertices(reference);
        for m in &occ[1..] {
            let m_k = compose_instance_world_row_major(m.instance.as_ref().unwrap());
            let rel = instance_rel_row_major_f32(&m_k, &m_ref, rtc)
                .expect("degenerate reference placement");
            let recomposed: Vec<[f64; 3]> = ref_world.iter().map(|&p| apply(&rel, p)).collect();
            let err = max_vertex_error(&recomposed, &world_vertices(m));
            assert!(
                err < tol,
                "rep_identity {rep:#x}: occurrence {} world-vertex error {err:.3e} m exceeds {tol:.0e}",
                m.express_id
            );
        }
    }
}

#[test]
fn nested_mapped_composes_outer_and_inner_targets() {
    // A nested map (outer RepresentationMap whose MappedRepresentation is itself an
    // IfcMappedItem over an inner map) exercises the `Some(inner)` compose branch:
    // `local_transform = outer_target · inner_target`, matching the innermost-first
    // vertex bake order. The outer targets here are 90-deg-about-Z ROTATIONS and the
    // inner target is a translation; rotation and translation do NOT commute, so a
    // reversed compose order (`inner · outer`) would fail the world-vertex check.
    let bytes = fixture_bytes("mapped_instances_nested.ifc");
    let res = run(&bytes);

    let mut groups: FxHashMap<u128, Vec<&MeshData>> = FxHashMap::default();
    for m in &res.meshes {
        if m.positions.is_empty() {
            continue;
        }
        if let Some(im) = m.instance.as_ref() {
            if im.instanceable {
                groups.entry(im.rep_identity).or_default().push(m);
            }
        }
    }

    // One source solid, three nested occurrences ⇒ one template of three.
    assert_eq!(
        groups.len(),
        1,
        "expected 1 rep_identity template (single nested source solid), got {}",
        groups.len()
    );
    for m in &res.meshes {
        assert!(
            m.origin.iter().all(|c| c.abs() < 1.0),
            "unexpected RTC origin {:?}; reconstruction assumes rtc = 0",
            m.origin
        );
    }
    let rtc = [0.0f64; 3];
    let tol = 1e-4;

    let occ = groups.values().next().unwrap();
    assert_eq!(occ.len(), 3, "expected 3 nested occurrences, got {}", occ.len());

    // Every occurrence records a composed target; the three are distinct.
    let mut seen: Vec<[f64; 16]> = Vec::new();
    for m in occ {
        let lt = m
            .instance
            .as_ref()
            .unwrap()
            .local_transform
            .expect("nested occurrence lost its composed MappingTarget");
        assert!(
            !seen.iter().any(|s| s == &lt),
            "two nested occurrences share a composed local_transform"
        );
        seen.push(lt);
    }
    // The rotated outer targets must actually leave a rotation in the composed
    // transform (not just translation): at least one local_transform has an
    // off-diagonal rotation term. Guards against a translation-only compose slipping
    // through the reconstruction tolerance.
    assert!(
        seen.iter().any(|lt| lt[1].abs() > 0.5 || lt[4].abs() > 0.5),
        "no composed local_transform carries the outer rotation"
    );

    // Correctness incl. compose ORDER: reconstruct every occurrence from occurrence 0.
    let reference = occ[0];
    let m_ref = compose_instance_world_row_major(reference.instance.as_ref().unwrap());
    let ref_world = world_vertices(reference);
    for m in &occ[1..] {
        let m_k = compose_instance_world_row_major(m.instance.as_ref().unwrap());
        let rel = instance_rel_row_major_f32(&m_k, &m_ref, rtc)
            .expect("degenerate reference placement");
        let recomposed: Vec<[f64; 3]> = ref_world.iter().map(|&p| apply(&rel, p)).collect();
        let err = max_vertex_error(&recomposed, &world_vertices(m));
        assert!(
            err < tol,
            "nested occurrence {} world-vertex error {err:.3e} m exceeds {tol:.0e}",
            m.express_id
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// #2985: the originating representation item rides the instanced shard.
// ─────────────────────────────────────────────────────────────────────────────

/// The two source solids under the shared `IfcRepresentationMap` #18 in
/// `mapped_instances_multi_item.ifc`. These are what a host drilling from a
/// rendered instanced piece must land on.
const SOLID_A: u32 = 11;
const SOLID_B: u32 = 15;
/// The ids the field must NOT hold: the four `IfcBuildingElementProxy` products,
/// the four `IfcMappedItem`s, and the `IfcRepresentationMap` itself. Each is a
/// plausible wrong wiring that a "the id is present and non-zero" assertion alone
/// would accept.
const PRODUCTS: [u32; 4] = [40, 47, 54, 61];
const MAPPED_ITEMS: [u32; 4] = [34, 41, 48, 55];
const REPRESENTATION_MAP: u32 = 18;
/// Occurrences of each source solid in the fixture — the group size the assertions
/// below expect, and the `min_group` this test passes to `collate_and_encode`
/// itself. NOT the production instancing threshold: that is
/// `INSTANCE_MIN_OCCURRENCES` in the wasm-only `batch_partition.rs`, and the
/// routing it gates is covered end to end by the `scripts/test-wasm-contract.mjs`
/// case named below. What this test needs from `min_group` is only that the two
/// groups instance rather than fall to singletons.
const OCCURRENCES_PER_SOLID: usize = 4;

/// WHAT THIS COVERS, exactly: `element.rs` → `MeshData::geometry_item_id` →
/// encoder → decoder, on real pipeline output, with the ids pinned to the two
/// source solids and a negative set that rejects every id that would look right
/// at a glance.
///
/// WHAT IT DOES NOT COVER: the production wiring. It builds its own
/// `InstanceMeshRef`s, because `process_geometry_batch_partitioned` is
/// `wasm_bindgen`-only and cannot run natively — so a wrong-field or
/// wrong-discriminator bug in `rust/wasm-bindings/src/api/gpu_meshes/batch.rs`,
/// which is exactly where such a bug would live, leaves this test green.
/// `scripts/test-wasm-contract.mjs` ("the partitioned shard carries each
/// occurrence's representation item") runs the real export and reads the ids out
/// of the shard bytes; it covers that boundary and cannot assert exact STEP ids
/// against a negative set, which is why both exist.
#[test]
fn instanced_occurrences_carry_their_source_solid_item_id() {
    let bytes = fixture_bytes("mapped_instances_multi_item.ifc");
    let res = run(&bytes);

    let non_empty: Vec<&MeshData> = res.meshes.iter().filter(|m| !m.positions.is_empty()).collect();
    let refs: Vec<ifc_lite_geometry::InstanceMeshRef> = non_empty
        .iter()
        .map(|m| ifc_lite_geometry::InstanceMeshRef {
            positions: &m.positions,
            normals: &m.normals,
            indices: &m.indices,
            origin: m.origin,
            instance_meta: m.instance.as_ref(),
            entity_id: m.express_id,
            color: m.color,
            item_id: m.geometry_item_id,
        })
        .collect();
    let shard = ifc_lite_geometry::collate_and_encode(
        &refs,
        OCCURRENCES_PER_SOLID,
        [0.0, 0.0, 0.0],
    );
    let decoded = ifc_lite_geometry::decode_instanced(&shard).expect("decode IFNS shard");

    // Two source solids, four occurrences each: genuinely instanced (not a pile
    // of singleton templates that would carry item ids for a different reason).
    assert_eq!(
        decoded.templates.len(),
        2,
        "expected one template per source solid, got {}",
        decoded.templates.len()
    );
    assert_eq!(decoded.instances.len(), 2 * OCCURRENCES_PER_SOLID);

    let mut items: Vec<u32> = decoded
        .instances
        .iter()
        .map(|i| {
            i.item_id.unwrap_or_else(|| {
                panic!(
                    "occurrence of #{} carries NO item id — the id was computed and dropped",
                    i.entity_id
                )
            })
        })
        .collect();
    items.sort_unstable();
    // NOT deduped on purpose. Dedup would drop multiplicity, and the property
    // this pins is the DISTRIBUTION: four occurrences per source solid. With a
    // dedup the test passes on seven SOLID_A and one SOLID_B, which is exactly
    // the mis-grouping a per-item identity bug produces.
    assert_eq!(
        items,
        [
            vec![SOLID_A; OCCURRENCES_PER_SOLID],
            vec![SOLID_B; OCCURRENCES_PER_SOLID]
        ]
        .concat(),
        "item ids must be {OCCURRENCES_PER_SOLID} each of the two source solids \
         #{SOLID_A}/#{SOLID_B}, got {items:?}"
    );

    // Negative: every id that would look right at a glance. A field wired to the
    // product (the obvious mistake — the occurrence's OWN express id is right
    // there in the same struct), to the IfcMappedItem, or to the shared map
    // fails here while still being "present and non-zero".
    for inst in &decoded.instances {
        let item = inst.item_id.expect("checked above");
        assert!(
            !PRODUCTS.contains(&item),
            "item id {item} is a product express id, not a representation item"
        );
        assert!(
            !MAPPED_ITEMS.contains(&item),
            "item id {item} is an IfcMappedItem id, not the solid it maps"
        );
        assert_ne!(
            item, REPRESENTATION_MAP,
            "item id is the shared IfcRepresentationMap, not the per-item solid"
        );
        // The occurrence id and the item id are different questions; a shard where
        // they coincide has one of them wired to the other.
        assert_ne!(item, inst.entity_id);
    }

    // Disjointness (rust/wasm-bindings/src/zero_copy/mesh.rs asserts the same on
    // the flat path): the id a mesh contributes to the shard is a representation
    // item, so its material_id must be empty.
    for m in &non_empty {
        assert!(
            m.geometry_item_id.is_none() || m.material_id.is_none(),
            "mesh of #{} carries BOTH geometry_item_id {:?} and material_id {:?}",
            m.express_id,
            m.geometry_item_id,
            m.material_id
        );
    }
}
