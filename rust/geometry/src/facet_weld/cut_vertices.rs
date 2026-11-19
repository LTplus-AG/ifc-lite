// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::{dedup_key, tri_normal};
use crate::mesh::Mesh;

// Post-cut aspect threshold for triggering vertex canonicalization (#1007).
const SLIVER_ASPECT: f64 = 8.0;

/// Aspect ratio (longest / shortest edge) of a triangle, `INFINITY` if degenerate.
#[inline]
fn aspect(a: [f64; 3], b: [f64; 3], c: [f64; 3]) -> f64 {
    let d = |p: [f64; 3], q: [f64; 3]| {
        ((p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2) + (p[2] - q[2]).powi(2)).sqrt()
    };
    let (e0, e1, e2) = (d(a, b), d(b, c), d(c, a));
    let mn = e0.min(e1).min(e2);
    let mx = e0.max(e1).max(e2);
    if mn > 1.0e-9 {
        mx / mn
    } else {
        f64::INFINITY
    }
}

type Region<'a> = &'a [([f64; 3], [f64; 3])];

/// Rebuild a cut mesh from the first raw position in each 100 µm cell when a
/// surviving triangle exceeds the aspect threshold. If a region is provided,
/// the qualifying triangle must touch one of its padded boxes. The rebuild
/// still covers the whole mesh to close near-duplicate cracks (#4698).
/// It drops triangles with collapsed corners and re-derives flat normals.
pub(crate) fn canonicalize_cut_vertices(mesh: &Mesh, region: Option<Region<'_>>) -> Option<Mesh> {
    let vertex_count = mesh.positions.len() / 3;
    if vertex_count < 3 || mesh.indices.len() < 6 {
        return None;
    }

    // Skip the vertex hash build when the raw triangles cannot exceed the
    // aspect threshold after canonicalization. A vertex moves by at most
    // one cell diagonal, so an edge length can change by up to two diagonals.
    const EDGE_SLACK: f64 = 4.0e-4; // > 2·√3·POSITION_DEDUP_GRID
    // The raw scan uses wider boxes because a vertex can move into the
    // canonical scan's region when it takes its cell's representative.
    let pad_region = |slack: f64| -> Option<Vec<([f64; 3], [f64; 3])>> {
        region.map(|boxes| {
            boxes
                .iter()
                .map(|(lo, hi)| {
                    (
                        [lo[0] - slack, lo[1] - slack, lo[2] - slack],
                        [hi[0] + slack, hi[1] + slack, hi[2] + slack],
                    )
                })
                .collect()
        })
    };
    let padded_region = pad_region(EDGE_SLACK);
    let prescan_region = pad_region(2.0 * EDGE_SLACK);
    let tri_in_boxes = |boxes: Option<&[([f64; 3], [f64; 3])]>,
                        a: [f64; 3],
                        b: [f64; 3],
                        c: [f64; 3]|
     -> bool {
        let Some(boxes) = boxes else {
            return true;
        };
        let lo = [
            a[0].min(b[0]).min(c[0]),
            a[1].min(b[1]).min(c[1]),
            a[2].min(b[2]).min(c[2]),
        ];
        let hi = [
            a[0].max(b[0]).max(c[0]),
            a[1].max(b[1]).max(c[1]),
            a[2].max(b[2]).max(c[2]),
        ];
        boxes
            .iter()
            .any(|(blo, bhi)| (0..3).all(|k| lo[k] <= bhi[k] && hi[k] >= blo[k]))
    };
    let tri_in_region = |a: [f64; 3], b: [f64; 3], c: [f64; 3]| -> bool {
        tri_in_boxes(padded_region.as_deref(), a, b, c)
    };
    let raw_may_have_sliver = mesh.indices.chunks_exact(3).any(|c| {
        let (i0, i1, i2) = (c[0] as usize, c[1] as usize, c[2] as usize);
        if i0 >= vertex_count || i1 >= vertex_count || i2 >= vertex_count {
            return false; // the canonical tri build drops it too
        }
        let p = |i: usize| -> [f64; 3] {
            [
                mesh.positions[i * 3] as f64,
                mesh.positions[i * 3 + 1] as f64,
                mesh.positions[i * 3 + 2] as f64,
            ]
        };
        let (a, b, c3) = (p(i0), p(i1), p(i2));
        // Raw coordinates ⇒ the WIDER pre-scan boxes (see pad_region above).
        if !tri_in_boxes(prescan_region.as_deref(), a, b, c3) {
            return false;
        }
        let d = |x: [f64; 3], y: [f64; 3]| {
            ((x[0] - y[0]).powi(2) + (x[1] - y[1]).powi(2) + (x[2] - y[2]).powi(2)).sqrt()
        };
        let (e0, e1, e2) = (d(a, b), d(b, c3), d(c3, a));
        let mn = e0.min(e1).min(e2);
        let mx = e0.max(e1).max(e2);
        // A short-min-edge triangle may canonically merge (dropped) or snap to
        // aspect INFINITY; either way it must take the exact scan.
        mn - EDGE_SLACK <= 1.0e-9 || (mx + EDGE_SLACK) > SLIVER_ASPECT * (mn - EDGE_SLACK)
    });
    if !raw_may_have_sliver {
        return None;
    }

    // Map each vertex to the first raw position in its deduplication cell.
    let pos = |i: usize| -> [f64; 3] {
        [
            mesh.positions[i * 3] as f64,
            mesh.positions[i * 3 + 1] as f64,
            mesh.positions[i * 3 + 2] as f64,
        ]
    };
    let mut canon_of: Vec<usize> = vec![0; vertex_count];
    let mut cpos: Vec<[f64; 3]> = Vec::new();
    {
        // FxHashMap (canonical ids are insertion-ordered via `cpos.len()`, the
        // map is only queried by key — output identical, no tree-balance cost).
        let mut seen: rustc_hash::FxHashMap<(i64, i64, i64), usize> =
            rustc_hash::FxHashMap::default();
        for i in 0..vertex_count {
            let p = pos(i);
            let key = (dedup_key(p[0]), dedup_key(p[1]), dedup_key(p[2]));
            let id = *seen.entry(key).or_insert_with(|| {
                let id = cpos.len();
                cpos.push(p);
                id
            });
            canon_of[i] = id;
        }
    }

    // Triangles as canonical-id triples; drop degenerate / out-of-range.
    let mut tris: Vec<[usize; 3]> = Vec::with_capacity(mesh.indices.len() / 3);
    for c in mesh.indices.chunks_exact(3) {
        let (i0, i1, i2) = (c[0] as usize, c[1] as usize, c[2] as usize);
        if i0 >= vertex_count || i1 >= vertex_count || i2 >= vertex_count {
            continue;
        }
        let (a, b, d) = (canon_of[i0], canon_of[i1], canon_of[i2]);
        if a == b || b == d || a == d {
            continue;
        }
        tris.push([a, b, d]);
    }

    if !tris.iter().any(|t| {
        aspect(cpos[t[0]], cpos[t[1]], cpos[t[2]]) > SLIVER_ASPECT
            && tri_in_region(cpos[t[0]], cpos[t[1]], cpos[t[2]])
    }) {
        return None;
    }

    Some(rebuild_flat_cut_mesh(mesh, &cpos, &tris))
}

fn rebuild_flat_cut_mesh(mesh: &Mesh, cpos: &[[f64; 3]], tris: &[[usize; 3]]) -> Mesh {
    // Rebuild from canonical triangles, deriving flat normals for the cut.
    let mut positions: Vec<f32> = Vec::with_capacity(tris.len() * 9);
    let mut normals: Vec<f32> = Vec::with_capacity(tris.len() * 9);
    let mut indices: Vec<u32> = Vec::with_capacity(tris.len() * 3);
    for t in tris {
        let a = cpos[t[0]];
        let b = cpos[t[1]];
        let c = cpos[t[2]];
        let n = tri_normal(a, b, c).map(|(n, _)| n).unwrap_or([0.0, 0.0, 1.0]);
        let base = (positions.len() / 3) as u32;
        for p in [a, b, c] {
            positions.extend_from_slice(&[p[0] as f32, p[1] as f32, p[2] as f32]);
            normals.extend_from_slice(&[n[0] as f32, n[1] as f32, n[2] as f32]);
        }
        indices.extend_from_slice(&[base, base + 1, base + 2]);
    }
    // Carry the host's placement / frame metadata (origin, rtc, #1474 capture)
    // forward. This pass runs AFTER placement, so a bare rebuild would reset the
    // local-frame origin + #1474 capture to defaults and mis-place exactly the
    // hosts whose cuts slivered. `instance_meta` is dropped (the rebuilt mesh no
    // longer matches its canonical rep) — see `Mesh::rebuilt_like`.
    mesh.rebuilt_like(positions, normals, indices)
}
