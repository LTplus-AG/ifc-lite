// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #1623 Phase 3 BROWSER "don't-bake" byte-identity gate (batch-local mode).
//!
//! Phase 2 proved the NATIVE global-template don't-bake path. Phase 3 wires the
//! browser (wasm) partitioned path, which selects the template PER BATCH (the
//! first occurrence a batch sees) instead of a model-wide min-id, and emits the
//! non-template occurrences into the IFNS shard via `collate_refs` fed
//! EMPTY-geometry occurrence refs. This test exercises that exact browser path on
//! real fixture geometry WITHOUT wasm:
//!
//!   * flat run   — a router with no plan; every occurrence materializes.
//!   * batch-local run — ONE router (as a wasm batch has) armed in BATCH-LOCAL
//!     don't-bake mode; the first occurrence of the shared source materializes as
//!     the template, the rest emit `RawInstanceOccurrence`s. Those are collated the
//!     same way `process_geometry_batch_partitioned` does (empty-geometry
//!     `InstanceMeshRef`s → `collate_refs`).
//!
//! It then proves the collated shard recomposes to the flat run's WORLD TRIANGLES
//! within a micrometre, and that far fewer occurrences materialized.

use ifc_lite_core::{build_entity_index, has_geometry_by_name, EntityDecoder, EntityScanner};
use ifc_lite_geometry::{collate_refs, GeometryRouter, InstanceMeshRef, InstanceMeta};
use ifc_lite_processing::element::{
    produce_element_meshes, ElementJobKind, ElementMeshJob, MeshProductionContext,
    MeshProductionOptions,
};
use ifc_lite_processing::MeshData;
use rustc_hash::FxHashMap;
use std::sync::Arc;

/// A geometry element job: `(express_id, byte_start, byte_end)`.
type Job = (u32, usize, usize);
/// The #1623 don't-bake plan: RepresentationMap id ⇒ `(occurrence_count, min-id)`.
type Plan = FxHashMap<u32, (u32, u32)>;

fn synthetic_bytes() -> Vec<u8> {
    let path = format!(
        "{}/../geometry/tests/fixtures/mapped_instances_synthetic.ifc",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"))
}

/// Scan the file for (a) geometry element jobs and (b) the #1623 don't-bake plan
/// (RepresentationMap source ids an IfcMappedItem instantiates >= 2x) — the exact
/// data the wasm pre-pass ships to workers, computed here inline via the decoder
/// (IfcMappedItem.MappingSource = attribute 0), exactly as the pre-pass does.
fn scan(
    content: &[u8],
    index: &Arc<ifc_lite_core::EntityIndex>,
) -> (Vec<Job>, Plan) {
    let mut jobs: Vec<(u32, usize, usize)> = Vec::new();
    let mut counts: FxHashMap<u32, (u32, u32)> = FxHashMap::default();
    let mut decoder = EntityDecoder::with_arc_index(content, index.clone());
    let mut scanner = EntityScanner::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if type_name == "IFCMAPPEDITEM" {
            if let Ok(ent) = decoder.decode_at_with_id(id, start, end) {
                if let Some(src) = ent.get_ref(0) {
                    counts
                        .entry(src)
                        .and_modify(|(c, t)| {
                            *c += 1;
                            if id < *t {
                                *t = id;
                            }
                        })
                        .or_insert((1, id));
                }
            }
        } else if has_geometry_by_name(type_name) {
            jobs.push((id, start, end));
        }
    }
    let plan: FxHashMap<u32, (u32, u32)> =
        counts.into_iter().filter(|(_, (c, _))| *c >= 2).collect();
    (jobs, plan)
}

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

fn apply(t: &[f32; 16], p: [f64; 3]) -> [f64; 3] {
    let (x, y, z) = (p[0], p[1], p[2]);
    let wx = t[0] as f64 * x + t[1] as f64 * y + t[2] as f64 * z + t[3] as f64;
    let wy = t[4] as f64 * x + t[5] as f64 * y + t[6] as f64 * z + t[7] as f64;
    let wz = t[8] as f64 * x + t[9] as f64 * y + t[10] as f64 * z + t[11] as f64;
    let ww = t[12] as f64 * x + t[13] as f64 * y + t[14] as f64 * z + t[15] as f64;
    [wx / ww, wy / ww, wz / ww]
}

fn max_err(a: &[[f64; 3]], b: &[[f64; 3]]) -> f64 {
    assert_eq!(a.len(), b.len(), "vertex count mismatch ({} vs {})", a.len(), b.len());
    a.iter()
        .zip(b)
        .map(|(p, q)| ((p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2) + (p[2] - q[2]).powi(2)).sqrt())
        .fold(0.0f64, f64::max)
}

/// Run every job through the canonical producer with the given router, returning
/// (materialized meshes, collected don't-bake occurrences).
fn produce(
    content: &[u8],
    index: &Arc<ifc_lite_core::EntityIndex>,
    jobs: &[Job],
    router: &GeometryRouter,
) -> (Vec<MeshData>, Vec<ifc_lite_processing::RawInstanceOccurrence>) {
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
    let opts = MeshProductionOptions::default();
    let mut meshes = Vec::new();
    let mut occ = Vec::new();
    for &(id, start, end) in jobs {
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
            router,
        );
        meshes.extend(produced.meshes);
        occ.extend(produced.instance_occurrences);
    }
    (meshes, occ)
}

#[test]
fn browser_batch_local_instanced_equals_flat_synthetic() {
    let content = synthetic_bytes();
    let index = Arc::new(build_entity_index(&content));
    let (jobs, plan) = scan(&content, &index);
    assert!(!plan.is_empty(), "fixture has no repeated mapped source");

    // Flat baseline: no plan ⇒ every occurrence materializes.
    let flat_router = GeometryRouter::with_scale(1.0);
    let (flat_meshes, flat_occ) = produce(&content, &index, &jobs, &flat_router);
    assert!(flat_occ.is_empty(), "flat run must not emit don't-bake occurrences");
    let mut flat_by_id: FxHashMap<u32, Vec<[f64; 3]>> = FxHashMap::default();
    for m in &flat_meshes {
        if m.geometry_class == 0 && !m.positions.is_empty() {
            flat_by_id.entry(m.express_id).or_insert_with(|| world_vertices(m));
        }
    }

    // Browser batch-local run: ONE router (as a wasm batch has), armed batch-local.
    let mut bl_router = GeometryRouter::with_scale(1.0);
    bl_router.enable_shared_mapped_item_cache(GeometryRouter::new_mapped_item_cache());
    bl_router.enable_output_instancing(Arc::new(plan));
    bl_router.set_instancing_batch_local(true);
    let (bl_meshes, bl_occ) = produce(&content, &index, &jobs, &bl_router);
    assert!(!bl_occ.is_empty(), "batch-local run emitted no don't-bake occurrences");

    // Collate EXACTLY as process_geometry_batch_partitioned does: materialized
    // instanceable meshes as real refs + occurrences as empty-geometry refs.
    let occ_metas: Vec<InstanceMeta> = bl_occ
        .iter()
        .map(|o| InstanceMeta {
            transform: o.world_transform,
            local_transform: None,
            canonical_transform: None,
            rep_identity: o.rep_identity,
            instanceable: true,
        })
        .collect();
    let mut refs: Vec<InstanceMeshRef> = bl_meshes
        .iter()
        .map(|m| InstanceMeshRef {
            positions: &m.positions,
            normals: &m.normals,
            indices: &m.indices,
            origin: m.origin,
            instance_meta: m.instance.as_ref(),
            entity_id: m.express_id,
            color: m.color,
        })
        .collect();
    for (o, meta) in bl_occ.iter().zip(occ_metas.iter()) {
        refs.push(InstanceMeshRef {
            positions: &[],
            normals: &[],
            indices: &[],
            origin: [0.0, 0.0, 0.0],
            instance_meta: Some(meta),
            entity_id: o.express_id,
            color: o.color,
        });
    }
    let collated = collate_refs(&refs, 2, [0.0, 0.0, 0.0]);
    assert!(!collated.templates.is_empty(), "no instanced template formed");

    // Every occurrence (incl. the template's own) recomposes to its flat world verts.
    let tol = 1e-6;
    let mut checked = 0usize;
    for tmpl in &collated.templates {
        let template_world = world_vertices(&bl_meshes[tmpl.template_index]);
        for o in &tmpl.occurrences {
            let entity_id = refs[o.mesh_index].entity_id;
            let flat_world = flat_by_id
                .get(&entity_id)
                .unwrap_or_else(|| panic!("occurrence {entity_id} has no flat counterpart"));
            let recomposed: Vec<[f64; 3]> =
                template_world.iter().map(|&p| apply(&o.transform, p)).collect();
            let err = max_err(&recomposed, flat_world);
            assert!(err < tol, "occurrence {entity_id}: world-vertex error {err:.3e} m exceeds 1um");
            checked += 1;
        }
    }

    // Materialize reduction: batch-local materialized far fewer meshes than flat,
    // and templates + occurrences account for every flat occurrence.
    let flat_n = flat_by_id.len();
    let bl_n = bl_meshes.iter().filter(|m| m.geometry_class == 0 && !m.positions.is_empty()).count();
    let bl_verts: usize = bl_meshes.iter().map(|m| m.positions.len() / 3).sum();
    let flat_verts: usize = flat_meshes.iter().map(|m| m.positions.len() / 3).sum();
    assert!(bl_n < flat_n, "batch-local materialized ({bl_n}) not fewer than flat ({flat_n})");
    assert_eq!(checked, flat_n, "collated occurrences must cover every flat occurrence");
    eprintln!(
        "[#1623 P3] synthetic batch-local: flat = {flat_n} meshes / {flat_verts} verts; \
         batch-local = {bl_n} materialized + {} shard occurrences / {bl_verts} materialized verts \
         (reduction: {} meshes, {} verts)",
        bl_occ.len(),
        flat_n - bl_n,
        flat_verts.saturating_sub(bl_verts),
    );
}
