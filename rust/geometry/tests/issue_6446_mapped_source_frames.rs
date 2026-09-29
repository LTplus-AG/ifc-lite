// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #6446: an `IfcRepresentationMap` whose own items mix a near-origin box with a
//! nested `IfcMappedItem` translated to X = 5,000,000.123456 m. Merging the
//! map's items into one f64 origin plus one f32 buffer put the far box on the
//! 0.5 m f32 grid at 5,000 km. Every consumer of the mapped-source mesh must now
//! either keep both boxes to 1e-5 m or say why it cannot (the single-mesh APIs).
//!
//! Fixture: `tests/fixtures/issue_6446_mapped_source_frames.ifc`. Maps #21 / #101
//! list the near box first, #23 / #103 the far one first; #108 nests map #21. Only APIs that
//! predate #6446 are called here, so the revert oracle can run this file
//! against the reverted production code.

use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::{GeometryRouter, Mesh};
use rustc_hash::FxHashMap;

const FAR_X: f64 = 5_000_000.123456;
const RTC: [f64; 3] = [5_000_000.0, 0.0, 0.0];
const TOL: f64 = 1e-5;

fn fixture() -> String {
    std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/issue_6446_mapped_source_frames.ifc"
    ))
    .expect("read tests/fixtures/issue_6446_mapped_source_frames.ifc")
}

fn with_decoder<T>(run: impl FnOnce(&mut EntityDecoder) -> T) -> T {
    let content = fixture();
    let index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, index);
    run(&mut decoder)
}

/// (label, router, model RTC folded back into world coordinates).
fn routers() -> Vec<(&'static str, GeometryRouter, [f64; 3])> {
    let mut rtc = GeometryRouter::with_scale_and_local_frame(1.0, true);
    rtc.set_rtc_offset((RTC[0], RTC[1], RTC[2]));
    vec![
        ("absolute", GeometryRouter::with_scale_and_local_frame(1.0, false), [0.0; 3]),
        ("local frame", GeometryRouter::with_scale_and_local_frame(1.0, true), [0.0; 3]),
        ("rtc + local frame", rtc, RTC),
    ]
}

/// World coordinate of every vertex on `axis`, reconstructed in f64.
fn world(mesh: &Mesh, axis: usize, rtc: [f64; 3]) -> Vec<f64> {
    mesh.positions.chunks_exact(3).map(|p| p[axis] as f64 + mesh.origin[axis] + rtc[axis]).collect()
}

fn segment_distance(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let t = (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)).clamp(0.0, 1.0);
    (p[0] - a[0] - t * dx).hypot(p[1] - a[1] - t * dy)
}

fn volume(mesh: &Mesh) -> f64 {
    let p = |i: u32| [0, 1, 2].map(|k| f64::from(mesh.positions[i as usize * 3 + k]));
    let six: f64 = mesh
        .indices
        .chunks_exact(3)
        .map(|t| {
            let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
            a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2])
                + a[2] * (b[0] * c[1] - b[1] * c[0])
        })
        .sum();
    six.abs() / 6.
}

/// Assert exactly one near and one far part, each the 1 m box at its own frame
/// (the far one shifted by `FAR_X`), to 1e-5 m: every vertex lies inside it and
/// on its surface (a side face, a cap or an edge of the `hole` polygon), and each axis
/// reaches both outer faces. Returns the two volumes (near, far).
fn assert_near_and_far(parts: &[Mesh], rtc: [f64; 3], hole: &[[f64; 2]], context: &str) -> (f64, f64) {
    let parts: Vec<&Mesh> = parts.iter().filter(|mesh| !mesh.is_empty()).collect();
    assert_eq!(parts.len(), 2, "{context}: the near and far box must stay separate meshes");
    let (mut near, mut far) = (None, None);
    for part in parts {
        let is_far = world(part, 0, rtc)[0] > 1_000.0;
        let label = if is_far { "far" } else { "near" };
        let shift = if is_far { FAR_X } else { 0.0 };
        let (xs, ys, zs) = (world(part, 0, rtc), world(part, 1, rtc), world(part, 2, rtc));
        for ((x, y), z) in xs.iter().map(|x| x - shift).zip(ys.iter().copied()).zip(zs.iter().copied()) {
            let inside = x.abs() < 0.5 + TOL && y.abs() < 0.5 + TOL && z > -TOL && z < 1.0 + TOL;
            let on_face = (x.abs() - 0.5).abs() < TOL || (y.abs() - 0.5).abs() < TOL;
            let on_hole = hole.iter().zip(hole.iter().cycle().skip(1)).any(|(a, b)| segment_distance([x, y], *a, *b) < TOL);
            let on_cap = z.abs() < TOL || (z - 1.0).abs() < TOL;
            assert!(
                inside && (on_face || on_hole || on_cap),
                "{context}: {label} vertex ({x:.9}, {y:.9}, {z:.9}) off the source by more than 1e-5 m \
                 (x relative to {shift})"
            );
        }
        for (axis, values, lo, hi) in [(0, &xs, shift - 0.5, shift + 0.5), (1, &ys, -0.5, 0.5), (2, &zs, 0.0, 1.0)] {
            let (min, max) = values
                .iter()
                .fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), v| (a.min(*v), b.max(*v)));
            assert!(
                (min - lo).abs() < TOL && (max - hi).abs() < TOL,
                "{context}: {label} axis {axis} spans [{min:.9}, {max:.9}], expected [{lo:.9}, {hi:.9}]"
            );
        }
        let slot = if is_far { &mut far } else { &mut near };
        assert!(slot.replace(volume(part)).is_none(), "{context}: one part per frame");
    }
    (near.unwrap(), far.unwrap())
}

#[test]
fn issue_6446_element_parts_keep_both_items_of_a_mixed_map() {
    for (label, router, rtc) in routers() {
        with_decoder(|decoder| {
            for id in [70, 75] {
                let element = decoder.decode_by_id(id).unwrap();
                let parts = router.process_element_parts(&element, decoder).unwrap();
                let context = format!("{label}, product #{id}");
                let (near, far) = assert_near_and_far(&parts, rtc, &[], &context);
                assert!((near - 1.0).abs() < 1e-4 && (far - 1.0).abs() < 1e-4, "{context}: {near} {far}");
                // One shared template per map would carry only one frame.
                assert!(parts.iter().all(|part| part.instance_meta.is_none()), "{context}");
            }
        });
    }
}

#[test]
fn issue_6446_mixed_map_is_not_cached_as_one_mesh() {
    // A second occurrence must not be served a merged (rounded) source from
    // either the per-router cache or the model-wide shared cache.
    let shared = GeometryRouter::new_mapped_item_cache();
    for round in 0..2 {
        let mut router = GeometryRouter::with_scale_and_local_frame(1.0, false);
        router.enable_shared_mapped_item_cache(shared.clone());
        with_decoder(|decoder| {
            for id in [70, 75, 70, 75] {
                let element = decoder.decode_by_id(id).unwrap();
                let parts = router.process_element_parts(&element, decoder).unwrap();
                assert_near_and_far(&parts, [0.0; 3], &[], &format!("round {round}, product #{id}"));
            }
        });
    }
    let cached = shared.lock().unwrap();
    assert!(cached.contains_key(&11), "the single-frame inner map is still cached");
    assert!(!cached.contains_key(&21) && !cached.contains_key(&23), "mixed maps are never cached");

    let router = GeometryRouter::with_scale_and_local_frame(1.0, false);
    with_decoder(|decoder| {
        for id in [70, 70] {
            let element = decoder.decode_by_id(id).unwrap();
            let parts = router.process_element_parts(&element, decoder).unwrap();
            assert_near_and_far(&parts, [0.0; 3], &[], "per-router cache");
        }
    });
}

#[test]
fn issue_6446_type_geometry_parts_keep_both_items() {
    // `process_representation_map_with_texture` feeds orphan type geometry.
    let router = GeometryRouter::with_scale_and_local_frame(1.0, false);
    with_decoder(|decoder| {
        for id in [21, 23, 101, 103, 108] {
            let rep_map = decoder.decode_by_id(id).unwrap();
            let parts = router.process_representation_map_with_texture(&rep_map, decoder, &FxHashMap::default()).unwrap();
            assert!(parts.iter().all(|(_, uvs, texture)| uvs.is_empty() && texture.is_none()));
            let meshes: Vec<Mesh> = parts.into_iter().map(|(mesh, _, _)| mesh).collect();
            assert_near_and_far(&meshes, [0.0; 3], &[], &format!("representation map #{id}"));
        }
    });
}

#[test]
fn issue_6446_opening_cut_through_a_mixed_map_keeps_both_holes() {
    // Host #80 / #90 is the mixed box map, opening #85 / #95 the mixed map of a
    // hexagonal through-hole: each box gets its own hexagonal hole in its own
    // frame. A non-box cutter this small (under 100 triangles) takes the
    // per-item path, `get_opening_item_meshes_world` for the cutter mesh and
    // `get_opening_item_bounds_with_direction` for its bounds; a lost part in
    // either degrades the hole to an axis-aligned box. No model RTC here: with
    // the RTC origin at the far box, a host part 5,000 km from it stays uncut on
    // main for plain direct items too (#6478, the product-level void path), which
    // is not this map-level defect.
    let r = 0.2;
    let h = r * 3f64.sqrt() / 2.0;
    let hexagon = [[r, 0.0], [r / 2.0, h], [-r / 2.0, h], [-r, 0.0], [-r / 2.0, -h], [r / 2.0, -h]];
    let expected = 1.0 - 3.0 * r * h; // hexagon area = 6 * (r * h / 2)
    for (label, router, rtc) in routers().into_iter().filter(|(_, _, rtc)| *rtc == [0.0; 3]) {
        with_decoder(|decoder| {
            for (host, opening) in [(80, 85), (90, 95)] {
                let element = decoder.decode_by_id(host).unwrap();
                let voids = FxHashMap::from_iter([(host, vec![opening])]);
                let parts = router.process_element_with_voids_parts(&element, decoder, &voids).unwrap();
                let context = format!("{label}, host #{host}");
                let (near, far) = assert_near_and_far(&parts, rtc, &hexagon, &context);
                assert!((near - expected).abs() < 1e-4 && (far - expected).abs() < 1e-4, "{context}: {near} {far}");
            }
        });
    }
}

#[test]
fn issue_6446_single_mesh_apis_never_silently_round_a_mixed_map() {
    let router = GeometryRouter::with_scale_and_local_frame(1.0, false);
    with_decoder(|decoder| {
        for (id, issue) in [(21, "#6446"), (23, "#6446"), (66, "#6446"), (71, "#6446"), (70, "#6349"), (75, "#6349")] {
            let entity = decoder.decode_by_id(id).unwrap();
            let result = match id {
                21 | 23 => router.process_representation_map(&entity, decoder),
                66 | 71 => router.process_representation_item(&entity, decoder),
                _ => router.process_element(&entity, decoder),
            };
            match result {
                Ok(mesh) => {
                    let xs = world(&mesh, 0, [0.0; 3]);
                    for face in [-0.5, 0.5, FAR_X - 0.5, FAR_X + 0.5] {
                        let off = xs.iter().map(|x| (x - face).abs()).fold(f64::INFINITY, f64::min);
                        assert!(off < TOL, "#{id}: X face {face:.6} came back {off:.6} m off, silently rounded");
                    }
                }
                Err(error) => {
                    let message = error.to_string();
                    assert!(message.contains(issue) && message.contains(&format!("#{id}")), "#{id}: {message}");
                }
            }
        }
    });
}

#[test]
fn issue_6446_single_frame_maps_still_return_one_mesh() {
    let router = GeometryRouter::with_scale_and_local_frame(1.0, false);
    with_decoder(|decoder| {
        // The inner map alone, and the nested far item alone: one frame each.
        let inner = decoder.decode_by_id(11).unwrap();
        let mesh = router.process_representation_map(&inner, decoder).unwrap();
        assert!((volume(&mesh) - 1.0).abs() < 1e-4);
        let far = decoder.decode_by_id(14).unwrap();
        let mesh = router.process_representation_item(&far, decoder).unwrap();
        let xs = world(&mesh, 0, [0.0; 3]);
        for face in [FAR_X - 0.5, FAR_X + 0.5] {
            assert!(xs.iter().any(|x| (x - face).abs() < TOL), "far face {face}");
        }
    });
}
