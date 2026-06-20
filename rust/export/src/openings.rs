// SPDX-License-Identifier: MPL-2.0
//! Apertures (windows) and doors for the HBJSON exporter — wasm-safe, profile-based.
//!
//! Window/door occurrences come from `extract_profiles` (per-occurrence, in the SAME
//! Y-up→Z-up frame as the rooms — no meshing, no frame calibration, and safe in
//! wasm/CLI/browser; the native mesher `process_geometry_filtered` traps in wasm). Each
//! occurrence's profile prisms (base ring + extruded ring) form a point cloud that is
//! projected onto the matched exterior wall face, yielding a coplanar sub-face within the
//! parent boundary — uniform for vertical-glazed windows and vertically-extruded door leaves.

use std::collections::HashMap;

use ifc_lite_geometry::ExtractedProfile;

use crate::hbjson::{Aperture, Door, Face3D, Room};
use crate::rooms::{center, dot, newell_normal, xf, zup};

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] { [a[0] - b[0], a[1] - b[1], a[2] - b[2]] }
fn norm(a: [f64; 3]) -> [f64; 3] {
    let l = (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt();
    if l > 0.0 { [a[0] / l, a[1] / l, a[2] / l] } else { [0.0, 0.0, 0.0] }
}

/// All corner points of an occurrence's profile prisms (base + extruded), Z-up, rebased.
fn occurrence_points(profiles: &[&ExtractedProfile], origin: [f64; 3]) -> Vec<[f64; 3]> {
    let mut pts = Vec::new();
    for p in profiles {
        let n = p.outer_points.len() / 2;
        let dir = zup([p.extrusion_dir[0] as f64, p.extrusion_dir[1] as f64, p.extrusion_dir[2] as f64]);
        let depth = p.extrusion_depth as f64;
        for i in 0..n {
            let base = sub(xf(&p.transform, p.outer_points[i * 2] as f64, p.outer_points[i * 2 + 1] as f64), origin);
            pts.push(base);
            pts.push([base[0] + dir[0] * depth, base[1] + dir[1] * depth, base[2] + dir[2] * depth]);
        }
    }
    pts
}

/// An exterior wall face with its in-plane (u, v) frame, for sub-face placement.
struct WallFace {
    ri: usize,
    fi: usize,
    origin: [f64; 3],
    uax: [f64; 3],
    vax: [f64; 3],
    ulen: f64,
    vlen: f64,
    n: [f64; 3],
}

fn collect_exterior_walls(rooms: &[Room]) -> Vec<WallFace> {
    let mut out = Vec::new();
    for (ri, room) in rooms.iter().enumerate() {
        for (fi, f) in room.faces.iter().enumerate() {
            if f.face_type != "Wall" || f.boundary_condition.ty != "Outdoors" {
                continue;
            }
            let b = &f.geometry.boundary;
            if b.len() < 3 {
                continue;
            }
            let origin = b[0];
            let uax = norm(sub(b[1], origin));
            let vax = norm(sub(b[b.len() - 1], origin));
            let ulen = b.iter().map(|p| dot(sub(*p, origin), uax)).fold(f64::MIN, f64::max);
            let vlen = b.iter().map(|p| dot(sub(*p, origin), vax)).fold(f64::MIN, f64::max);
            out.push(WallFace { ri, fi, origin, uax, vax, ulen, vlen, n: newell_normal(b) });
        }
    }
    out
}

/// Project a point cloud onto the best-matching exterior wall face → coplanar rectangle.
fn project(verts: &[[f64; 3]], walls: &[WallFace]) -> Option<(usize, usize, Vec<[f64; 3]>)> {
    if verts.is_empty() {
        return None;
    }
    let c = center(verts);
    let mut best: Option<(f64, usize)> = None;
    for (i, w) in walls.iter().enumerate() {
        let d = dot(sub(c, w.origin), w.n).abs();
        let u = dot(sub(c, w.origin), w.uax);
        let v = dot(sub(c, w.origin), w.vax);
        if d < 0.7 && u > -0.5 && u < w.ulen + 0.5 && v > -0.5 && v < w.vlen + 0.5 {
            if best.map_or(true, |(bd, _)| d < bd) {
                best = Some((d, i));
            }
        }
    }
    let w = &walls[best?.1];
    let us: Vec<f64> = verts.iter().map(|p| dot(sub(*p, w.origin), w.uax)).collect();
    let vs: Vec<f64> = verts.iter().map(|p| dot(sub(*p, w.origin), w.vax)).collect();
    let u0 = us.iter().cloned().fold(f64::MAX, f64::min).max(0.05);
    let u1 = us.iter().cloned().fold(f64::MIN, f64::max).min(w.ulen - 0.05);
    let v0 = vs.iter().cloned().fold(f64::MAX, f64::min).max(0.05);
    let v1 = vs.iter().cloned().fold(f64::MIN, f64::max).min(w.vlen - 0.05);
    if u1 - u0 < 0.1 || v1 - v0 < 0.1 {
        return None;
    }
    let pt = |u: f64, v: f64| {
        [
            w.origin[0] + w.uax[0] * u + w.vax[0] * v,
            w.origin[1] + w.uax[1] * u + w.vax[1] * v,
            w.origin[2] + w.uax[2] * u + w.vax[2] * v,
        ]
    };
    Some((w.ri, w.fi, vec![pt(u0, v0), pt(u1, v0), pt(u1, v1), pt(u0, v1)]))
}

enum Pending {
    Window(u32, Vec<[f64; 3]>),
    Door(u32, Vec<[f64; 3]>),
}

/// Place windows as Apertures and doors as Doors on exterior wall faces (mutating `rooms`).
/// Only exterior (`Outdoors`) walls receive sub-faces — interior adjacency / interior
/// openings land once gap-closing is solved downstream (P5).
pub fn attach_openings(profiles: &[ExtractedProfile], rooms: &mut [Room], origin: [f64; 3]) {
    // Group window/door profiles by occurrence.
    let mut by: HashMap<u32, (bool, Vec<&ExtractedProfile>)> = HashMap::new();
    for p in profiles {
        let is_window = p.ifc_type == "IfcWindow";
        if is_window || p.ifc_type == "IfcDoor" {
            by.entry(p.express_id).or_insert((is_window, Vec::new())).1.push(p);
        }
    }

    let walls = collect_exterior_walls(rooms);
    let mut pending: Vec<(usize, usize, Pending)> = Vec::new();
    for (id, (is_window, ps)) in &by {
        let pts = occurrence_points(ps, origin);
        if let Some((ri, fi, geo)) = project(&pts, &walls) {
            pending.push((ri, fi, if *is_window { Pending::Window(*id, geo) } else { Pending::Door(*id, geo) }));
        }
    }

    for (ri, fi, p) in pending {
        match p {
            Pending::Window(id, geo) => {
                rooms[ri].faces[fi].apertures.push(Aperture::new(format!("Ap{}", id), Face3D::new(geo), false));
            }
            Pending::Door(id, geo) => {
                rooms[ri].faces[fi].doors.push(Door::new(format!("Dr{}", id), Face3D::new(geo), false));
            }
        }
    }
}
