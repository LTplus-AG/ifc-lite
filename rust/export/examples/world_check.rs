// SPDX-License-Identifier: MPL-2.0
//! Is the geometry in the same place after a change to how it is packed?
//!
//! Walks a GLB's node tree, composes each node's placement, and reduces every
//! triangle to numbers that do not depend on emission order: how many there are,
//! where they all are (AABB and the sum of their centroids), and how much
//! surface they cover. Two files that agree on those describe the same building
//! however differently they store it.
//!
//! Tolerant of the last bits by design. Baked geometry narrows to f32 in world
//! coordinates; instanced geometry narrows in its own frame and is placed by an
//! f64 matrix, so the two cannot be compared for equality and should not be.
use std::collections::HashMap;

fn parse_glb(b: &[u8]) -> (serde_json::Value, Vec<u8>) {
    assert_eq!(&b[0..4], b"glTF", "not a GLB");
    let mut off = 12usize;
    let mut json = None;
    let mut bin = Vec::new();
    while off + 8 <= b.len() {
        let len = u32::from_le_bytes(b[off..off + 4].try_into().unwrap()) as usize;
        let kind = &b[off + 4..off + 8];
        let body = &b[off + 8..off + 8 + len];
        if kind == b"JSON" {
            json = Some(serde_json::from_slice(body).expect("glb json"));
        } else {
            bin = body.to_vec();
        }
        off += 8 + len;
    }
    (json.expect("json chunk"), bin)
}

fn mat_mul(a: &[f64; 16], b: &[f64; 16]) -> [f64; 16] {
    let mut o = [0.0; 16];
    for r in 0..4 {
        for c in 0..4 {
            o[r * 4 + c] = (0..4).map(|k| a[r * 4 + k] * b[k * 4 + c]).sum();
        }
    }
    o
}

fn apply(m: &[f64; 16], p: [f64; 3]) -> [f64; 3] {
    [
        m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
        m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
        m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
    ]
}

const ID: [f64; 16] = [
    1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.,
];

/// glTF stores a node matrix column-major; everything here is row-major.
fn node_local(n: &serde_json::Value) -> [f64; 16] {
    if let Some(m) = n.get("matrix").and_then(|v| v.as_array()) {
        let c: Vec<f64> = m.iter().map(|v| v.as_f64().unwrap()).collect();
        return [
            c[0], c[4], c[8], c[12], //
            c[1], c[5], c[9], c[13], //
            c[2], c[6], c[10], c[14], //
            c[3], c[7], c[11], c[15],
        ];
    }
    let mut m = ID;
    if let Some(s) = n.get("scale").and_then(|v| v.as_array()) {
        m[0] = s[0].as_f64().unwrap();
        m[5] = s[1].as_f64().unwrap();
        m[10] = s[2].as_f64().unwrap();
    }
    if let Some(r) = n.get("rotation").and_then(|v| v.as_array()) {
        let q: Vec<f64> = r.iter().map(|v| v.as_f64().unwrap()).collect();
        let (x, y, z, w) = (q[0], q[1], q[2], q[3]);
        let rot = [
            1. - 2. * (y * y + z * z),
            2. * (x * y - z * w),
            2. * (x * z + y * w),
            0.,
            2. * (x * y + z * w),
            1. - 2. * (x * x + z * z),
            2. * (y * z - x * w),
            0.,
            2. * (x * z - y * w),
            2. * (y * z + x * w),
            1. - 2. * (x * x + y * y),
            0.,
            0.,
            0.,
            0.,
            1.,
        ];
        m = mat_mul(&rot, &m);
    }
    if let Some(t) = n.get("translation").and_then(|v| v.as_array()) {
        m[3] += t[0].as_f64().unwrap();
        m[7] += t[1].as_f64().unwrap();
        m[11] += t[2].as_f64().unwrap();
    }
    m
}

struct Totals {
    triangles: u64,
    min: [f64; 3],
    max: [f64; 3],
    centroid_sum: [f64; 3],
    area: f64,
}

fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: world_check <a.glb> [b.glb]");
    let t = totals(&path);
    println!("{path}");
    report(&t);
    if let Some(other) = std::env::args().nth(2) {
        let u = totals(&other);
        println!("\n{other}");
        report(&u);
        println!("\ndelta");
        println!("  triangles   {}", u.triangles as i64 - t.triangles as i64);
        for (k, axis) in ["x", "y", "z"].iter().enumerate() {
            println!(
                "  {axis} min {:+.6}  max {:+.6}  centroid sum {:+.4}",
                u.min[k] - t.min[k],
                u.max[k] - t.max[k],
                u.centroid_sum[k] - t.centroid_sum[k]
            );
        }
        println!(
            "  area        {:+.4} m2 ({:+.6} %)",
            u.area - t.area,
            (u.area - t.area) / t.area * 100.0
        );
    }
}

fn report(t: &Totals) {
    println!("  triangles    {}", t.triangles);
    println!(
        "  aabb min     [{:.4}, {:.4}, {:.4}]",
        t.min[0], t.min[1], t.min[2]
    );
    println!(
        "  aabb max     [{:.4}, {:.4}, {:.4}]",
        t.max[0], t.max[1], t.max[2]
    );
    println!(
        "  centroid sum [{:.4}, {:.4}, {:.4}]",
        t.centroid_sum[0], t.centroid_sum[1], t.centroid_sum[2]
    );
    println!("  area         {:.4} m2", t.area);
}

fn totals(path: &str) -> Totals {
    let bytes = std::fs::read(path).expect("read glb");
    let (j, bin) = parse_glb(&bytes);
    let nodes = j["nodes"].as_array().cloned().unwrap_or_default();
    let meshes = j["meshes"].as_array().cloned().unwrap_or_default();
    let accessors = j["accessors"].as_array().cloned().unwrap_or_default();
    let views = j["bufferViews"].as_array().cloned().unwrap_or_default();

    // Accessor -> the bytes it names, resolved once and shared, since an
    // instanced file points many nodes at one mesh.
    let read_f32x3 = |acc: usize| -> Vec<[f32; 3]> {
        let a = &accessors[acc];
        let bv = &views[a["bufferView"].as_u64().unwrap() as usize];
        let base = bv["byteOffset"].as_u64().unwrap_or(0) as usize
            + a["byteOffset"].as_u64().unwrap_or(0) as usize;
        let n = a["count"].as_u64().unwrap() as usize;
        assert_eq!(
            a["componentType"].as_u64().unwrap(),
            5126,
            "expected f32 positions"
        );
        (0..n)
            .map(|i| {
                let o = base + i * 12;
                [
                    f32::from_le_bytes(bin[o..o + 4].try_into().unwrap()),
                    f32::from_le_bytes(bin[o + 4..o + 8].try_into().unwrap()),
                    f32::from_le_bytes(bin[o + 8..o + 12].try_into().unwrap()),
                ]
            })
            .collect()
    };
    let read_idx = |acc: usize| -> Vec<u32> {
        let a = &accessors[acc];
        let bv = &views[a["bufferView"].as_u64().unwrap() as usize];
        let base = bv["byteOffset"].as_u64().unwrap_or(0) as usize
            + a["byteOffset"].as_u64().unwrap_or(0) as usize;
        let n = a["count"].as_u64().unwrap() as usize;
        let ct = a["componentType"].as_u64().unwrap();
        (0..n)
            .map(|i| match ct {
                5123 => u16::from_le_bytes(bin[base + i * 2..base + i * 2 + 2].try_into().unwrap())
                    as u32,
                5125 => u32::from_le_bytes(bin[base + i * 4..base + i * 4 + 4].try_into().unwrap()),
                other => panic!("index componentType {other}"),
            })
            .collect()
    };

    // Keyed on both accessors, because the entry holds both. Two primitives
    // can share a POSITION accessor and index it differently, and keying on the
    // positions alone would hand the second one the first one's triangles --
    // silently, in the tool whose job is to prove two paths agree.
    /// One primitive's positions and triangle indices, read once.
    type Geom = (Vec<[f32; 3]>, Vec<u32>);
    let mut cache: HashMap<(usize, usize), Geom> = HashMap::new();
    let mut t = Totals {
        triangles: 0,
        min: [f64::INFINITY; 3],
        max: [f64::NEG_INFINITY; 3],
        centroid_sum: [0.0; 3],
        area: 0.0,
    };

    // Depth-first from every scene root, composing as we go.
    let roots: Vec<usize> = j["scenes"][0]["nodes"]
        .as_array()
        .map(|a| a.iter().map(|v| v.as_u64().unwrap() as usize).collect())
        .unwrap_or_default();
    let mut stack: Vec<(usize, [f64; 16])> = roots.iter().map(|&r| (r, ID)).collect();
    while let Some((ni, parent)) = stack.pop() {
        let n = &nodes[ni];
        let world = mat_mul(&parent, &node_local(n));
        if let Some(children) = n.get("children").and_then(|v| v.as_array()) {
            for c in children {
                stack.push((c.as_u64().unwrap() as usize, world));
            }
        }
        let Some(mi) = n.get("mesh").and_then(|v| v.as_u64()) else {
            continue;
        };
        for prim in meshes[mi as usize]["primitives"].as_array().unwrap() {
            let pacc = prim["attributes"]["POSITION"].as_u64().unwrap() as usize;
            let iacc = prim["indices"].as_u64().unwrap() as usize;
            let entry = cache
                .entry((pacc, iacc))
                .or_insert_with(|| (read_f32x3(pacc), read_idx(iacc)));
            let (pos, idx) = (&entry.0, &entry.1);
            for tri in idx.chunks_exact(3) {
                let p: Vec<[f64; 3]> = tri
                    .iter()
                    .map(|&k| {
                        let v = pos[k as usize];
                        apply(&world, [v[0] as f64, v[1] as f64, v[2] as f64])
                    })
                    .collect();
                t.triangles += 1;
                for k in 0..3 {
                    let c = (p[0][k] + p[1][k] + p[2][k]) / 3.0;
                    t.centroid_sum[k] += c;
                    for v in &p {
                        if v[k] < t.min[k] {
                            t.min[k] = v[k];
                        }
                        if v[k] > t.max[k] {
                            t.max[k] = v[k];
                        }
                    }
                }
                let u = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
                let v = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
                let c = [
                    u[1] * v[2] - u[2] * v[1],
                    u[2] * v[0] - u[0] * v[2],
                    u[0] * v[1] - u[1] * v[0],
                ];
                t.area += 0.5 * (c[0] * c[0] + c[1] * c[1] + c[2] * c[2]).sqrt();
            }
        }
    }
    t
}
