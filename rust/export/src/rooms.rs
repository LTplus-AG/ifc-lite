// SPDX-License-Identifier: MPL-2.0
//! Build watertight Honeybee Rooms from `IfcSpace` extruded-area profiles.
//!
//! Source = `ifc_lite_geometry::extract_profiles` (analytic, NOT the render mesh — the
//! render mesh drops sliver triangles and breaks watertightness; proven in the spike).
//! `ExtractedProfile` is in renderer **Y-up** space (matching the JS bridge), so points
//! and the extrusion direction are converted to Honeybee **Z-up** here. Coordinates are
//! rebased to a model origin to keep f32 survey magnitudes (national-grid models) from
//! collapsing precision.

use std::collections::HashMap;

use ifc_lite_geometry::ExtractedProfile;

use crate::hbjson::{Face, Face3D, Room};

/// Convert a WebGL Y-up point/direction to IFC/Honeybee Z-up: `(x, y, z) -> (x, -z, y)`.
pub(crate) fn zup(p: [f64; 3]) -> [f64; 3] {
    [p[0], -p[2], p[1]]
}

/// Transform a 2D profile point by the entity's column-major 4×4, then convert to Z-up.
pub(crate) fn xf(t: &[f32; 16], px: f64, py: f64) -> [f64; 3] {
    let c = |r: usize, col: usize| t[col * 4 + r] as f64;
    zup([
        c(0, 0) * px + c(0, 1) * py + c(0, 3),
        c(1, 0) * px + c(1, 1) * py + c(1, 3),
        c(2, 0) * px + c(2, 1) * py + c(2, 3),
    ])
}

fn dist(a: &[f64; 3], b: &[f64; 3]) -> f64 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
}

/// Merge vertices closer than `merge` (Euclidean), including a duplicate closing vertex.
/// `merge` carries a margin above the model tolerance so no kept edge lands in Honeybee's
/// degenerate band (which would collapse to a non-manifold edge).
pub(crate) fn clean_ring(ring: Vec<[f64; 3]>, merge: f64) -> Vec<[f64; 3]> {
    let mut out: Vec<[f64; 3]> = Vec::with_capacity(ring.len());
    for p in ring {
        if out.last().map_or(true, |q| dist(&p, q) > merge) {
            out.push(p);
        }
    }
    if out.len() > 1 && dist(&out[0], out.last().unwrap()) <= merge {
        out.pop();
    }
    out
}

/// Newell's method: raw (area-weighted, un-normalised) polygon normal.
fn newell_raw(b: &[[f64; 3]]) -> [f64; 3] {
    let m = b.len();
    let mut n = [0.0_f64; 3];
    for i in 0..m {
        let c = b[i];
        let d = b[(i + 1) % m];
        n[0] += (c[1] - d[1]) * (c[2] + d[2]);
        n[1] += (c[2] - d[2]) * (c[0] + d[0]);
        n[2] += (c[0] - d[0]) * (c[1] + d[1]);
    }
    n
}

/// Unit polygon normal (zero vector if degenerate).
pub(crate) fn newell_normal(b: &[[f64; 3]]) -> [f64; 3] {
    let n = newell_raw(b);
    let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
    if len > 0.0 { [n[0] / len, n[1] / len, n[2] / len] } else { [0.0, 0.0, 0.0] }
}

/// Planar polygon area (`|Newell| / 2`).
pub(crate) fn polygon_area(b: &[[f64; 3]]) -> f64 {
    let n = newell_raw(b);
    0.5 * (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt()
}

/// Shortest edge length of a closed polygon.
fn min_edge(b: &[[f64; 3]]) -> f64 {
    let m = b.len();
    (0..m)
        .map(|i| {
            let c = b[i];
            let d = b[(i + 1) % m];
            ((c[0] - d[0]).powi(2) + (c[1] - d[1]).powi(2) + (c[2] - d[2]).powi(2)).sqrt()
        })
        .fold(f64::MAX, f64::min)
}

/// Max deviation of any vertex from the polygon's best-fit plane.
fn planarity_dev(b: &[[f64; 3]]) -> f64 {
    let n = newell_normal(b);
    if n == [0.0, 0.0, 0.0] {
        return f64::MAX;
    }
    let p0 = b[0];
    b.iter()
        .map(|p| ((p[0] - p0[0]) * n[0] + (p[1] - p0[1]) * n[1] + (p[2] - p0[2]) * n[2]).abs())
        .fold(0.0, f64::max)
}

/// A face Honeybee will accept: non-sliver, non-degenerate, planar within tolerance.
fn face_ok(b: &[[f64; 3]], tol: f64) -> bool {
    polygon_area(b) >= AREA_EPS && min_edge(b) > tol && planarity_dev(b) <= tol
}

/// 2D cross product (orientation) of `a→b` vs `a→c`.
fn orient2d(a: (f64, f64), b: (f64, f64), c: (f64, f64)) -> f64 {
    (b.0 - a.0) * (c.1 - a.1) - (b.1 - a.1) * (c.0 - a.0)
}

/// Proper crossing of segments `p1p2` and `p3p4` (shared endpoints don't count).
fn segments_cross(p1: (f64, f64), p2: (f64, f64), p3: (f64, f64), p4: (f64, f64)) -> bool {
    let d1 = orient2d(p3, p4, p1);
    let d2 = orient2d(p3, p4, p2);
    let d3 = orient2d(p1, p2, p3);
    let d4 = orient2d(p1, p2, p4);
    ((d1 > 0.0) != (d2 > 0.0)) && ((d3 > 0.0) != (d4 > 0.0)) && d1 != 0.0 && d2 != 0.0 && d3 != 0.0 && d4 != 0.0
}

/// True when the footprint ring is a simple polygon — no edge crossing AND no vertex pinch
/// (two non-adjacent vertices coinciding). Both are topologically watertight once extruded
/// but geometrically invalid: a crossing makes a figure-8, a pinch makes a non-manifold edge.
/// Honeybee rejects both as "not closed" / not solid, so we screen them out here.
fn is_simple_polygon(ring: &[[f64; 3]], tol: f64) -> bool {
    let n = newell_normal(ring);
    let (nx, ny, nz) = (n[0].abs(), n[1].abs(), n[2].abs());
    let (ax, ay): (usize, usize) = if nx >= ny && nx >= nz {
        (1, 2)
    } else if ny >= nx && ny >= nz {
        (0, 2)
    } else {
        (0, 1)
    };
    let p: Vec<(f64, f64)> = ring.iter().map(|q| (q[ax], q[ay])).collect();
    let m = p.len();
    if m < 3 {
        return false;
    }
    for i in 0..m {
        // Reject pinch points: any non-adjacent vertex coinciding with vertex i.
        for j in (i + 1)..m {
            if (j + 1) % m == i || (i + 1) % m == j {
                continue; // adjacent
            }
            if (p[i].0 - p[j].0).abs() <= tol && (p[i].1 - p[j].1).abs() <= tol {
                return false;
            }
        }
        // Reject edge crossings.
        let a1 = p[i];
        let a2 = p[(i + 1) % m];
        for j in (i + 1)..m {
            if (j + 1) % m == i || (i + 1) % m == j {
                continue;
            }
            if segments_cross(a1, a2, p[j], p[(j + 1) % m]) {
                return false;
            }
        }
    }
    true
}

/// True when the faces form a closed 2-manifold: every undirected edge (vertices snapped
/// to a `tol` grid) is shared by exactly two faces. Catches self-intersecting footprints
/// and any other non-watertight prism — the same naked-edge test Honeybee applies.
fn is_watertight(faces: &[(Vec<[f64; 3]>, &'static str)], tol: f64) -> bool {
    let grid = tol.max(1e-6);
    let key = |p: &[f64; 3]| {
        (
            (p[0] / grid).round() as i64,
            (p[1] / grid).round() as i64,
            (p[2] / grid).round() as i64,
        )
    };
    let mut edges: HashMap<((i64, i64, i64), (i64, i64, i64)), i32> = HashMap::new();
    for (b, _) in faces {
        let m = b.len();
        for i in 0..m {
            let a = key(&b[i]);
            let c = key(&b[(i + 1) % m]);
            if a == c {
                return false;
            }
            let e = if a <= c { (a, c) } else { (c, a) };
            *edges.entry(e).or_insert(0) += 1;
        }
    }
    !edges.is_empty() && edges.values().all(|&c| c == 2)
}

pub(crate) fn center(b: &[[f64; 3]]) -> [f64; 3] {
    let m = b.len().max(1) as f64;
    let mut c = [0.0; 3];
    for p in b {
        for k in 0..3 { c[k] += p[k]; }
    }
    [c[0] / m, c[1] / m, c[2] / m]
}

pub(crate) fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// Minimum face area (m²) below which a face — and its room — is treated as degenerate.
const AREA_EPS: f64 = 1.0e-4;

/// Build Honeybee Rooms from the `IfcSpace` profiles in `profiles`.
///
/// Returns the rooms, the model-wide rebase origin (so the openings pass can place window/
/// door geometry in the same frame), and the count of `IfcSpace` profiles skipped as
/// degenerate (so callers can report coverage rather than silently truncate).
pub fn build_rooms(profiles: &[ExtractedProfile], tol: f64) -> (Vec<Room>, [f64; 3], usize) {
    let mut skipped = 0usize;
    let spaces: Vec<&ExtractedProfile> =
        profiles.iter().filter(|p| p.ifc_type == "IfcSpace").collect();

    // Model-wide origin to rebase against (kills survey-coordinate f32 collapse).
    let mut origin = [f64::MAX; 3];
    for s in &spaces {
        let n = s.outer_points.len() / 2;
        for i in 0..n {
            let w = xf(&s.transform, s.outer_points[i * 2] as f64, s.outer_points[i * 2 + 1] as f64);
            for k in 0..3 {
                if w[k] < origin[k] { origin[k] = w[k]; }
            }
        }
    }
    if !origin[0].is_finite() {
        return (Vec::new(), [0.0; 3], skipped);
    }

    let mut rooms = Vec::new();
    for s in &spaces {
        let n = s.outer_points.len() / 2;
        if n < 3 {
            skipped += 1;
            continue;
        }
        // Spaces with inner rings (courtyard/atrium holes) would need the hole modelled in
        // the floor/ceiling faces; building from the outer ring alone yields a wrong solid,
        // so skip them rather than emit incorrect geometry (hole support is a follow-up).
        if !s.hole_counts.is_empty() {
            skipped += 1;
            continue;
        }
        // extrusion_dir is also Y-up → convert (linear, no translation).
        let dir = zup([s.extrusion_dir[0] as f64, s.extrusion_dir[1] as f64, s.extrusion_dir[2] as f64]);
        let depth = s.extrusion_depth as f64;

        let ring: Vec<[f64; 3]> = (0..n)
            .map(|i| {
                let w = xf(&s.transform, s.outer_points[i * 2] as f64, s.outer_points[i * 2 + 1] as f64);
                [w[0] - origin[0], w[1] - origin[1], w[2] - origin[2]]
            })
            .collect();
        // Merge with a 2× margin so near-tolerance slivers can't survive as degenerate walls.
        let floor = clean_ring(ring, 2.0 * tol);
        if floor.len() < 3 || !is_simple_polygon(&floor, tol) {
            skipped += 1;
            continue;
        }
        let extruded: Vec<[f64; 3]> = floor
            .iter()
            .map(|p| [p[0] + dir[0] * depth, p[1] + dir[1] * depth, p[2] + dir[2] * depth])
            .collect();

        // Designate the lower ring as the Floor, the upper as the RoofCeiling (handles a
        // downward extrusion). Both share the base ring's vertex order, so wall quads pair
        // up correctly by index.
        let avg_z = |r: &[[f64; 3]]| r.iter().map(|p| p[2]).sum::<f64>() / r.len().max(1) as f64;
        let (floor_ring, roof_ring) = if avg_z(&extruded) >= avg_z(&floor) {
            (floor.clone(), extruded)
        } else {
            (extruded, floor.clone())
        };

        // Room centroid for outward-orientation.
        let mut cen = [0.0; 3];
        for p in floor_ring.iter().chain(roof_ring.iter()) {
            for k in 0..3 { cen[k] += p[k]; }
        }
        let tot = (floor_ring.len() + roof_ring.len()) as f64;
        for k in 0..3 { cen[k] /= tot; }

        // Faces typed BY CONSTRUCTION (not normal inference): floor, roof, then wall quads.
        let m = floor_ring.len();
        let mut raw: Vec<(Vec<[f64; 3]>, &'static str)> = Vec::with_capacity(m + 2);
        raw.push((floor_ring.clone(), "Floor"));
        raw.push((roof_ring.clone(), "RoofCeiling"));
        for i in 0..m {
            let j = (i + 1) % m;
            raw.push((vec![floor_ring[i], floor_ring[j], roof_ring[j], roof_ring[i]], "Wall"));
        }

        // Orient every face outward; reject the whole room if any face is degenerate.
        // (Holes & non-extrusion spaces are P5.)
        let mut oriented: Vec<(Vec<[f64; 3]>, &'static str)> = Vec::with_capacity(raw.len());
        let mut degenerate = false;
        for (mut b, face_type) in raw {
            if !face_ok(&b, tol) {
                degenerate = true;
                break;
            }
            let fc = center(&b);
            let outward = [fc[0] - cen[0], fc[1] - cen[1], fc[2] - cen[2]];
            if dot(newell_normal(&b), outward) < 0.0 {
                b.reverse();
            }
            oriented.push((b, face_type));
        }
        let walls = oriented.iter().filter(|(_, t)| *t == "Wall").count();
        // Only emit rooms that are genuinely watertight (self-intersecting footprints fail here).
        if degenerate || walls < 3 || !is_watertight(&oriented, tol) {
            skipped += 1;
            continue;
        }

        // P1: ground the floor, everything else Outdoors. Interior adjacency (Surface BCs)
        // is solved downstream in Honeybee once gap-closing lands (P5).
        let faces: Vec<Face> = oriented
            .into_iter()
            .enumerate()
            .map(|(fi, (b, face_type))| {
                let bc = if face_type == "Floor" { "Ground" } else { "Outdoors" };
                Face::new(format!("R{}_F{}", s.express_id, fi), Face3D::new(b), face_type, bc)
            })
            .collect();
        rooms.push(Room::new(format!("R{}", s.express_id), faces));
    }

    // Drop duplicate / strongly-overlapping spaces (Revit often carries an overlapping copy).
    // Safe: adjacent rooms are air volumes separated by wall thickness → ~0 AABB overlap;
    // stacked storeys → ~0 Z overlap. Only true duplicates exceed the 50% fraction.
    let (rooms, dropped) = dedupe_colliding(rooms);
    skipped += dropped;
    (rooms, origin, skipped)
}

/// A room's duplicate signature: floor-polygon XY centroid + area + Z extent.
struct Sig {
    cx: f64,
    cy: f64,
    area: f64,
    zmin: f64,
    zmax: f64,
}

fn room_signature(r: &Room) -> Option<Sig> {
    let floor = r.faces.iter().find(|f| f.face_type == "Floor")?;
    let b = &floor.geometry.boundary;
    if b.is_empty() {
        return None;
    }
    let n = b.len() as f64;
    let cx = b.iter().map(|p| p[0]).sum::<f64>() / n;
    let cy = b.iter().map(|p| p[1]).sum::<f64>() / n;
    let (zmin, zmax) = r
        .faces
        .iter()
        .flat_map(|f| &f.geometry.boundary)
        .fold((f64::MAX, f64::MIN), |(lo, hi), p| (lo.min(p[2]), hi.max(p[2])));
    Some(Sig { cx, cy, area: polygon_area(b), zmin, zmax })
}

/// True when two rooms are near-identical copies (Revit duplicate-space artifact): same
/// floor centroid, same area, overlapping Z. Targets duplicates precisely so genuinely
/// distinct adjacent/nested/stacked rooms are never dropped.
fn is_duplicate(a: &Sig, b: &Sig) -> bool {
    (a.cx - b.cx).abs() < 0.3
        && (a.cy - b.cy).abs() < 0.3
        && a.area > 0.0
        && (a.area - b.area).abs() / a.area.max(b.area) < 0.05
        && a.zmin < b.zmax
        && b.zmin < a.zmax
}

/// Keep the larger-area room of each duplicate pair.
fn dedupe_colliding(rooms: Vec<Room>) -> (Vec<Room>, usize) {
    let sigs: Vec<Option<Sig>> = rooms.iter().map(room_signature).collect();
    let mut order: Vec<usize> = (0..rooms.len()).collect();
    let area_of = |i: usize| sigs[i].as_ref().map_or(0.0, |s| s.area);
    order.sort_by(|&a, &b| area_of(b).partial_cmp(&area_of(a)).unwrap_or(std::cmp::Ordering::Equal));
    let mut keep = vec![false; rooms.len()];
    let mut kept: Vec<usize> = Vec::new();
    for &i in &order {
        let dup = match &sigs[i] {
            Some(si) => kept.iter().any(|&j| sigs[j].as_ref().is_some_and(|sj| is_duplicate(si, sj))),
            None => false,
        };
        if !dup {
            keep[i] = true;
            kept.push(i);
        }
    }
    let dropped = keep.iter().filter(|k| !**k).count();
    let out = rooms.into_iter().enumerate().filter(|(i, _)| keep[*i]).map(|(_, r)| r).collect();
    (out, dropped)
}
