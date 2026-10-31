// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Per-mesh quality census for the per-mesh no-worse rule (#8190).
//!
//! Usage: `mesh_census [--no-voids] [--ids 1,2,3] <model.ifc>...` — one JSON
//! line per mesh on stdout, models in argument order, meshes in output order.
//! `--no-voids` cuts no openings (`OpeningFilterMode::IgnoreAll`): thin
//! material a host has only WITH its voids cut is material the cut made.
//! `IgnoreAll` clears voids only in a model that has an `IfcWindow` or
//! `IfcDoor` job (`processor/opening_filter.rs`); elsewhere it cuts as usual.
//!
//! Every row carries the metrics the void-cut gate compares base against
//! branch: open and nonmanifold edges (welded bit for bit, and at 10 um in
//! world coordinates with the mesh origin folded in), slivers above 50:1,
//! the maximum aspect, the area, and THIN MATERIAL. Thin material is the
//! area of triangles that have an anti-parallel triangle less than 200 um
//! BEHIND them, overlapping in projection: the two faces of a sheet of material
//! that thin, counted on both sides. A host pier standing between two abutting
//! cutters (#8156) is exactly that: watertight, joined to the wall at its sill
//! and head, and invisible to open-edge and volume checks. An authored feature
//! that thin counts the same, so the number is for comparing two runs, not a
//! defect count on its own. Pairs under 1 nm apart are COINCIDENT and counted
//! apart: there a zero-thickness sheet and two solids touching face to face
//! look the same, so "facing away" decides nothing.
//! `scripts/mesh-census-compare.mjs` reads two of these files.

use ifc_lite_processing::{process, MeshData, OpeningFilterMode, ProcessingRequest};
use serde_json::json;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use std::io::{BufWriter, Write};

/// Longest edge over its altitude above which a triangle counts as a sliver.
const SLIVER_ASPECT: f64 = 50.0;
/// World weld for the tolerant edge census and the component split.
const WELD: f64 = 1.0e-5;
/// Separation below which two facing-away anti-parallel faces are thin material.
const THIN: f64 = 2.0e-4;
/// Separation at or below which a pair is coincident rather than thin.
const COINCIDENT: f64 = 1.0e-9;
/// Bucket width for normals: about 0.06 degrees. Thin pairs are searched on
/// eight grids of it, so a pair straddling a cell boundary is still found.
const NORMAL_BUCKET: f64 = 1.0e-3;
/// Opposite-facing candidates with overlapping bounds examined per triangle,
/// so a large coplanar face cannot make one mesh quadratic. A face that hits
/// the cap is counted in `thinCapped`: its thin material was not fully
/// measured, and the compare script refuses to read that as a clean result.
const MAX_CANDIDATES: usize = 2048;

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let mut request = ProcessingRequest::full_pass();
    if args.first().map(String::as_str) == Some("--no-voids") {
        request = request.opening_filter(OpeningFilterMode::IgnoreAll);
        args.remove(0);
    }
    if args.first().map(String::as_str) == Some("--ids") {
        let list = args.get(1).expect("--ids needs a list");
        let ids: HashSet<u32> = list.split(',').map(|s| s.trim().parse().expect("express id")).collect();
        request = request.ids(Some(Arc::new(ids)));
        args.drain(..2);
    }
    assert!(!args.is_empty(), "usage: mesh_census [--no-voids] [--ids 1,2,3] <model.ifc>...");
    let out = std::io::stdout();
    let mut out = BufWriter::new(out.lock());
    for path in &args {
        let bytes = std::fs::read(path).unwrap_or_else(|e| panic!("read {path}: {e}"));
        let started = std::time::Instant::now();
        let result = process(&bytes, &request, &mut ());
        let mut ordinal: HashMap<u32, u32> = HashMap::new();
        let mut meshes = 0usize;
        for mesh in &result.meshes {
            let n = ordinal.entry(mesh.express_id).or_insert(0);
            let row = census(mesh);
            writeln!(
                out,
                "{}",
                json!({
                    "model": path, "id": mesh.express_id, "ord": *n,
                    "type": mesh.ifc_type, "tris": row.tris,
                    "open": row.open, "nonmanifold": row.nonmanifold,
                    "open10": row.open10, "nonmanifold10": row.nonmanifold10,
                    "slivers": row.slivers, "degenerate": row.degenerate,
                    "maxAspect": row.max_aspect, "area": row.area,
                    "thinFaces": row.thin_faces, "thinArea": row.thin_area,
                    "thinMinGap": row.thin_min_gap, "coincidentArea": row.coincident_area,
                    "thinCapped": row.thin_capped, "badIndices": row.bad_indices,
                })
            )
            .expect("write row");
            *n += 1;
            meshes += 1;
        }
        eprintln!("{path}: {meshes} meshes in {:.1} s", started.elapsed().as_secs_f64());
    }
    out.flush().expect("flush");
}

#[derive(Default)]
struct Row {
    tris: usize,
    open: usize,
    nonmanifold: usize,
    open10: usize,
    nonmanifold10: usize,
    slivers: usize,
    degenerate: usize,
    max_aspect: f64,
    area: f64,
    thin_faces: usize,
    thin_area: f64,
    thin_min_gap: Option<f64>,
    coincident_area: f64,
    thin_capped: usize,
    bad_indices: usize,
}

fn world(mesh: &MeshData, i: usize) -> [f64; 3] {
    [0, 1, 2].map(|k| mesh.positions[i * 3 + k] as f64 + mesh.origin[k])
}

/// Vertex ids after a weld; `key` maps a vertex index to its weld key.
fn weld<K: std::hash::Hash + Eq>(count: usize, key: impl Fn(usize) -> K) -> Vec<u32> {
    let mut ids: HashMap<K, u32> = HashMap::new();
    (0..count)
        .map(|i| {
            let n = ids.len() as u32;
            *ids.entry(key(i)).or_insert(n)
        })
        .collect()
}

/// Undirected edge use counts of the non-collapsed triangles under `vid`.
fn edge_uses(tris: &[[usize; 3]], vid: &[u32]) -> HashMap<(u32, u32), u32> {
    let mut edges = HashMap::new();
    for t in tris {
        let v = t.map(|i| vid[i]);
        if v[0] == v[1] || v[1] == v[2] || v[0] == v[2] {
            continue;
        }
        for i in 0..3 {
            let (x, y) = (v[i], v[(i + 1) % 3]);
            *edges.entry((x.min(y), x.max(y))).or_insert(0) += 1;
        }
    }
    edges
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn census(mesh: &MeshData) -> Row {
    let count = mesh.positions.len() / 3;
    let tris: Vec<[usize; 3]> = mesh
        .indices
        .chunks_exact(3)
        .filter(|t| t.iter().all(|&i| (i as usize) < count))
        .map(|t| [t[0] as usize, t[1] as usize, t[2] as usize])
        .collect();
    // Triangles naming a vertex the mesh does not have, and a trailing partial
    // triangle: left out of every metric above, so counted here instead of
    // vanishing (a dropped open triangle would otherwise read as closed).
    let bad_indices = mesh.indices.len() / 3 - tris.len() + usize::from(!mesh.indices.len().is_multiple_of(3));
    let mut row = Row { tris: tris.len(), bad_indices, ..Row::default() };
    let p: Vec<[f64; 3]> = (0..count).map(|i| world(mesh, i)).collect();

    let exact = weld(count, |i| [0, 1, 2].map(|k| mesh.positions[i * 3 + k].to_bits()));
    let uses = edge_uses(&tris, &exact);
    row.open = uses.values().filter(|&&c| c == 1).count();
    row.nonmanifold = uses.values().filter(|&&c| c > 2).count();

    let tolerant = weld(count, |i| p[i].map(|v| (v / WELD).round() as i64));
    let uses10 = edge_uses(&tris, &tolerant);
    row.open10 = uses10.values().filter(|&&c| c == 1).count();
    row.nonmanifold10 = uses10.values().filter(|&&c| c > 2).count();

    for t in &tris {
        let [a, b, c] = t.map(|i| p[i]);
        let n = cross(sub(b, a), sub(c, a));
        let twice_area = dot(n, n).sqrt();
        row.area += twice_area / 2.0;
        let longest = [sub(b, a), sub(c, b), sub(a, c)]
            .iter()
            .map(|e| dot(*e, *e))
            .fold(0.0, f64::max);
        if twice_area <= 0.0 {
            row.degenerate += 1;
            continue;
        }
        // Longest edge over the altitude onto it.
        let aspect = longest / twice_area;
        row.max_aspect = row.max_aspect.max(aspect);
        if aspect > SLIVER_ASPECT {
            row.slivers += 1;
        }
    }

    thin_material(&tris, &p, &mut row);
    row
}

/// One face for the thin-material census, about the mesh anchor.
struct Face {
    n: [f64; 3],
    area: f64,
    lo: [f64; 3],
    hi: [f64; 3],
    centroid: [f64; 3],
    corners: [[f64; 3]; 3],
}

/// Whether two triangles' projections onto the plane normal to `n` overlap
/// in a region of positive area (separating axis test, touching excluded).
fn projections_overlap(n: [f64; 3], a: &[[f64; 3]; 3], b: &[[f64; 3]; 3]) -> bool {
    // Drop the dominant axis of `n`.
    let k = (0..3).max_by(|&i, &j| n[i].abs().total_cmp(&n[j].abs())).unwrap_or(2);
    let (u, v) = ((k + 1) % 3, (k + 2) % 3);
    let pa = a.map(|p| [p[u], p[v]]);
    let pb = b.map(|p| [p[u], p[v]]);
    let scale = pa.iter().chain(&pb).flat_map(|p| p.iter()).fold(0.0f64, |m, c| m.max(c.abs()));
    let eps = 1.0e-9 * scale.max(1.0);
    for tri in [&pa, &pb] {
        for i in 0..3 {
            let (p, q) = (tri[i], tri[(i + 1) % 3]);
            let axis = [q[1] - p[1], p[0] - q[0]];
            let proj = |t: &[[f64; 2]; 3]| {
                t.iter().map(|c| c[0] * axis[0] + c[1] * axis[1]).fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), x| (lo.min(x), hi.max(x)))
            };
            let ((alo, ahi), (blo, bhi)) = (proj(&pa), proj(&pb));
            let len = (axis[0] * axis[0] + axis[1] * axis[1]).sqrt();
            if ahi <= blo + eps * len || bhi <= alo + eps * len {
                return false;
            }
        }
    }
    true
}

/// The normal-bucket key of `n` on grid `grid` (one bit per component): bit
/// clear, cells centred on multiples of the bucket width (`round`); bit set,
/// cells bounded by them (`floor`). Both grids map onto themselves under
/// negation, so the bucket of `-n` is [`partner_key`] of the bucket of `n`,
/// and two normals within half a bucket per component share a cell on at
/// least one of the eight grids, wherever the cell boundaries fall.
fn bucket_key(n: [f64; 3], grid: usize) -> [i64; 3] {
    [0, 1, 2].map(|k| {
        let x = n[k] / NORMAL_BUCKET;
        if grid >> k & 1 == 0 { x.round() as i64 } else { x.floor() as i64 }
    })
}

fn partner_key(key: [i64; 3], grid: usize) -> [i64; 3] {
    [0, 1, 2].map(|k| if grid >> k & 1 == 0 { -key[k] } else { -key[k] - 1 })
}

/// The centre of a bucket cell: a sort direction as coarse as the bucket.
fn bucket_centre(key: [i64; 3], grid: usize) -> [f64; 3] {
    [0, 1, 2].map(|k| (key[k] as f64 + if grid >> k & 1 == 0 { 0.0 } else { 0.5 }) * NORMAL_BUCKET)
}

fn thin_material(tris: &[[usize; 3]], p: &[[f64; 3]], row: &mut Row) {
    let Some(&anchor) = p.first() else { return };
    let (mut lo, mut hi) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
    for v in p {
        for k in 0..3 {
            lo[k] = lo[k].min(v[k]);
            hi[k] = hi[k].max(v[k]);
        }
    }
    let diag = dot(sub(hi, lo), sub(hi, lo)).sqrt();
    // The sort key is a face's offset along its bucket's centre normal, off
    // the true plane offset by up to about the cell diagonal times the faces'
    // distance apart: widen the window by twice the bucket width for that.
    let window = THIN + 2.0 * NORMAL_BUCKET * diag;
    let mut faces: Vec<Face> = Vec::new();
    for t in tris {
        let [a, b, c] = t.map(|i| sub(p[i], anchor));
        let e = cross(sub(b, a), sub(c, a));
        let len = dot(e, e).sqrt();
        if len <= 1.0e-12 {
            continue;
        }
        faces.push(Face {
            n: e.map(|v| v / len),
            area: len / 2.0,
            lo: [0, 1, 2].map(|k| a[k].min(b[k]).min(c[k])),
            hi: [0, 1, 2].map(|k| a[k].max(b[k]).max(c[k])),
            centroid: [0, 1, 2].map(|k| (a[k] + b[k] + c[k]) / 3.0),
            corners: [a, b, c],
        });
    }
    // Per face: 1 thin, 2 coincident, 3 both; and whether it hit the cap.
    let mut thin = vec![0u8; faces.len()];
    let mut capped = vec![false; faces.len()];
    for grid in 0..8 {
        // Ordered, so every sum runs in one order and two runs agree bit for bit.
        let mut buckets: BTreeMap<[i64; 3], Vec<usize>> = BTreeMap::new();
        for (i, f) in faces.iter().enumerate() {
            buckets.entry(bucket_key(f.n, grid)).or_default().push(i);
        }
        for (key, members) in &buckets {
            // Each bucket meets the bucket of its negated normal once.
            let partner = partner_key(*key, grid);
            let Some(partners) = buckets.get(&partner).filter(|_| *key <= partner) else { continue };
            let q = bucket_centre(*key, grid);
            // (sort key, face, side): side false for this bucket, true for the partner's.
            let mut order: Vec<(f64, usize, bool)> = members
                .iter()
                .map(|&i| (dot(q, faces[i].centroid), i, false))
                .chain(partners.iter().map(|&i| (dot(q, faces[i].centroid), i, true)))
                .collect();
            order.sort_by(|x, y| x.0.total_cmp(&y.0).then(x.1.cmp(&y.1)));
            for a in 0..order.len() {
                let (sa, i, side) = order[a];
                let mut seen = 0;
                for &(sb, j, other) in &order[a + 1..] {
                    if sb - sa > window {
                        break;
                    }
                    let (f, g) = (&faces[i], &faces[j]);
                    if side == other
                        || !(0..3).all(|k| f.lo[k] - THIN < g.hi[k] && g.lo[k] - THIN < f.hi[k])
                    {
                        continue;
                    }
                    // Only candidates whose bounds overlap spend the cap, so
                    // disjoint faces on the partner plane cannot exhaust it first.
                    if seen == MAX_CANDIDATES {
                        capped[i] = true;
                        break;
                    }
                    seen += 1;
                    if !projections_overlap(f.n, &f.corners, &g.corners) {
                        continue;
                    }
                    // Each centroid's height above the OTHER face's own plane:
                    // both at most zero (facing away) and above -THIN.
                    let d1 = dot(f.n, sub(g.centroid, f.centroid));
                    let d2 = dot(g.n, sub(f.centroid, g.centroid));
                    let slack = 1.0e-9;
                    if d1 <= slack && d2 <= slack && d1 > -THIN && d2 > -THIN {
                        let gap = (-d1).max(-d2).max(0.0);
                        let class = if gap <= COINCIDENT { 2 } else { 1 };
                        thin[i] |= class;
                        thin[j] |= class;
                        if class == 2 {
                            continue;
                        }
                        if std::env::var_os("MESH_CENSUS_DEBUG").is_some() {
                            eprintln!(
                                "thin pair gap {gap:.3e} areas {:.4} {:.4} n {:?} c {:?} {:?}",
                                f.area, g.area, f.n, f.centroid, g.centroid
                            );
                        }
                        row.thin_min_gap = Some(row.thin_min_gap.map_or(gap, |m: f64| m.min(gap)));
                    }
                }
            }
        }
    }
    for ((f, t), c) in faces.iter().zip(&thin).zip(&capped) {
        if t & 1 != 0 {
            row.thin_faces += 1;
            row.thin_area += f.area;
        }
        if t & 2 != 0 {
            row.coincident_area += f.area;
        }
        row.thin_capped += usize::from(*c);
    }
}
