// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! PRODUCTION wiring test: with the parametric fast path forced ON, the real
//! `process_element_with_voids` pipeline must (a) actually FIRE the analytic cut on
//! rotated rectangular walls, and (b) every fired host's output must be watertight.
//! Correctness vs ground truth is proven separately in `rect_param_parity`; this proves
//! the end-to-end wiring + the production safety invariant.
//!
//! Run: MEASURE_FIXTURE=<path> cargo test --test rect_param_production -- --ignored --nocapture

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner, IfcType};
use ifc_lite_geometry::{propagate_voids_to_parts, GeometryRouter, Mesh};
use rustc_hash::FxHashMap;

const DEFAULT_FIXTURE: &str = "../../tests/models/buildingsmart/wall-with-opening-and-window.ifc";

fn watertight(mesh: &Mesh) -> bool {
    let key = |i: u32| -> (i64, i64, i64) {
        let b = i as usize * 3;
        let q = |v: f32| (v as f64 / 1.0e-4).round() as i64;
        (
            q(mesh.positions[b]),
            q(mesh.positions[b + 1]),
            q(mesh.positions[b + 2]),
        )
    };
    let mut edges: FxHashMap<((i64, i64, i64), (i64, i64, i64)), i32> = FxHashMap::default();
    for tri in mesh.indices.chunks_exact(3) {
        let (ka, kb, kc) = (key(tri[0]), key(tri[1]), key(tri[2]));
        if ka == kb || kb == kc || kc == ka {
            continue;
        }
        for (x, y) in [(ka, kb), (kb, kc), (kc, ka)] {
            let e = if x < y { (x, y) } else { (y, x) };
            *edges.entry(e).or_insert(0) += 1;
        }
    }
    !edges.is_empty() && edges.values().all(|&c| c == 2)
}

fn build_void_index(content: &str, decoder: &mut EntityDecoder) -> FxHashMap<u32, Vec<u32>> {
    let mut void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    let mut scanner = EntityScanner::new(content);
    let mut scan_decoder = EntityDecoder::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if type_name == "IFCRELVOIDSELEMENT" {
            if let Ok(entity) = scan_decoder.decode_at_with_id(id, start, end) {
                if let (Some(host_id), Some(opening_id)) = (entity.get_ref(4), entity.get_ref(5)) {
                    void_index.entry(host_id).or_default().push(opening_id);
                }
            }
        }
    }
    let _ = propagate_voids_to_parts(&mut void_index, content, decoder);
    void_index
}

#[test]
#[ignore = "production wiring test -- run explicitly with MEASURE_FIXTURE"]
fn param_fast_path_fires_in_production_and_is_watertight() {
    let fixture = std::env::var("MEASURE_FIXTURE").unwrap_or_else(|_| DEFAULT_FIXTURE.to_string());
    if !std::path::Path::new(&fixture).exists() {
        eprintln!("skipping: fixture {fixture} not present");
        return;
    }
    let content = std::fs::read_to_string(&fixture).expect("read fixture");
    let entity_index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);
    let void_index = build_void_index(&content, &mut decoder);

    let mut host_ids: Vec<u32> = void_index.keys().copied().collect();
    host_ids.sort_unstable();

    // Force the parametric fast path ON for the production pipeline.
    ifc_lite_geometry::rect_fast::param_set_enabled_override(Some(true));
    let _ = ifc_lite_geometry::rect_fast::take_param_fires();

    let mut fired_hosts = 0usize;
    let mut wt_bad = 0usize;
    let mut total_fires = 0u64;

    for host_id in host_ids {
        let Ok(host) = decoder.decode_by_id(host_id) else { continue };
        if !matches!(
            host.ifc_type,
            IfcType::IfcWall | IfcType::IfcWallStandardCase | IfcType::IfcSlab | IfcType::IfcRoof
                | IfcType::IfcColumn | IfcType::IfcBeam | IfcType::IfcMember | IfcType::IfcPlate
                | IfcType::IfcCovering | IfcType::IfcFooting
        ) {
            continue;
        }
        let _ = ifc_lite_geometry::rect_fast::take_param_fires();
        let Ok(result) = router.process_element_with_voids(&host, &mut decoder, &void_index) else {
            continue;
        };
        let fired = ifc_lite_geometry::rect_fast::take_param_fires();
        if fired == 0 {
            continue; // deferred to the exact kernel
        }
        total_fires += fired;
        fired_hosts += 1;
        if !watertight(&result) {
            wt_bad += 1;
            if wt_bad <= 8 {
                eprintln!("  NON-WATERTIGHT production output: host {host_id}");
            }
        }
    }

    ifc_lite_geometry::rect_fast::param_set_enabled_override(None);

    eprintln!("\n========= PARAM FAST PATH IN PRODUCTION =========");
    eprintln!("fixture            : {fixture}");
    eprintln!("hosts that FIRED   : {fired_hosts}   (total fires {total_fires})");
    eprintln!("non-watertight     : {wt_bad}");
    eprintln!("=================================================\n");

    assert!(
        fired_hosts > 0,
        "the parametric fast path must engage through the production pipeline"
    );
    assert_eq!(
        wt_bad, 0,
        "every fired host's production output must be watertight"
    );
}
