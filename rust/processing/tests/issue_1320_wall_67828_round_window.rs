// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression for the round window #68400 in gable wall #67828 of
//! AC20-FZK-Haus.ifc: the circular opening must cut a CLEAN through-hole.
//!
//! The opening is authored as TWO `IfcExtrudedAreaSolid` cylinders glued
//! cap-to-cap mid-wall, so the combined cutter carries an interior back-to-back
//! cap membrane. Before the fix the exact CSG subtract left a solid plug at the
//! seam (the window never cut through, or a square plug remained in the round
//! hole).
//!
//! The verification is FRAME-INDEPENDENT — it does not assume any world
//! coordinate for the opening (earlier tests falsely passed by ray-casting at a
//! guessed world point that missed the rotated mesh entirely). Instead it:
//!   1. picks the wall's thinnest bbox axis as the wall-thickness direction,
//!   2. casts rays along that axis over a fine grid of the other two axes,
//!      counting triangle crossings (Möller–Trumbore),
//!   3. flood-fills the 0-crossing cells from the grid border; any 0-cell NOT
//!      reachable from the border is an INTERIOR hole — i.e. the window cut.
//!
//! A solid (uncut) wall, or one with a central plug, has too few interior hole
//! cells and the test FAILS.

use ifc_lite_processing::{process_geometry, MeshData};

const FIXTURE: &str = "tests/models/ara3d/AC20-FZK-Haus.ifc";
const WALL_ID: u32 = 67828;

fn fixture_path(relative: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join(relative)
}

/// World-space triangle soup for the wall (positions + per-mesh origin).
fn wall_triangles(meshes: &[&MeshData]) -> Vec<[[f64; 3]; 3]> {
    let mut tris = Vec::new();
    for m in meshes {
        let o = m.origin;
        let get = |vi: usize| {
            [
                m.positions[vi * 3] as f64 + o[0],
                m.positions[vi * 3 + 1] as f64 + o[1],
                m.positions[vi * 3 + 2] as f64 + o[2],
            ]
        };
        if !m.indices.is_empty() {
            for t in m.indices.chunks_exact(3) {
                tris.push([get(t[0] as usize), get(t[1] as usize), get(t[2] as usize)]);
            }
        } else {
            let vc = m.positions.len() / 3;
            let mut k = 0;
            while k + 2 < vc {
                tris.push([get(k), get(k + 1), get(k + 2)]);
                k += 3;
            }
        }
    }
    tris
}

/// Count crossings of a ray (origin `o`, unit direction `dir`) with the soup.
fn ray_crossings(tris: &[[[f64; 3]; 3]], o: [f64; 3], dir: [f64; 3]) -> usize {
    let cross = |a: [f64; 3], b: [f64; 3]| {
        [
            a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0],
        ]
    };
    let sub = |a: [f64; 3], b: [f64; 3]| [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    let dot = |a: [f64; 3], b: [f64; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let mut hits = 0;
    for [a, b, c] in tris {
        let e1 = sub(*b, *a);
        let e2 = sub(*c, *a);
        let pv = cross(dir, e2);
        let det = dot(e1, pv);
        if det.abs() < 1e-12 {
            continue;
        }
        let inv = 1.0 / det;
        let tv = sub(o, *a);
        let u = dot(tv, pv) * inv;
        if u < -1e-7 || u > 1.0 + 1e-7 {
            continue;
        }
        let qv = cross(tv, e1);
        let v = dot(dir, qv) * inv;
        if v < -1e-7 || u + v > 1.0 + 1e-7 {
            continue;
        }
        let t = dot(e2, qv) * inv;
        if t > 1e-6 {
            hits += 1;
        }
    }
    hits
}

/// Returns the number of interior (window) hole cells detected in the wall, and
/// prints a crossing-map for debugging.
fn interior_hole_cells(tris: &[[[f64; 3]; 3]]) -> usize {
    // bbox
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    for t in tris {
        for v in t {
            for a in 0..3 {
                lo[a] = lo[a].min(v[a]);
                hi[a] = hi[a].max(v[a]);
            }
        }
    }
    // thin axis = smallest extent
    let ext = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    let thin = (0..3).min_by(|&i, &j| ext[i].partial_cmp(&ext[j]).unwrap()).unwrap();
    let (ua, va) = match thin {
        0 => (1, 2),
        1 => (0, 2),
        _ => (0, 1),
    };
    let mut dir = [0.0; 3];
    dir[thin] = 1.0;
    let oc = lo[thin] - 1.0; // cast from just outside the thin face

    let step = 0.08_f64;
    let us: Vec<f64> = {
        let mut v = Vec::new();
        let mut x = lo[ua] - step;
        while x <= hi[ua] + step {
            v.push(x);
            x += step;
        }
        v
    };
    let vs: Vec<f64> = {
        let mut v = Vec::new();
        let mut x = lo[va] - step;
        while x <= hi[va] + step {
            v.push(x);
            x += step;
        }
        v
    };
    let w = us.len();
    let h = vs.len();
    let mut grid = vec![0usize; w * h];
    for (vi, &vv) in vs.iter().enumerate() {
        for (ui, &uu) in us.iter().enumerate() {
            let mut o = [0.0; 3];
            o[thin] = oc;
            o[ua] = uu;
            o[va] = vv;
            grid[vi * w + ui] = ray_crossings(tris, o, dir);
        }
    }
    // print map (rows = va desc)
    eprintln!("crossing map (. = empty/hole, 2 = solid); thin axis = {thin}");
    for vi in (0..h).rev() {
        let mut row = String::new();
        for ui in 0..w {
            let c = grid[vi * w + ui];
            row.push(if c == 0 {
                '.'
            } else if c == 2 {
                '2'
            } else if c % 2 == 1 {
                '!'
            } else {
                '#'
            });
        }
        eprintln!("{row}");
    }
    // flood-fill 0-cells from border
    let mut reach = vec![false; w * h];
    let mut stack = Vec::new();
    for vi in 0..h {
        for ui in 0..w {
            if (vi == 0 || vi == h - 1 || ui == 0 || ui == w - 1) && grid[vi * w + ui] == 0 {
                reach[vi * w + ui] = true;
                stack.push((vi, ui));
            }
        }
    }
    while let Some((vi, ui)) = stack.pop() {
        let mut nbrs = Vec::new();
        if vi > 0 {
            nbrs.push((vi - 1, ui));
        }
        if vi + 1 < h {
            nbrs.push((vi + 1, ui));
        }
        if ui > 0 {
            nbrs.push((vi, ui - 1));
        }
        if ui + 1 < w {
            nbrs.push((vi, ui + 1));
        }
        for (nv, nu) in nbrs {
            if !reach[nv * w + nu] && grid[nv * w + nu] == 0 {
                reach[nv * w + nu] = true;
                stack.push((nv, nu));
            }
        }
    }
    let mut interior = 0;
    for i in 0..w * h {
        if grid[i] == 0 && !reach[i] {
            interior += 1;
        }
    }
    interior
}

#[test]
fn wall_67828_round_window_cuts_through_native() {
    // Match WASM behaviour (local frame + building rotation).
    std::env::set_var("IFC_LITE_LOCAL_FRAME", "1");

    let path = fixture_path(FIXTURE);
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => {
            eprintln!("{FIXTURE} missing — skipping");
            return;
        }
    };

    let result = process_geometry(content.as_str());
    let wall_meshes: Vec<&MeshData> = result
        .meshes
        .iter()
        .filter(|m| m.express_id == WALL_ID && !m.positions.is_empty())
        .collect();
    assert!(!wall_meshes.is_empty(), "no mesh for wall #{WALL_ID}");

    let tris = wall_triangles(&wall_meshes);
    let total_tris = tris.len();
    let interior = interior_hole_cells(&tris);
    eprintln!("wall #{WALL_ID}: {total_tris} triangles, interior hole cells = {interior}");

    // A clean ~0.5 m-diameter circular through-hole covers ~30+ grid cells at the
    // 0.08 m step. A solid wall has 0; a wall with a central plug has a thin ring
    // (still > 0 but far fewer than a full disk). Require a substantial open disk.
    assert!(
        interior >= 30,
        "wall #{WALL_ID}: round window #68400 not cleanly cut — only {interior} interior \
         hole cells (solid wall = 0, central plug = thin ring). {total_tris} tris"
    );
}
