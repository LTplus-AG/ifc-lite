// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #635 — IfcBooleanClippingResult on walls with voids.
//!
//! AC20-FZK-Haus has 4 upper-floor walls (Wand-Ext-OG-1..4) whose
//! `Body` representation is `IfcBooleanClippingResult(.DIFFERENCE., extrusion,
//! halfspace)` (gable walls have a chained pair so the wall is trimmed by
//! both roof slopes). Two of them — #60012 and #67828 — also carry a round
//! window opening (IfcRelVoidsElement → IfcOpeningElement of an
//! `IfcArbitraryClosedProfileDef` polygon approximating a circle).
//!
//! On main:
//!  * The post-clip silhouette is missing (gable wall renders as a full
//!    rectangle), and / or
//!  * The round-window void is not subtracted from the post-clip mesh.
//!
//! This test drives the exact production path
//! (`process_element_with_voids`) and asserts both invariants:
//!
//!   (a) The wall's `max Z` varies along its length — i.e. the gable
//!       roofline cut produced a trapezoid (or pentagon) silhouette,
//!       not a rectangle.
//!   (b) Rays cast through the round-window footprint along the wall
//!       thickness axis hit ZERO wall triangles — i.e. the void cut
//!       reached the post-clip mesh.

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
use ifc_lite_geometry::{propagate_voids_to_parts, GeometryRouter, Mesh};
use rustc_hash::FxHashMap;
use std::fs;
use std::path::PathBuf;

fn fixture_path(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join(relative)
}

fn load_fixture(relative: &str) -> Option<String> {
    fs::read_to_string(fixture_path(relative)).ok()
}

/// Build the void index the same way production does.
fn build_void_index_like_production(content: &str) -> FxHashMap<u32, Vec<u32>> {
    let mut void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    let mut scanner = EntityScanner::new(content);
    let mut decoder = EntityDecoder::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if type_name == "IFCRELVOIDSELEMENT" {
            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                if let (Some(host_id), Some(opening_id)) = (entity.get_ref(4), entity.get_ref(5)) {
                    void_index.entry(host_id).or_default().push(opening_id);
                }
            }
        }
    }
    let _ = propagate_voids_to_parts(&mut void_index, content, &mut decoder);
    void_index
}

fn process_host_like_production(
    content: &str,
    host_id: u32,
    void_index: &FxHashMap<u32, Vec<u32>>,
) -> Option<Mesh> {
    let entity_index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, entity_index);
    let entity = decoder.decode_by_id(host_id).ok()?;
    let router = GeometryRouter::with_scale(1.0);
    router
        .process_element_with_voids(&entity, &mut decoder, void_index)
        .ok()
}

fn process_element_only(content: &str, host_id: u32) -> Option<Mesh> {
    let entity_index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, entity_index);
    let entity = decoder.decode_by_id(host_id).ok()?;
    let router = GeometryRouter::with_scale(1.0);
    router.process_element(&entity, &mut decoder).ok()
}

/// Compute opening AABB the same way production does — just process the
/// opening element and read the bounds.
fn opening_world_aabb(content: &str, opening_id: u32) -> Option<([f32; 3], [f32; 3])> {
    let entity_index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, entity_index);
    let entity = decoder.decode_by_id(opening_id).ok()?;
    let router = GeometryRouter::with_scale(1.0);
    let mesh = router.process_element(&entity, &mut decoder).ok()?;
    if mesh.is_empty() {
        return None;
    }
    let (min, max) = mesh.bounds();
    Some(([min.x, min.y, min.z], [max.x, max.y, max.z]))
}

/// Möller–Trumbore ray–triangle intersection.
fn ray_hits_triangle(
    o: [f32; 3],
    d: [f32; 3],
    v0: [f32; 3],
    v1: [f32; 3],
    v2: [f32; 3],
) -> bool {
    let e1 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
    let e2 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
    let h = [
        d[1] * e2[2] - d[2] * e2[1],
        d[2] * e2[0] - d[0] * e2[2],
        d[0] * e2[1] - d[1] * e2[0],
    ];
    let a = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
    if a.abs() < 1e-7 {
        return false;
    }
    let f = 1.0 / a;
    let s = [o[0] - v0[0], o[1] - v0[1], o[2] - v0[2]];
    let u = f * (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]);
    if !(0.0..=1.0).contains(&u) {
        return false;
    }
    let q = [
        s[1] * e1[2] - s[2] * e1[1],
        s[2] * e1[0] - s[0] * e1[2],
        s[0] * e1[1] - s[1] * e1[0],
    ];
    let v = f * (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]);
    if v < 0.0 || u + v > 1.0 {
        return false;
    }
    let t = f * (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]);
    t > 1e-5
}

fn count_ray_hits(mesh: &Mesh, o: [f32; 3], d: [f32; 3]) -> usize {
    let mut hits = 0;
    for tri in mesh.indices.chunks_exact(3) {
        let i0 = tri[0] as usize * 3;
        let i1 = tri[1] as usize * 3;
        let i2 = tri[2] as usize * 3;
        if i0 + 2 >= mesh.positions.len()
            || i1 + 2 >= mesh.positions.len()
            || i2 + 2 >= mesh.positions.len()
        {
            continue;
        }
        let v0 = [mesh.positions[i0], mesh.positions[i0 + 1], mesh.positions[i0 + 2]];
        let v1 = [mesh.positions[i1], mesh.positions[i1 + 1], mesh.positions[i1 + 2]];
        let v2 = [mesh.positions[i2], mesh.positions[i2 + 1], mesh.positions[i2 + 2]];
        if ray_hits_triangle(o, d, v0, v1, v2) {
            hits += 1;
        }
    }
    hits
}

/// Cast a 3×3 grid of rays through the opening footprint along the wall's
/// thickness axis. Returns total triangle hits across the 9 rays.
fn count_hits_through_opening(
    wall_mesh: &Mesh,
    opening_min: [f32; 3],
    opening_max: [f32; 3],
) -> usize {
    let (wall_min, wall_max) = wall_mesh.bounds();
    let extents = [
        wall_max.x - wall_min.x,
        wall_max.y - wall_min.y,
        wall_max.z - wall_min.z,
    ];
    let mut thickness_axis = 0;
    for i in 1..3 {
        if extents[i] < extents[thickness_axis] {
            thickness_axis = i;
        }
    }
    let grid_axes: [usize; 2] = match thickness_axis {
        0 => [1, 2],
        1 => [0, 2],
        _ => [0, 1],
    };
    let inset = 0.10;
    let lo_a = opening_min[grid_axes[0]]
        + inset * (opening_max[grid_axes[0]] - opening_min[grid_axes[0]]);
    let hi_a = opening_max[grid_axes[0]]
        - inset * (opening_max[grid_axes[0]] - opening_min[grid_axes[0]]);
    let lo_b = opening_min[grid_axes[1]]
        + inset * (opening_max[grid_axes[1]] - opening_min[grid_axes[1]]);
    let hi_b = opening_max[grid_axes[1]]
        - inset * (opening_max[grid_axes[1]] - opening_min[grid_axes[1]]);

    let slack = 1.0;
    let mut origin = [0f32, 0f32, 0f32];
    origin[thickness_axis] = match thickness_axis {
        0 => wall_min.x - slack,
        1 => wall_min.y - slack,
        _ => wall_min.z - slack,
    };
    let mut dir = [0f32, 0f32, 0f32];
    dir[thickness_axis] = 1.0;

    let mut total = 0;
    for ai in 0..3 {
        let a = lo_a + (hi_a - lo_a) * (ai as f32 / 2.0);
        for bi in 0..3 {
            let b = lo_b + (hi_b - lo_b) * (bi as f32 / 2.0);
            origin[grid_axes[0]] = a;
            origin[grid_axes[1]] = b;
            total += count_ray_hits(wall_mesh, origin, dir);
        }
    }
    total
}

/// Compute the silhouette `max Z` of a wall as a function of position
/// along the wall's longest horizontal axis. Returns Z values sampled
/// at `n` equally-spaced bins. A correctly clipped gable wall gives
/// a trapezoid (low → high → low), an uncut wall gives a flat line.
fn max_z_silhouette(mesh: &Mesh, bins: usize) -> Vec<f32> {
    let (mn, mx) = mesh.bounds();
    let extents = [mx.x - mn.x, mx.y - mn.y, mx.z - mn.z];
    // Long horizontal axis = max of x/y extent.
    let long_axis = if extents[0] >= extents[1] { 0 } else { 1 };
    let lo = if long_axis == 0 { mn.x } else { mn.y };
    let hi = if long_axis == 0 { mx.x } else { mx.y };
    let span = hi - lo;
    if span <= 0.0 {
        return vec![mx.z; bins];
    }

    let mut max_per_bin = vec![f32::NEG_INFINITY; bins];
    for chunk in mesh.positions.chunks_exact(3) {
        let pos_along = if long_axis == 0 { chunk[0] } else { chunk[1] };
        let frac = ((pos_along - lo) / span).clamp(0.0, 1.0 - f32::EPSILON);
        let bin = (frac * bins as f32) as usize;
        let bin = bin.min(bins - 1);
        if chunk[2] > max_per_bin[bin] {
            max_per_bin[bin] = chunk[2];
        }
    }
    max_per_bin
}

const FIXTURE: &str = "tests/models/ara3d/AC20-FZK-Haus.ifc";

// Wall #60012 = Wand-Ext-OG-1 (10m, gable wall, 2 chained PolygonalBoundedHalfSpace clips,
// has round window opening #60579 via IfcRelVoidsElement #60582).
const WALL_60012: u32 = 60012;
const OPENING_60579: u32 = 60579;

// Wall #67828 = Wand-Ext-OG-3 (10m, gable wall, 2 chained PolygonalBoundedHalfSpace clips,
// has round window opening #68400 via IfcRelVoidsElement #68403).
const WALL_67828: u32 = 67828;
const OPENING_68400: u32 = 68400;

#[test]
fn issue_635_void_index_links_round_windows_to_gable_walls() {
    let content = match load_fixture(FIXTURE) {
        Some(c) => c,
        None => {
            eprintln!("{} missing — run `pnpm fixtures` to enable", FIXTURE);
            return;
        }
    };

    let void_index = build_void_index_like_production(&content);
    assert!(
        void_index.get(&WALL_60012).map(|v| v.contains(&OPENING_60579)).unwrap_or(false),
        "wall #60012 should have opening #60579 in void_index"
    );
    assert!(
        void_index.get(&WALL_67828).map(|v| v.contains(&OPENING_68400)).unwrap_or(false),
        "wall #67828 should have opening #68400 in void_index"
    );
}

#[test]
fn issue_635_gable_wall_60012_has_trapezoidal_silhouette() {
    let content = match load_fixture(FIXTURE) {
        Some(c) => c,
        None => {
            eprintln!("{} missing — skipping issue-635 silhouette test", FIXTURE);
            return;
        }
    };
    // process_element only — NO voids — so we isolate the boolean-clip pathway.
    let mesh = process_element_only(&content, WALL_60012)
        .expect("wall #60012 should produce a mesh");
    assert!(!mesh.is_empty(), "wall #60012 mesh is empty");

    let bins = max_z_silhouette(&mesh, 9);
    let valid: Vec<f32> = bins.iter().copied().filter(|z| z.is_finite()).collect();
    assert!(valid.len() >= 5, "silhouette has too few populated bins: {:?}", bins);

    let hi = *valid.iter().max_by(|a, b| a.partial_cmp(b).unwrap()).unwrap();
    let lo = *valid.iter().min_by(|a, b| a.partial_cmp(b).unwrap()).unwrap();
    let variation = hi - lo;

    // A correctly clipped gable: top edge varies by ~0.5..2 m along length.
    // An uncut rectangular wall would have variation < 1 cm.
    assert!(
        variation > 0.10,
        "gable wall #60012 silhouette is FLAT (variation = {:.4} m, max Z by bin = {:?}) — \
         IfcBooleanClippingResult was NOT applied",
        variation, bins
    );
}

#[test]
fn issue_635_gable_wall_67828_has_trapezoidal_silhouette() {
    let content = match load_fixture(FIXTURE) {
        Some(c) => c,
        None => {
            eprintln!("{} missing — skipping issue-635 silhouette test", FIXTURE);
            return;
        }
    };
    let mesh = process_element_only(&content, WALL_67828)
        .expect("wall #67828 should produce a mesh");
    assert!(!mesh.is_empty(), "wall #67828 mesh is empty");

    let bins = max_z_silhouette(&mesh, 9);
    let valid: Vec<f32> = bins.iter().copied().filter(|z| z.is_finite()).collect();
    assert!(valid.len() >= 5, "silhouette has too few populated bins: {:?}", bins);

    let hi = *valid.iter().max_by(|a, b| a.partial_cmp(b).unwrap()).unwrap();
    let lo = *valid.iter().min_by(|a, b| a.partial_cmp(b).unwrap()).unwrap();
    let variation = hi - lo;
    assert!(
        variation > 0.10,
        "gable wall #67828 silhouette is FLAT (variation = {:.4} m, max Z by bin = {:?}) — \
         IfcBooleanClippingResult was NOT applied",
        variation, bins
    );
}

#[test]
fn issue_635_gable_wall_60012_has_round_window_hole() {
    let content = match load_fixture(FIXTURE) {
        Some(c) => c,
        None => {
            eprintln!("{} missing — skipping issue-635 round window test", FIXTURE);
            return;
        }
    };
    let void_index = build_void_index_like_production(&content);
    let wall_mesh = process_host_like_production(&content, WALL_60012, &void_index)
        .expect("wall #60012 should produce a mesh");
    assert!(!wall_mesh.is_empty(), "wall #60012 with voids produced empty mesh");

    let (op_min, op_max) = opening_world_aabb(&content, OPENING_60579)
        .expect("opening #60579 should produce a mesh + bounds");

    let hits = count_hits_through_opening(&wall_mesh, op_min, op_max);
    assert_eq!(
        hits, 0,
        "wall #60012 still has triangles inside round window #60579 footprint — \
         void cut was NOT applied to post-clip mesh. \
         opening_aabb=[{:?}..{:?}], wall_tris={}",
        op_min, op_max, wall_mesh.triangle_count()
    );
}

#[test]
fn issue_635_gable_wall_67828_has_round_window_hole() {
    let content = match load_fixture(FIXTURE) {
        Some(c) => c,
        None => {
            eprintln!("{} missing — skipping issue-635 round window test", FIXTURE);
            return;
        }
    };
    let void_index = build_void_index_like_production(&content);
    let wall_mesh = process_host_like_production(&content, WALL_67828, &void_index)
        .expect("wall #67828 should produce a mesh");
    assert!(!wall_mesh.is_empty(), "wall #67828 with voids produced empty mesh");

    let (op_min, op_max) = opening_world_aabb(&content, OPENING_68400)
        .expect("opening #68400 should produce a mesh + bounds");

    let hits = count_hits_through_opening(&wall_mesh, op_min, op_max);
    assert_eq!(
        hits, 0,
        "wall #67828 still has triangles inside round window #68400 footprint — \
         void cut was NOT applied to post-clip mesh. \
         opening_aabb=[{:?}..{:?}], wall_tris={}",
        op_min, op_max, wall_mesh.triangle_count()
    );
}

