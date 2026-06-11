// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Diagnostic harness: audit every IfcCovering mesh in a model for geometric
// anomalies (degenerate/zero-thickness output, extreme-aspect triangles,
// surface-area vs AABB mismatch). Emits one JSON line per covering so the
// outliers can be cross-referenced against the STEP representation chain.
//
// Usage: cargo run -q -p ifc-lite-processing --example covering_audit -- <model.ifc> [IfcType]
use ifc_lite_processing::process_geometry;
use std::fs;

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("usage: covering_audit <model.ifc> [IfcType]");
    let want_type = args.next().unwrap_or_else(|| "IfcCovering".to_string());
    let content = fs::read_to_string(&path).expect("read model");
    let result = process_geometry(&content);
    eprintln!("total meshes: {}", result.meshes.len());

    // Aggregate per express_id (an element may emit several sub-meshes).
    use std::collections::BTreeMap;
    struct Agg {
        name: String,
        global_id: String,
        tris: usize,
        min: [f32; 3],
        max: [f32; 3],
        area: f64,
        degen: usize,     // near-zero-area triangles
        max_aspect: f64,  // worst triangle aspect ratio (longest edge / height)
        max_edge: f64,
    }
    let mut per: BTreeMap<u32, Agg> = BTreeMap::new();

    for m in &result.meshes {
        if m.ifc_type != want_type {
            continue;
        }
        let agg = per.entry(m.express_id).or_insert_with(|| Agg {
            name: m.name.clone().unwrap_or_default(),
            global_id: m.global_id.clone().unwrap_or_default(),
            tris: 0,
            min: [f32::MAX; 3],
            max: [f32::MIN; 3],
            area: 0.0,
            degen: 0,
            max_aspect: 0.0,
            max_edge: 0.0,
        });
        for p in m.positions.chunks_exact(3) {
            for k in 0..3 {
                agg.min[k] = agg.min[k].min(p[k]);
                agg.max[k] = agg.max[k].max(p[k]);
            }
        }
        for t in m.indices.chunks_exact(3) {
            agg.tris += 1;
            let v = |i: u32| {
                let o = (i as usize) * 3;
                [
                    m.positions[o] as f64,
                    m.positions[o + 1] as f64,
                    m.positions[o + 2] as f64,
                ]
            };
            let (a, b, c) = (v(t[0]), v(t[1]), v(t[2]));
            let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            let ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            let bc = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
            let cross = [
                ab[1] * ac[2] - ab[2] * ac[1],
                ab[2] * ac[0] - ab[0] * ac[2],
                ab[0] * ac[1] - ab[1] * ac[0],
            ];
            let area2 = (cross[0] * cross[0] + cross[1] * cross[1] + cross[2] * cross[2]).sqrt();
            let area = 0.5 * area2;
            agg.area += area;
            let elen = |e: &[f64; 3]| (e[0] * e[0] + e[1] * e[1] + e[2] * e[2]).sqrt();
            let (lab, lac, lbc) = (elen(&ab), elen(&ac), elen(&bc));
            let longest = lab.max(lac).max(lbc);
            agg.max_edge = agg.max_edge.max(longest);
            if area < 1e-10 {
                agg.degen += 1;
            } else {
                // aspect = longest_edge^2 / (2*area)  (~ longest/height)
                let aspect = longest * longest / (2.0 * area);
                if aspect > agg.max_aspect {
                    agg.max_aspect = aspect;
                }
            }
        }
    }

    for (id, a) in &per {
        let dims = [
            (a.max[0] - a.min[0]) as f64,
            (a.max[1] - a.min[1]) as f64,
            (a.max[2] - a.min[2]) as f64,
        ];
        println!(
            "{{\"id\":{},\"gid\":\"{}\",\"name\":\"{}\",\"tris\":{},\"dims\":[{:.4},{:.4},{:.4}],\"aabb_min\":[{:.4},{:.4},{:.4}],\"area\":{:.6},\"degen\":{},\"max_aspect\":{:.1},\"max_edge\":{:.4}}}",
            id, a.global_id, a.name, a.tris, dims[0], dims[1], dims[2],
            a.min[0], a.min[1], a.min[2], a.area, a.degen, a.max_aspect, a.max_edge
        );
    }
    eprintln!("{} {} elements audited", per.len(), want_type);
}
