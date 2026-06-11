// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Diagnostic harness #2: drive the WASM viewer's exact element path
// (process_element_with_submeshes — what processGeometryBatch uses for
// elements without openings) natively over every element of a type, and emit
// the same per-element stats as covering_audit so the two pipelines can be
// diffed line by line.
//
// Usage: cargo run -q -p ifc-lite-processing --example covering_audit_submesh -- <model.ifc> [IfcType] [dump_id]
use ifc_lite_core::{build_entity_index, EntityDecoder, IfcType};
use ifc_lite_geometry::GeometryRouter;
use std::fs;

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("usage: covering_audit_submesh <model.ifc> [IfcType] [dump_id]");
    let want_type = args.next().unwrap_or_else(|| "IfcCovering".to_string());
    let dump_id: Option<u32> = args.next().and_then(|s| s.parse().ok());
    let content = fs::read_to_string(&path).expect("read model");

    // Unit scale: detect mm the way the pipeline does (via metadata pass is
    // heavy; schependomlaan-class ArchiCAD files are mm). Allow override.
    let unit_scale: f64 = std::env::var("UNIT_SCALE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0.001);

    let index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, index.clone());
    let router = GeometryRouter::with_scale(unit_scale);

    let want = IfcType::from_str(&want_type);

    let mut audited = 0usize;
    for (&id, &(start, end)) in index.iter() {
        let Ok(entity) = decoder.decode_at_with_id(id, start, end) else {
            continue;
        };
        if entity.ifc_type != want {
            continue;
        }
        let has_rep = entity.get(6).map(|a| !a.is_null()).unwrap_or(false);
        if !has_rep {
            continue;
        }
        let name = entity
            .get(2)
            .and_then(|a| a.as_string())
            .unwrap_or_default()
            .to_string();
        let gid = entity
            .get(0)
            .and_then(|a| a.as_string())
            .unwrap_or_default()
            .to_string();

        let Ok(subs) = router.process_element_with_submeshes(&entity, &mut decoder) else {
            println!("{{\"id\":{},\"gid\":\"{}\",\"name\":\"{}\",\"error\":true}}", id, gid, name);
            continue;
        };

        let mut tris = 0usize;
        let mut min = [f32::MAX; 3];
        let mut max = [f32::MIN; 3];
        let mut area = 0.0f64;
        let mut degen = 0usize;
        let mut max_aspect = 0.0f64;
        for sub in &subs.sub_meshes {
            let m = &sub.mesh;
            for p in m.positions.chunks_exact(3) {
                for k in 0..3 {
                    min[k] = min[k].min(p[k]);
                    max[k] = max[k].max(p[k]);
                }
            }
            for t in m.indices.chunks_exact(3) {
                tris += 1;
                let v = |i: u32| {
                    let o = (i as usize) * 3;
                    [m.positions[o] as f64, m.positions[o + 1] as f64, m.positions[o + 2] as f64]
                };
                let (a, b, c) = (v(t[0]), v(t[1]), v(t[2]));
                let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
                let ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
                let bc = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
                let cr = [
                    ab[1] * ac[2] - ab[2] * ac[1],
                    ab[2] * ac[0] - ab[0] * ac[2],
                    ab[0] * ac[1] - ab[1] * ac[0],
                ];
                let tarea = 0.5 * (cr[0] * cr[0] + cr[1] * cr[1] + cr[2] * cr[2]).sqrt();
                area += tarea;
                let elen = |e: &[f64; 3]| (e[0] * e[0] + e[1] * e[1] + e[2] * e[2]).sqrt();
                let longest = elen(&ab).max(elen(&ac)).max(elen(&bc));
                if tarea < 1e-10 {
                    degen += 1;
                } else {
                    max_aspect = max_aspect.max(longest * longest / (2.0 * tarea));
                }
            }
            if Some(id) == dump_id {
                eprintln!("submesh geometry_id={} tris={}", sub.geometry_id, m.indices.len() / 3);
                for t in m.indices.chunks_exact(3) {
                    let v = |i: u32| {
                        let o = (i as usize) * 3;
                        (m.positions[o], m.positions[o + 1], m.positions[o + 2])
                    };
                    eprintln!("  tri {:?} {:?} {:?}", v(t[0]), v(t[1]), v(t[2]));
                }
            }
        }
        println!(
            "{{\"id\":{},\"gid\":\"{}\",\"name\":\"{}\",\"tris\":{},\"dims\":[{:.4},{:.4},{:.4}],\"area\":{:.6},\"degen\":{},\"max_aspect\":{:.1}}}",
            id, gid, name, tris,
            (max[0] - min[0]) as f64, (max[1] - min[1]) as f64, (max[2] - min[2]) as f64,
            area, degen, max_aspect
        );
        audited += 1;
    }
    eprintln!("{audited} {want_type} elements audited via submesh path");
}
