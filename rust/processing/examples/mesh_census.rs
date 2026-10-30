// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Per-mesh quality census for the per-mesh no-worse rule (#8190).
//!
//! Usage: `mesh_census [--ids 1,2,3] <model.ifc>...` — one JSON line per mesh
//! on stdout, models in argument order, meshes in output order.
//!
//! Every row carries the metrics the void-cut gate compares base against
//! branch: open and nonmanifold edges (welded bit for bit, and at 10 um in
//! world coordinates with the mesh origin folded in), slivers above 50:1,
//! the maximum aspect, the area, and THIN SHELLS. A thin shell is a closed
//! connected component, not the mesh's largest, whose mean thickness
//! `2 |V| / A` is under 200 um: the shape of a host sliver standing between
//! two abutting cutters (#8156). Such a sliver is watertight and removes no
//! volume to speak of, so open-edge and volume checks never see it.
//! `scripts/mesh-census-compare.mjs` reads two of these files.

use ifc_lite_processing::{process, MeshData, ProcessingRequest};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::io::{BufWriter, Write};

/// Longest edge over its altitude above which a triangle counts as a sliver.
const SLIVER_ASPECT: f64 = 50.0;
/// World weld for the tolerant edge census and the component split.
const WELD: f64 = 1.0e-5;
/// Mean thickness below which a closed minor component counts as a thin shell.
const THIN_SHELL: f64 = 2.0e-4;

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let mut request = ProcessingRequest::full_pass();
    if args.first().map(String::as_str) == Some("--ids") {
        let list = args.get(1).expect("--ids needs a list");
        let ids: HashSet<u32> = list.split(',').map(|s| s.trim().parse().expect("express id")).collect();
        request = request.ids(Some(Arc::new(ids)));
        args.drain(..2);
    }
    assert!(!args.is_empty(), "usage: mesh_census [--ids 1,2,3] <model.ifc>...");
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
                    "components": row.components, "thinShells": row.thin_shells,
                    "thinArea": row.thin_area, "thinMinThickness": row.thin_min_thickness,
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
    components: usize,
    thin_shells: usize,
    thin_area: f64,
    thin_min_thickness: Option<f64>,
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

fn find(parent: &mut [u32], mut x: u32) -> u32 {
    while parent[x as usize] != x {
        parent[x as usize] = parent[parent[x as usize] as usize];
        x = parent[x as usize];
    }
    x
}

fn census(mesh: &MeshData) -> Row {
    let count = mesh.positions.len() / 3;
    let tris: Vec<[usize; 3]> = mesh
        .indices
        .chunks_exact(3)
        .filter(|t| t.iter().all(|&i| (i as usize) < count))
        .map(|t| [t[0] as usize, t[1] as usize, t[2] as usize])
        .collect();
    let mut row = Row { tris: tris.len(), ..Row::default() };
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

    // Components over the tolerant weld, then closure, area and volume each.
    let mut parent: Vec<u32> = (0..count as u32).collect();
    for t in &tris {
        let v = t.map(|i| tolerant[i]);
        for i in 1..3 {
            let (x, y) = (find(&mut parent, v[0]), find(&mut parent, v[i]));
            if x != y {
                parent[x.max(y) as usize] = x.min(y);
            }
        }
    }
    struct Comp {
        area: f64,
        volume6: f64,
        open: bool,
        anchor: [f64; 3],
    }
    let mut comps: HashMap<u32, Comp> = HashMap::new();
    for t in &tris {
        let root = find(&mut parent, tolerant[t[0]]);
        let [a, b, c] = t.map(|i| p[i]);
        let comp = comps.entry(root).or_insert(Comp { area: 0.0, volume6: 0.0, open: false, anchor: a });
        // About a point of the component, so world magnitude cancels.
        let (a, b, c) = (sub(a, comp.anchor), sub(b, comp.anchor), sub(c, comp.anchor));
        let n = cross(b, c);
        comp.volume6 += dot(a, n);
        let e = cross(sub(b, a), sub(c, a));
        comp.area += dot(e, e).sqrt() / 2.0;
    }
    for (&(x, _), &c) in &uses10 {
        if c != 2 {
            let root = find(&mut parent, x);
            if let Some(comp) = comps.get_mut(&root) {
                comp.open = true;
            }
        }
    }
    row.components = comps.len();
    if comps.len() > 1 {
        let largest = comps.values().map(|c| c.area).fold(0.0, f64::max);
        for comp in comps.values() {
            if comp.open || comp.area >= largest || comp.area <= 0.0 {
                continue;
            }
            let thickness = 2.0 * (comp.volume6 / 6.0).abs() / comp.area;
            if thickness < THIN_SHELL {
                row.thin_shells += 1;
                row.thin_area += comp.area;
                row.thin_min_thickness =
                    Some(row.thin_min_thickness.map_or(thickness, |m: f64| m.min(thickness)));
            }
        }
    }
    row
}
