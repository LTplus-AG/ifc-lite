//! M7 single-element probe: process ONE element through the voids pipeline and
//! dump OBJ artifacts (uncut host, each opening, cut result) for mismatch
//! forensics. Routing is the pure-Rust exact kernel — the only kernel since
//! M9 (the legacy CSG_MANIFOLD/UNION_MANIFOLD oracle env vars now error).
//!
//!   cargo run --release -p ifc-lite-geometry --example m7_probe -- <model.ifc> <element_id> <out_prefix>

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
use ifc_lite_geometry::{propagate_voids_to_parts, GeometryRouter, Mesh};
use rustc_hash::FxHashMap;

fn volume(m: &Mesh) -> f64 {
    m.indices
        .chunks_exact(3)
        .map(|t| {
            let v = |i: u32| {
                let b = i as usize * 3;
                [
                    m.positions[b] as f64,
                    m.positions[b + 1] as f64,
                    m.positions[b + 2] as f64,
                ]
            };
            let (a, b, c) = (v(t[0]), v(t[1]), v(t[2]));
            a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2])
                + a[2] * (b[0] * c[1] - b[1] * c[0])
        })
        .sum::<f64>()
        / 6.0
}

fn write_obj(path: &str, m: &Mesh) {
    let mut s = String::new();
    for v in m.positions.chunks_exact(3) {
        s.push_str(&format!("v {} {} {}\n", v[0], v[1], v[2]));
    }
    for t in m.indices.chunks_exact(3) {
        s.push_str(&format!("f {} {} {}\n", t[0] + 1, t[1] + 1, t[2] + 1));
    }
    std::fs::write(path, s).unwrap();
}

fn main() {
    if std::env::var("CSG_MANIFOLD").is_ok() || std::env::var("UNION_MANIFOLD").is_ok() {
        eprintln!(
            "error: CSG_MANIFOLD/UNION_MANIFOLD have no effect — the Manifold C++ oracle \
             was removed in M9. Every build runs the pure-Rust exact kernel; use the \
             vol_c self-consistency invariants or an external oracle (IfcOpenShell) \
             for ground truth."
        );
        std::process::exit(2);
    }
    let args: Vec<String> = std::env::args().collect();
    let (path, id, prefix) = (&args[1], args[2].parse::<u32>().unwrap(), &args[3]);
    let content = std::fs::read_to_string(path).unwrap();
    let entity_index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);

    let mut void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    {
        let mut scanner = EntityScanner::new(&content);
        let mut d2 = EntityDecoder::new(&content);
        while let Some((eid, tn, s, e)) = scanner.next_entity() {
            if tn == "IFCRELVOIDSELEMENT" {
                if let Ok(ent) = d2.decode_at_with_id(eid, s, e) {
                    if let (Some(h), Some(o)) = (ent.get_ref(4), ent.get_ref(5)) {
                        void_index.entry(h).or_default().push(o);
                    }
                }
            }
        }
        let _ = propagate_voids_to_parts(&mut void_index, &content, &mut d2);
    }

    // Optional 4th arg: comma-separated opening ids to keep for this host
    // (bisect the multi-cutter sequence).
    if let Some(keep) = args.get(4) {
        let keep: Vec<u32> = keep.split(',').filter_map(|s| s.parse().ok()).collect();
        if let Some(v) = void_index.get_mut(&id) {
            v.retain(|o| keep.contains(o));
        }
    }
    let entity = decoder.decode_by_id(id).unwrap();
    let empty: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    let nocut = router
        .process_element_with_voids(&entity, &mut decoder, &empty)
        .unwrap();
    write_obj(&format!("{prefix}_nocut.obj"), &nocut);
    println!(
        "nocut: tris={} vol={:.6}",
        nocut.triangle_count(),
        volume(&nocut)
    );
    if let Some(openings) = void_index.get(&id) {
        for (k, &oid) in openings.iter().enumerate() {
            if let Ok(oe) = decoder.decode_by_id(oid) {
                if let Ok(om) = router.process_element_with_voids(&oe, &mut decoder, &empty) {
                    write_obj(&format!("{prefix}_open{k}_{oid}.obj"), &om);
                    println!(
                        "opening #{oid}: tris={} vol={:.6}",
                        om.triangle_count(),
                        volume(&om)
                    );
                }
            }
        }
    }
    let _ = router.take_csg_failures();
    let _ = ifc_lite_geometry::csg::take_csg_census();
    let cut = router
        .process_element_with_voids(&entity, &mut decoder, &void_index)
        .unwrap();
    for r in ifc_lite_geometry::csg::take_csg_census() {
        let opn = match r.op {
            0 => "DIFF",
            1 => "UNION",
            2 => "INTER",
            _ => "CLIP",
        };
        println!("CSG-OP {} a_tris={} b_tris={}", opn, r.a_tris, r.b_tris);
    }
    write_obj(&format!("{prefix}_cut.obj"), &cut);
    println!(
        "cut: tris={} vol={:.6} kernel={} env={}",
        cut.triangle_count(),
        volume(&cut),
        "pure",
        false,
    );
    for (pid, fails) in router.take_csg_failures() {
        for f in fails {
            println!("FAILURE [{pid}]: {f}");
        }
    }
    for (hid, d) in router.take_host_opening_diagnostics() {
        println!(
            "DIAG host #{hid} {} tris {:?}->{:?} rect_boxes={} csg_failures={} first={:?}",
            d.host_type, d.tris_before, d.tris_after, d.rect_boxes_processed,
            d.csg_failure_count, d.first_failure_label
        );
        for o in d.openings {
            println!(
                "  opening #{} kind={} verts={} guard_saved={}",
                o.opening_id,
                o.kind.as_str(),
                o.vertex_count,
                o.guard_saved
            );
        }
    }
}
