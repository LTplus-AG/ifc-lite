// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7631, isolated from #6940: MiniBIM slab135923 had an earcut
//! cap/side boundary mismatch even before its redundant openings were cut.
//! Direct-router controls prove both source-hygiene policies close. The shared
//! producer then exercises its canonical zero-void (Watertight) and one/all
//! void (IndexOnly) paths in both native/browser vertex frames.

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
use ifc_lite_geometry::{GeometryRouter, Mesh, Vector3};
use ifc_lite_processing::element::{
    produce_element_meshes, ElementJobKind, ElementMeshJob, MeshProductionContext,
    MeshProductionOptions,
};
use rustc_hash::FxHashMap;
use std::collections::BTreeMap;

const HOST: u32 = 135923;
const GRID: f64 = 1.0 / 65536.0;

fn closed_volume(meshes: &[Mesh], frame: &str) -> (f64, f64, f64, f64, usize) {
    let mut uses = BTreeMap::<([i64; 3], [i64; 3]), (usize, usize)>::new();
    let (mut volume, mut area, mut magnitude) = (0.0, 0.0, 0.0_f64);
    let (mut perimeter_sum, mut triangles) = (0.0, 0usize);
    for m in meshes {
        volume += ifc_lite_geometry::kernel::mesh_volume::mesh_volume(m);
        for &p in &m.positions {
            magnitude = magnitude.max(f64::from(p).abs());
        }
        let stored = |i: u32| {
            Vector3::new(
                f64::from(m.positions[i as usize * 3]),
                f64::from(m.positions[i as usize * 3 + 1]),
                f64::from(m.positions[i as usize * 3 + 2]),
            )
        };
        let key = |i: u32| -> [i64; 3] {
            std::array::from_fn(|k| {
                ((f64::from(m.positions[i as usize * 3 + k]) + m.origin[k]) / GRID).round() as i64
            })
        };
        for t in m.indices.chunks_exact(3) {
            let (a, b, c) = (stored(t[0]), stored(t[1]), stored(t[2]));
            area += (b - a).cross(&(c - a)).norm() * 0.5;
            perimeter_sum += (b - a).norm() + (c - b).norm() + (a - c).norm();
            triangles += 1;
            let q = [key(t[0]), key(t[1]), key(t[2])];
            let a: [i128; 3] = std::array::from_fn(|k| i128::from(q[1][k]) - i128::from(q[0][k]));
            let b: [i128; 3] = std::array::from_fn(|k| i128::from(q[2][k]) - i128::from(q[0][k]));
            assert_ne!(
                [
                    a[1] * b[2] - a[2] * b[1],
                    a[2] * b[0] - a[0] * b[2],
                    a[0] * b[1] - a[1] * b[0]
                ],
                [0; 3],
                "{frame}: collapsed grid face"
            );
            for k in 0..3 {
                let (a, b) = (q[k], q[(k + 1) % 3]);
                let u = uses.entry((a.min(b), a.max(b))).or_default();
                if a < b {
                    u.0 += 1;
                } else {
                    u.1 += 1;
                }
            }
        }
    }
    assert!(!uses.is_empty(), "{frame}: empty slab");
    assert!(
        uses.values().all(|&u| u == (1, 1)),
        "{frame}: {} unmatched directed edges",
        uses.values().filter(|&&u| u != (1, 1)).count()
    );
    assert!(volume > 0.0, "{frame}: solid must face outward");
    (volume, area, magnitude, perimeter_sum, triangles)
}

#[test]
fn issue_6940_source_cap_and_redundant_openings_close_in_all_frames() {
    let Some(bytes) = ifc_lite_testkit::fixture_bytes(
        "georeferencer/MiniBIM-3.1-DO_01_VORM.ifc",
    ) else { return };
    let index = std::sync::Arc::new(build_entity_index(&bytes));
    let mut decoder = EntityDecoder::with_arc_index(&bytes, index.clone());
    let units = GeometryRouter::with_units(&bytes, &mut decoder);
    let mut openings = Vec::new();
    let mut site = None;
    let mut scanner = EntityScanner::new(&bytes);
    while let Some((id, name, start, end)) = scanner.next_entity() {
        if name == "IFCRELVOIDSELEMENT" {
            let rel = decoder.decode_at_with_id(id, start, end).unwrap();
            if rel.get_ref(4) == Some(HOST) {
                openings.push(rel.get_ref(5).unwrap());
            }
        } else if name == "IFCSITE" {
            let entity = decoder.decode_at_with_id(id, start, end).unwrap();
            let m = units
                .resolve_scaled_placement(&entity, &mut decoder)
                .unwrap();
            site = Some((m[12], m[13], m[14]));
        }
    }
    assert_eq!(
        openings.len(),
        13,
        "fixture must contain the actual opening set"
    );
    assert!(openings.contains(&135934));
    let site = site.expect("authentic site placement");
    assert!(site.0.abs() > 1.0 && site.1.abs() > 1.0);
    for offset in [(0.0, 0.0, 0.0), site] {
        for local in [false, true] {
            // The producer overrides preserve_triangle_order according to its
            // indexed-colour policy. Exercise IndexOnly explicitly through the
            // public router, where this setting really controls source hygiene.
            for index_only in [false, true] {
                let mut source_decoder = EntityDecoder::with_arc_index(&bytes, index.clone());
                let source_entity = source_decoder.decode_by_id(HOST).unwrap();
                let mut source_router =
                    GeometryRouter::with_scale_and_local_frame(units.unit_scale(), local);
                source_router.set_rtc_offset(offset);
                source_router.set_preserve_triangle_order(index_only);
                let source = source_router
                    .process_element(&source_entity, &mut source_decoder)
                    .unwrap();
                closed_volume(
                    std::slice::from_ref(&source),
                    &format!("source offset={offset:?} local={local} IndexOnly={index_only}"),
                );
            }
            let mut baseline: Option<(f64, f64, f64, f64, usize)> = None;
            for ids in [Vec::new(), vec![135934], openings.clone()] {
                let frame = format!("offset={offset:?} local={local} openings={}", ids.len());
                let voids: FxHashMap<u32, Vec<u32>> = if ids.is_empty() {
                    FxHashMap::default()
                } else {
                    [(HOST, ids)].into_iter().collect()
                };
                let mut decoder = EntityDecoder::with_arc_index(&bytes, index.clone());
                let mut router =
                    GeometryRouter::with_scale_and_local_frame(units.unit_scale(), local);
                router.set_rtc_offset(offset);
                let entity = decoder.decode_by_id(HOST).unwrap();
                let job = ElementMeshJob {
                    id: HOST,
                    ifc_type: entity.ifc_type.clone(),
                    entity: &entity,
                    kind: ElementJobKind::Product,
                    element_color: None,
                    metadata: None,
                };
                let ctx = MeshProductionContext {
                    void_index: &voids,
                    geometry_style_index: &FxHashMap::default(),
                    indexed_colour_full: &FxHashMap::default(),
                    element_material_colors: &FxHashMap::default(),
                    texture_index: &FxHashMap::default(),
                    site_local_rotation: None,
                };
                let meshes = produce_element_meshes(
                    &job,
                    &ctx,
                    &MeshProductionOptions::default(),
                    &mut decoder,
                    &router,
                )
                .meshes;
                let meshes: Vec<Mesh> = meshes
                    .into_iter()
                    .map(|m| Mesh {
                        positions: m.positions,
                        indices: m.indices,
                        origin: m.origin,
                        ..Mesh::default()
                    })
                    .collect();
                let (volume, area, magnitude, perimeter, triangles) = closed_volume(&meshes, &frame);
                if let Some((base_volume, base_area, base_magnitude, base_perimeter, base_triangles)) = baseline {
                    // Same displacement budget as the lower layer's real-model
                    // oracle: two kernel steps plus two f32 relative-error units.
                    let d = 3.0_f64.sqrt()
                        * (2.0 * GRID
                            + 2.0 * f64::from(f32::EPSILON) * magnitude.max(base_magnitude));
                    assert!(
                        (volume - base_volume).abs() <= (area + base_area) * d,
                        "{frame}: redundant opening changed slab volume"
                    );
                    // #6940: the same area bound as the eight-slab oracle,
                    // accounting for both tessellations without pinning a diagonal.
                    let area_tolerance = (perimeter + base_perimeter) * d
                        + 2.0 * (triangles + base_triangles) as f64 * d.powi(2);
                    assert!(
                        (area - base_area).abs() <= area_tolerance,
                        "{frame}: redundant opening changed slab surface area"
                    );
                } else {
                    baseline = Some((volume, area, magnitude, perimeter, triangles));
                }
            }
        }
    }
}
