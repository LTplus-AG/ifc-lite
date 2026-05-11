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

/// Resolve the wall's thinnest axis (= thickness) and the two in-plane axes.
fn wall_axes(wall_mesh: &Mesh) -> (usize, [usize; 2]) {
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
    (thickness_axis, grid_axes)
}

/// Cast a single ray through the centre of the opening footprint along the
/// wall's thickness axis. Returns total triangle hits.
fn count_hits_through_opening_centre(
    wall_mesh: &Mesh,
    opening_min: [f32; 3],
    opening_max: [f32; 3],
) -> usize {
    let (wall_min, _) = wall_mesh.bounds();
    let (thickness_axis, grid_axes) = wall_axes(wall_mesh);

    let mid_a = 0.5 * (opening_min[grid_axes[0]] + opening_max[grid_axes[0]]);
    let mid_b = 0.5 * (opening_min[grid_axes[1]] + opening_max[grid_axes[1]]);

    let slack = 1.0;
    let mut origin = [0f32, 0f32, 0f32];
    origin[thickness_axis] = match thickness_axis {
        0 => wall_min.x - slack,
        1 => wall_min.y - slack,
        _ => wall_min.z - slack,
    };
    origin[grid_axes[0]] = mid_a;
    origin[grid_axes[1]] = mid_b;
    let mut dir = [0f32, 0f32, 0f32];
    dir[thickness_axis] = 1.0;

    count_ray_hits(wall_mesh, origin, dir)
}

/// Identify the rim of the round-window hole on the outer wall faces.
///
/// Approach (centroid-based, robust to clean CSG output):
///   1. Keep only "wall-face" triangles — those whose normal is roughly
///      parallel to the wall's thickness axis. This excludes the
///      cylindrical sub-mesh of the recessed window (its normals are
///      perpendicular to the thickness axis) and any small triangles
///      on the wall's top/bottom/sides that lean differently.
///   2. Of those, classify by centroid position along the thickness
///      axis: a triangle belongs to whichever of the two outer wall
///      faces (Y=min or Y=max in opening footprint coords; really
///      `thickness_axis`-min vs `thickness_axis`-max) its centroid is
///      closer to.
///   3. For each outer face independently, build an edge dictionary of
///      its triangles and mark edges that:
///        * appear in exactly one triangle of that face (free-edge,
///          i.e. a topological boundary on that face), AND
///        * whose midpoint lies inside the opening's in-plane AABB.
///      Those are rim edges of the hole on that face. The wall's outer
///      perimeter edges are excluded because their midpoints sit far
///      outside the opening footprint.
///
/// This works whether the CSG output is densely tessellated (many
/// small triangles around the rim) or minimally tessellated (the rim
/// is a polygon edge of a large face triangle).
///
/// Returns `(boundary_vertex_count, bbox_aspect_ratio)`. The aspect
/// ratio is `max(width, height) / min(width, height)` of the in-plane
/// bounding box of the rim — close to `1.0` for a circular hole and
/// >> 1.0 for a degenerate cut.
fn opening_boundary_metrics(
    wall_mesh: &Mesh,
    opening_min: [f32; 3],
    opening_max: [f32; 3],
) -> (usize, f32) {
    let (thickness_axis, grid_axes) = wall_axes(wall_mesh);
    let a = grid_axes[0];
    let b = grid_axes[1];
    let (wall_min, wall_max) = wall_mesh.bounds();
    let wall_t_min = match thickness_axis {
        0 => wall_min.x,
        1 => wall_min.y,
        _ => wall_min.z,
    };
    let wall_t_max = match thickness_axis {
        0 => wall_max.x,
        1 => wall_max.y,
        _ => wall_max.z,
    };
    let wall_t_mid = 0.5 * (wall_t_min + wall_t_max);

    let scale = 1e4_f32;
    let quantize =
        |x: f32, y: f32| -> (i64, i64) { ((x * scale).round() as i64, (y * scale).round() as i64) };

    // Two edge dictionaries — one per outer wall face. Each maps an
    // (in-plane) edge to its occurrence count on that face.
    let mut edge_count_low: rustc_hash::FxHashMap<((i64, i64), (i64, i64)), usize> =
        rustc_hash::FxHashMap::default();
    let mut edge_count_high: rustc_hash::FxHashMap<((i64, i64), (i64, i64)), usize> =
        rustc_hash::FxHashMap::default();

    for tri in wall_mesh.indices.chunks_exact(3) {
        let i0 = tri[0] as usize * 3;
        let i1 = tri[1] as usize * 3;
        let i2 = tri[2] as usize * 3;
        if i0 + 2 >= wall_mesh.positions.len()
            || i1 + 2 >= wall_mesh.positions.len()
            || i2 + 2 >= wall_mesh.positions.len()
        {
            continue;
        }
        let p = [
            [
                wall_mesh.positions[i0],
                wall_mesh.positions[i0 + 1],
                wall_mesh.positions[i0 + 2],
            ],
            [
                wall_mesh.positions[i1],
                wall_mesh.positions[i1 + 1],
                wall_mesh.positions[i1 + 2],
            ],
            [
                wall_mesh.positions[i2],
                wall_mesh.positions[i2 + 1],
                wall_mesh.positions[i2 + 2],
            ],
        ];

        // Wall-face filter: normal must be roughly parallel to the
        // wall's thickness axis (cos > 0.7 ≈ within 45°).
        let e1 = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
        let e2 = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
        let n = [
            e1[1] * e2[2] - e1[2] * e2[1],
            e1[2] * e2[0] - e1[0] * e2[2],
            e1[0] * e2[1] - e1[1] * e2[0],
        ];
        let n_len2 = n[0] * n[0] + n[1] * n[1] + n[2] * n[2];
        if n_len2 < 1e-20 {
            continue;
        }
        let n_len = n_len2.sqrt();
        if n[thickness_axis].abs() / n_len < 0.7 {
            continue;
        }

        // Pick which outer face this triangle belongs to by centroid
        // position along the thickness axis. Triangles on the recess
        // shoulder (interior X) bin to whichever face their centroid
        // is closer to — that's fine, they don't form free edges that
        // sit inside the opening AABB midpoint anyway.
        let ct = (p[0][thickness_axis] + p[1][thickness_axis] + p[2][thickness_axis]) / 3.0;
        let target = if ct <= wall_t_mid {
            &mut edge_count_low
        } else {
            &mut edge_count_high
        };

        for (s, e) in [(0usize, 1usize), (1, 2), (2, 0)] {
            let qa = quantize(p[s][a], p[s][b]);
            let qb = quantize(p[e][a], p[e][b]);
            if qa == qb {
                continue; // skip degenerate in-plane edge
            }
            let key = if qa < qb { (qa, qb) } else { (qb, qa) };
            *target.entry(key).or_insert(0) += 1;
        }
    }

    // Rim edges per face = free edges (count == 1) whose midpoint sits
    // inside the opening's in-plane AABB. Free edges on the wall's
    // outer perimeter are excluded by the midpoint filter.
    let mut boundary_pts: Vec<(f32, f32)> = Vec::new();
    let mut collect = |edges: &rustc_hash::FxHashMap<((i64, i64), (i64, i64)), usize>| {
        for ((qa, qb), count) in edges {
            if *count != 1 {
                continue;
            }
            let pa = (qa.0 as f32 / scale, qa.1 as f32 / scale);
            let pb = (qb.0 as f32 / scale, qb.1 as f32 / scale);
            let mid_a = 0.5 * (pa.0 + pb.0);
            let mid_b = 0.5 * (pa.1 + pb.1);
            if mid_a >= opening_min[a]
                && mid_a <= opening_max[a]
                && mid_b >= opening_min[b]
                && mid_b <= opening_max[b]
            {
                boundary_pts.push(pa);
                boundary_pts.push(pb);
            }
        }
    };
    collect(&edge_count_low);
    collect(&edge_count_high);

    // Dedupe boundary points (each appears in ≥ 2 rim edges).
    boundary_pts.sort_by(|p, q| {
        p.0.partial_cmp(&q.0)
            .unwrap()
            .then(p.1.partial_cmp(&q.1).unwrap())
    });
    boundary_pts.dedup_by(|x, y| (x.0 - y.0).abs() < 1e-6 && (x.1 - y.1).abs() < 1e-6);

    if boundary_pts.is_empty() {
        return (0, f32::INFINITY);
    }

    let mut min_a = f32::INFINITY;
    let mut min_b = f32::INFINITY;
    let mut max_a = f32::NEG_INFINITY;
    let mut max_b = f32::NEG_INFINITY;
    for (pa, pb) in &boundary_pts {
        if *pa < min_a {
            min_a = *pa;
        }
        if *pa > max_a {
            max_a = *pa;
        }
        if *pb < min_b {
            min_b = *pb;
        }
        if *pb > max_b {
            max_b = *pb;
        }
    }
    let w = max_a - min_a;
    let h = max_b - min_b;
    let aspect = if w.min(h) > 1e-6 {
        w.max(h) / w.min(h)
    } else {
        f32::INFINITY
    };
    (boundary_pts.len(), aspect)
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
    // A clean gable pentagon has only 3 unique X-positions on the
    // top silhouette: left eaves, apex, right eaves. CSG kernels that
    // emit minimal-vertex output (Manifold on Linux x86_64 in
    // particular) populate only 3 of the 9 bins. macOS / BSP paths
    // happen to leave T-junction or merge artifacts that fill more
    // bins, but >= 3 is the correct geometric floor.
    assert!(valid.len() >= 3, "silhouette has too few populated bins: {:?}", bins);

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

    // The peak must be in the central third of the wall's long axis —
    // i.e. an actual gable apex, not a one-sided slope. Combined with
    // `valid.len() >= 3` and `variation > 0.10` this still catches the
    // un-clipped-rectangle regression that motivated the original test.
    let mut max_bin = 0usize;
    let mut max_z = f32::NEG_INFINITY;
    for (i, z) in bins.iter().enumerate() {
        if z.is_finite() && *z > max_z {
            max_z = *z;
            max_bin = i;
        }
    }
    assert!(
        (3..=5).contains(&max_bin),
        "gable wall #60012 peak bin is {} of 9 — apex is not centred (bins = {:?})",
        max_bin, bins
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
    // See note in `..._60012_has_trapezoidal_silhouette` — a clean
    // pentagon clip has only 3 X-positions on the silhouette.
    assert!(valid.len() >= 3, "silhouette has too few populated bins: {:?}", bins);

    let hi = *valid.iter().max_by(|a, b| a.partial_cmp(b).unwrap()).unwrap();
    let lo = *valid.iter().min_by(|a, b| a.partial_cmp(b).unwrap()).unwrap();
    let variation = hi - lo;
    assert!(
        variation > 0.10,
        "gable wall #67828 silhouette is FLAT (variation = {:.4} m, max Z by bin = {:?}) — \
         IfcBooleanClippingResult was NOT applied",
        variation, bins
    );

    let mut max_bin = 0usize;
    let mut max_z = f32::NEG_INFINITY;
    for (i, z) in bins.iter().enumerate() {
        if z.is_finite() && *z > max_z {
            max_z = *z;
            max_bin = i;
        }
    }
    assert!(
        (3..=5).contains(&max_bin),
        "gable wall #67828 peak bin is {} of 9 — apex is not centred (bins = {:?})",
        max_bin, bins
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

    // Centre-ray must pass through (almost) cleanly — the cut reaches
    // through the wall body. The AC20 round window is *recessed*: it has
    // two stacked extrusions of different depths, so the CSG cut leaves
    // an internal ring face at the recess boundary. A round-cut centre
    // ray therefore hits at most that ring (2 triangles, entry + exit);
    // the AABB fallback removed it entirely (= 0 hits) but lost the
    // round shape.
    let hits = count_hits_through_opening_centre(&wall_mesh, op_min, op_max);
    assert!(
        hits <= 4,
        "wall #60012 has too many triangles in the centre of round window #60579 — \
         void cut may not have been applied. hits={}, opening_aabb=[{:?}..{:?}], wall_tris={}",
        hits, op_min, op_max, wall_mesh.triangle_count()
    );

    // Hole shape: the round-window CSG cut should produce a circular
    // rim on each outer wall face. The boundary metric finds rim free-
    // edges of wall-face triangles whose midpoint sits inside the
    // opening's AABB; that rim has ≥ 8 distinct vertices even for a
    // coarse polygon-circle (the AC20 round window is a 16-gon, but
    // CSG kernels can collapse co-linear segments down to ~8).
    let (boundary_verts, aspect) = opening_boundary_metrics(&wall_mesh, op_min, op_max);
    assert!(
        boundary_verts >= 8,
        "round window #60579 hole boundary has only {} vertices — \
         CSG cut produced no detectable rim on the wall faces",
        boundary_verts
    );
    assert!(
        aspect < 1.5,
        "round window #60579 boundary aspect ratio {:.3} (expected < 1.5)",
        aspect
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

    // See note on #60012 — recessed round window leaves an internal ring
    // (≤ ~4 triangle hits along the centre ray). What matters is that
    // the cut reached the wall body at all.
    let hits = count_hits_through_opening_centre(&wall_mesh, op_min, op_max);
    assert!(
        hits <= 4,
        "wall #67828 has too many triangles in the centre of round window #68400 — \
         void cut may not have been applied. hits={}, opening_aabb=[{:?}..{:?}], wall_tris={}",
        hits, op_min, op_max, wall_mesh.triangle_count()
    );

    // See note on #60012 — strict shape assertion using the rim metric.
    let (boundary_verts, aspect) = opening_boundary_metrics(&wall_mesh, op_min, op_max);
    assert!(
        boundary_verts >= 8,
        "round window #68400 hole boundary has only {} vertices — \
         CSG cut produced no detectable rim on the wall faces",
        boundary_verts
    );
    assert!(
        aspect < 1.5,
        "round window #68400 boundary aspect ratio {:.3} (expected < 1.5)",
        aspect
    );
}

/// Width of a horizontal slab of `mesh` between `z_lo` and `z_hi`,
/// measured along the wall's longest horizontal axis. Returns the
/// (long-axis-span, short-axis-span, vertex_count) tuple.
fn slab_spans(mesh: &Mesh, z_lo: f32, z_hi: f32) -> (f32, f32, usize) {
    let (mn, mx) = mesh.bounds();
    let extents = [mx.x - mn.x, mx.y - mn.y, mx.z - mn.z];
    let long_axis = if extents[0] >= extents[1] { 0 } else { 1 };
    let short_axis = 1 - long_axis;
    let mut min_l = f32::INFINITY;
    let mut max_l = f32::NEG_INFINITY;
    let mut min_s = f32::INFINITY;
    let mut max_s = f32::NEG_INFINITY;
    let mut count = 0usize;
    for chunk in mesh.positions.chunks_exact(3) {
        let z = chunk[2];
        if z < z_lo || z > z_hi {
            continue;
        }
        let l = chunk[long_axis];
        let s = chunk[short_axis];
        if l < min_l {
            min_l = l;
        }
        if l > max_l {
            max_l = l;
        }
        if s < min_s {
            min_s = s;
        }
        if s > max_s {
            max_s = s;
        }
        count += 1;
    }
    let l_span = if count > 0 { max_l - min_l } else { 0.0 };
    let s_span = if count > 0 { max_s - min_s } else { 0.0 };
    (l_span, s_span, count)
}

/// Issue #635 follow-up: gable wall must be wide at the bottom and narrow
/// at the top (peak). The pre-fix bug inverted this — wide at top, point at
/// bottom — because the IfcPolygonalBoundedHalfSpace prism was extruded
/// along plane_normal instead of Position's Z-axis (per the IFC spec).
#[test]
fn issue_635_gable_wall_60012_bottom_must_span_full_width() {
    let content = match load_fixture(FIXTURE) {
        Some(c) => c,
        None => {
            eprintln!("{} missing — skipping issue-635 inversion test", FIXTURE);
            return;
        }
    };

    let mesh = process_element_only(&content, WALL_60012)
        .expect("wall #60012 should produce a mesh");
    assert!(!mesh.is_empty(), "wall #60012 mesh is empty");

    let (mn, mx) = mesh.bounds();
    // Bottom slab: lowest 0.15 m of the wall.
    let (bot_long, _bot_short, bot_count) = slab_spans(&mesh, mn.z, mn.z + 0.15);
    // Top slab: top 0.20 m of the wall — the gable peak.
    let (top_long, _top_short, top_count) = slab_spans(&mesh, mx.z - 0.20, mx.z);

    assert!(bot_count > 0, "bottom slab has no vertices");
    assert!(top_count > 0, "top slab has no vertices");
    // Wall is ~10 m long along its long axis. The bottom must span
    // the FULL length (>= 8 m), while the gable peak narrows to a
    // point or near-point at the top (< 2 m).
    assert!(
        bot_long >= 8.0,
        "gable wall #60012 BOTTOM is too narrow ({:.3} m along long axis) — \
         IfcPolygonalBoundedHalfSpace was inverted (clip kept the wrong side)",
        bot_long
    );
    assert!(
        top_long <= 4.0,
        "gable wall #60012 TOP is too wide ({:.3} m) — gable peak should be \
         narrow, not the full wall length",
        top_long
    );
}

/// Same invariant for wall #67828 (the second gable wall in AC20-FZK-Haus).
#[test]
fn issue_635_gable_wall_67828_bottom_must_span_full_width() {
    let content = match load_fixture(FIXTURE) {
        Some(c) => c,
        None => {
            eprintln!("{} missing — skipping issue-635 inversion test", FIXTURE);
            return;
        }
    };

    let mesh = process_element_only(&content, WALL_67828)
        .expect("wall #67828 should produce a mesh");
    assert!(!mesh.is_empty(), "wall #67828 mesh is empty");

    let (mn, mx) = mesh.bounds();
    let (bot_long, _bot_short, bot_count) = slab_spans(&mesh, mn.z, mn.z + 0.15);
    let (top_long, _top_short, top_count) = slab_spans(&mesh, mx.z - 0.20, mx.z);

    assert!(bot_count > 0, "bottom slab has no vertices");
    assert!(top_count > 0, "top slab has no vertices");
    assert!(
        bot_long >= 8.0,
        "gable wall #67828 BOTTOM is too narrow ({:.3} m) — inverted clip",
        bot_long
    );
    assert!(
        top_long <= 4.0,
        "gable wall #67828 TOP is too wide ({:.3} m) — gable peak should be narrow",
        top_long
    );
}

/// Issue #635 follow-up: explicit assertion that the round-window cut
/// produces a polygon-circle hole, not the AABB rectangular fallback.
/// This guards against regressions where polyline simplification breaks
/// or `MAX_CSG_POLYGONS_PER_MESH` is lowered enough to push the opening
/// back into the fallback path.
#[test]
fn issue_635_round_window_is_circular() {
    let content = match load_fixture(FIXTURE) {
        Some(c) => c,
        None => {
            eprintln!("{} missing — skipping issue-635 roundness test", FIXTURE);
            return;
        }
    };
    let void_index = build_void_index_like_production(&content);

    for (wall_id, opening_id) in
        [(WALL_60012, OPENING_60579), (WALL_67828, OPENING_68400)].iter()
    {
        let wall_mesh = process_host_like_production(&content, *wall_id, &void_index)
            .unwrap_or_else(|| panic!("wall #{} mesh missing", wall_id));
        let (op_min, op_max) = opening_world_aabb(&content, *opening_id)
            .unwrap_or_else(|| panic!("opening #{} mesh missing", opening_id));

        // Cut existence: centre ray through the opening must hit at most
        // a recessed-window inner ring (~4 tris). Catches the "void was
        // not subtracted at all" regression even when the post-cut
        // topology has no interior rim verts.
        let hits = count_hits_through_opening_centre(&wall_mesh, op_min, op_max);
        assert!(
            hits <= 4,
            "round window #{} centre ray hits {} triangles — void cut was not applied",
            opening_id, hits
        );

        // Boundary metric: walks wall-face triangles and finds rim
        // free-edges whose midpoint sits inside the opening's AABB.
        // Robust to both densely tessellated and minimally tessellated
        // CSG output (Linux Manifold leaves the hole as a polygon edge
        // of a large face triangle — still detected here).
        let (boundary_verts, aspect) = opening_boundary_metrics(&wall_mesh, op_min, op_max);
        assert!(
            boundary_verts >= 8,
            "round window #{} hole boundary has only {} edges — non-polygonal cut",
            opening_id, boundary_verts
        );
        assert!(
            aspect < 1.5,
            "round window #{} hole bbox aspect {:.3} >= 1.5 — non-circular cut",
            opening_id, aspect
        );
    }
}

/// Issue #635 follow-up — gable cap artifact.
///
/// Even with the orientation-corrected `IfcPolygonalBoundedHalfSpace`
/// cutter, walls #60012 and #67828 retained a flat horizontal "lid" at
/// the original extrusion top (Z=max). Each `IfcBooleanClippingResult`
/// in the chain was processed sequentially, but the first cut's BSP CSG
/// output exceeded the `MAX_CSG_POLYGONS_PER_MESH` budget, so the second
/// cut was silently SKIPPED — leaving the wall's right (or left) corner
/// uncut. The result was a flat quad straddling the gable apex spanning
/// the whole long-axis footprint.
///
/// A correctly clipped gable wall narrows to a peak at the apex — at most
/// a thin slice of triangles at Z=max along the centerline, NOT a wide
/// quad. This test asserts the (X, Y) extent of all "top-Z" triangles
/// covers less than half the wall's longer horizontal axis.
fn assert_no_gable_cap(mesh: &Mesh, wall_id: u32) {
    assert!(!mesh.is_empty(), "wall #{} mesh is empty", wall_id);

    let (mn, mx) = mesh.bounds();
    let max_z = mx.z;
    let min_z = mn.z;
    let height = max_z - min_z;
    assert!(height > 0.5, "wall #{} height suspiciously small: {}", wall_id, height);

    // "At the top": within 1 mm absolute, capped at 0.5% of wall height.
    let z_tol = 0.001f32.max(height * 0.005);

    let mut top_x_min = f32::INFINITY;
    let mut top_x_max = f32::NEG_INFINITY;
    let mut top_y_min = f32::INFINITY;
    let mut top_y_max = f32::NEG_INFINITY;
    let mut top_tri_count = 0usize;

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
        let z0 = mesh.positions[i0 + 2];
        let z1 = mesh.positions[i1 + 2];
        let z2 = mesh.positions[i2 + 2];
        if z0 < max_z - z_tol || z1 < max_z - z_tol || z2 < max_z - z_tol {
            continue;
        }
        top_tri_count += 1;
        for off in [i0, i1, i2] {
            let x = mesh.positions[off];
            let y = mesh.positions[off + 1];
            top_x_min = top_x_min.min(x);
            top_x_max = top_x_max.max(x);
            top_y_min = top_y_min.min(y);
            top_y_max = top_y_max.max(y);
        }
    }

    if top_tri_count == 0 {
        // No triangles literally at the very top — definitely no cap.
        return;
    }

    let wall_x_range = mx.x - mn.x;
    let wall_y_range = mx.y - mn.y;
    let top_x_range = top_x_max - top_x_min;
    let top_y_range = top_y_max - top_y_min;

    // The wall's longer horizontal axis is its length axis. Cap should
    // narrow to a ridge along this axis. Across the thickness axis the
    // ridge IS allowed to span the whole wall thickness.
    let (long_axis_top_range, long_axis_wall_range, axis_label) = if wall_x_range >= wall_y_range {
        (top_x_range, wall_x_range, "X")
    } else {
        (top_y_range, wall_y_range, "Y")
    };
    let frac = long_axis_top_range / long_axis_wall_range;

    assert!(
        frac < 0.5,
        "gable wall #{} has a flat horizontal cap at Z=max spanning {:.0}% of its length \
         along the {} axis (top {} range = {:.3}, wall {} range = {:.3}, top tris = {}). \
         A correctly clipped gable narrows to a ridge line at the apex.",
        wall_id, frac * 100.0, axis_label, axis_label, long_axis_top_range,
        axis_label, long_axis_wall_range, top_tri_count,
    );
}

#[test]
fn issue_635_no_gable_cap_60012() {
    let content = match load_fixture(FIXTURE) {
        Some(c) => c,
        None => {
            eprintln!("{} missing — skipping issue-635 gable cap test", FIXTURE);
            return;
        }
    };
    let mesh = process_element_only(&content, WALL_60012)
        .expect("wall #60012 should produce a mesh");
    assert_no_gable_cap(&mesh, WALL_60012);
}

#[test]
fn issue_635_no_gable_cap_67828() {
    let content = match load_fixture(FIXTURE) {
        Some(c) => c,
        None => {
            eprintln!("{} missing — skipping issue-635 gable cap test", FIXTURE);
            return;
        }
    };
    let mesh = process_element_only(&content, WALL_67828)
        .expect("wall #67828 should produce a mesh");
    assert_no_gable_cap(&mesh, WALL_67828);
}

