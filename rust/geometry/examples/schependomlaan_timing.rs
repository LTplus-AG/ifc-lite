//! Diagnostic: time the kernel CSG over every wall-with-openings in
//! schependomlaan (the model that freezes the viewer). Reveals whether it's
//! cumulative slowness or a hang on one wall (the last "processing host" print).
//!   cargo run -p ifc-lite-geometry --example schependomlaan_timing

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner, IfcType};
use ifc_lite_geometry::{propagate_voids_to_parts, GeometryRouter};
use rustc_hash::FxHashMap;
use std::time::Instant;

fn build_void_index(content: &str) -> FxHashMap<u32, Vec<u32>> {
    let mut void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    let mut scanner = EntityScanner::new(content);
    let mut decoder = EntityDecoder::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if type_name == "IFCRELVOIDSELEMENT" {
            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                if let (Some(host_id), Some(opening_id)) = (entity.get_ref(4), entity.get_ref(5)) {
                    void_index.entry(host_id).or_default().push(opening_id);
                }
            }
        }
    }
    let _ = propagate_voids_to_parts(&mut void_index, content, &mut decoder);
    void_index
}

fn main() {
    let path = "../tests/models/issues/841_house_stack_overflow.ifc";
    let content = std::fs::read_to_string(path).expect("fixture present");
    let entity_index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);
    let void_index = build_void_index(&content);

    let mut hosts: Vec<u32> = void_index.keys().copied().collect();
    hosts.sort_unstable();
    let mut times: Vec<(u32, f64, usize, usize)> = Vec::new();
    let total = Instant::now();
    for host_id in hosts {
        let entity = match decoder.decode_by_id(host_id) {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !matches!(entity.ifc_type, IfcType::IfcWall | IfcType::IfcWallStandardCase) {
            continue;
        }
        let n_open = void_index.get(&host_id).map(|v| v.len()).unwrap_or(0);
        eprintln!("processing host {host_id} ({n_open} openings)...");
        let t = Instant::now();
        let mesh = router.process_element_with_voids(&entity, &mut decoder, &void_index).ok();
        let ms = t.elapsed().as_secs_f64() * 1e3;
        let tris = mesh.map(|m| m.indices.len() / 3).unwrap_or(0);
        times.push((host_id, ms, n_open, tris));
        if ms > 100.0 {
            eprintln!("  ⚠ SLOW host {host_id}: {ms:.0}ms ({n_open} openings → {tris} tris)");
        }
    }
    let total_ms = total.elapsed().as_secs_f64() * 1e3;
    let kernel = if std::env::var("CSG_MANIFOLD").is_ok() { "MANIFOLD" } else { "KERNEL" };
    let empties = times.iter().filter(|(_, _, _, t)| *t == 0).count();
    eprintln!("\n=== [{kernel}] total CSG {total_ms:.0}ms over {} walls ({empties} produced 0 tris) ===", times.len());
    // per-wall table (sorted by host) for diffing kernel vs manifold
    times.sort_by_key(|&(h, ..)| h);
    for (h, _ms, n, tris) in &times {
        println!("{h} {n} {tris}");
    }
}
