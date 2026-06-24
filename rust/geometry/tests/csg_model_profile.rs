// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #1109 calibration harness: per-element CSG timing + escalation profile on a
//! real model. Drives the same per-element path as the viewer/native batch
//! (`begin_element()` + the router), reports total wall-time and the slowest
//! elements with their per-boolean and per-element escalation counts, and is how
//! `DEFAULT_ELEMENT_CAP` is calibrated (healthy p99 vs the pathological tail).
//!
//! CAVEAT: this constructs `GeometryRouter` directly with a ZERO RTC offset — it
//! does NOT rebase georeferenced models the way the streaming native/viewer path
//! does. On models with >~10 km world coordinates the f32 jitter fabricates
//! degenerate geometry (see AGENTS.md), skewing the timings/escalation
//! distribution — so calibrate the cap on LOCAL-ORIGIN models only (the shipped
//! `DEFAULT_ELEMENT_CAP` was calibrated on ISSUE_129, a local-origin model).
//!
//! IFCLT_MODEL=/abs/path.ifc cargo test -p ifc-lite-geometry --release \
//!   --test csg_model_profile -- --ignored --nocapture
//!
//! Env knobs (both default to the shipped caps):
//!   IFC_LITE_CSG_BUDGET=0         — unbounded per-boolean (raw #1109 hang)
//!   IFC_LITE_CSG_ELEMENT_BUDGET=0 — unbounded per-element
//!   IFCLT_BUDGET=<n>              — set the per-boolean cap for this run

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
use ifc_lite_geometry::kernel::budget;
use ifc_lite_geometry::{propagate_voids_to_parts, GeometryRouter};
use rustc_hash::FxHashMap;
use std::io::Write;
use std::time::Instant;

fn build_void_index(content: &str) -> FxHashMap<u32, Vec<u32>> {
    let mut idx: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    let mut scanner = EntityScanner::new(content);
    let mut decoder = EntityDecoder::new(content);
    while let Some((id, name, start, end)) = scanner.next_entity() {
        if name == "IFCRELVOIDSELEMENT" {
            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                if let (Some(host), Some(opening)) = (entity.get_ref(4), entity.get_ref(5)) {
                    idx.entry(host).or_default().push(opening);
                }
            }
        }
    }
    let _ = propagate_voids_to_parts(&mut idx, content, &mut decoder);
    idx
}

fn list_products(content: &str) -> Vec<(u32, String)> {
    let mut products = Vec::new();
    let mut scanner = EntityScanner::new(content);
    while let Some((id, name, _, _)) = scanner.next_entity() {
        let n = name;
        if n.starts_with("IFC")
            && (n.contains("WALL") || n.contains("BEAM") || n.contains("COLUMN")
                || n.contains("MEMBER") || n.contains("PLATE") || n.contains("SLAB")
                || n.contains("FOOTING") || n.contains("PILE") || n.contains("RAILING")
                || n.contains("STAIR") || n.contains("ROOF") || n.contains("COVERING")
                || n.contains("BUILDINGELEMENT") || n.contains("PROXY") || n.contains("FLOW")
                || n.contains("DISCRETE") || n.contains("FURNISH")
                || n == "IFCDOOR" || n == "IFCWINDOW")
        {
            products.push((id, n.to_string()));
        }
    }
    products
}

#[derive(Clone)]
struct Rec {
    id: u32,
    ty: String,
    ms: f64,
    peak_escal: u64,
    elem_escal: u64,
    tris: usize,
    openings: usize,
    tripped: bool,
}

#[test]
#[ignore = "manual; needs IFCLT_MODEL"]
fn profile_model() {
    let path = match std::env::var("IFCLT_MODEL") {
        Ok(p) => p,
        Err(_) => { println!("set IFCLT_MODEL=/abs/path.ifc"); return; }
    };
    if let Ok(b) = std::env::var("IFCLT_BUDGET") {
        let v: u64 = b.parse().unwrap_or(0);
        budget::set_cap(if v == 0 { None } else { Some(v) });
    }
    let content = std::fs::read_to_string(&path).expect("read model");
    println!("\n=== #1109 per-element CSG profile (cap={:?}) ===", budget::cap());
    println!("model: {path}  ({} bytes)", content.len());

    let t_parse = Instant::now();
    let entity_index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);
    let void_idx = build_void_index(&content);
    println!("parse+index+voididx: {:.0}ms  (voided hosts: {})",
        t_parse.elapsed().as_secs_f64() * 1000.0, void_idx.len());

    let products = list_products(&content);
    println!("products to process: {}\n", products.len());

    let cap = budget::cap();
    let ecap = budget::element_cap();
    println!("per-element cap: {ecap:?}");
    let mut recs: Vec<Rec> = Vec::new();
    let t_all = Instant::now();
    let mut done = 0usize;
    let mut over_1s = 0usize;
    for (id, ty) in &products {
        let entity = match decoder.decode_by_id(*id) { Ok(e) => e, Err(_) => continue };
        let openings = void_idx.get(id).map(|v| v.len()).unwrap_or(0);
        budget::reset_peak();
        // Open the per-element scope exactly as `produce_element_meshes` does, so
        // the per-element budget engages in this profile harness too.
        budget::begin_element();
        let t = Instant::now();
        let mesh_result = if openings > 0 {
            router.process_element_with_voids(&entity, &mut decoder, &void_idx)
        } else {
            router.process_element(&entity, &mut decoder)
        };
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        // Read the ACTIVE per-thread budget state, not the configured caps:
        // `begin_element()` promotes the element cap to unbounded under an
        // unbounded per-boolean profile, so comparing against `cap`/`ecap` would
        // misclassify. `peak().max(count())` folds in the last in-flight boolean.
        let peak_escal = budget::peak().max(budget::count());
        let elem_escal = budget::element_count();
        let tris = mesh_result.map(|m| m.triangle_count()).unwrap_or(0);
        let tripped = budget::tripped();
        if ms > 1000.0 {
            over_1s += 1;
            // live flush so a hang shows the culprit element immediately
            println!("  [>1s] id={id} {ty} {ms:.0}ms peak_escal={peak_escal} elem_escal={elem_escal} openings={openings} tripped={tripped}");
            let _ = std::io::stdout().flush();
        }
        recs.push(Rec { id: *id, ty: ty.clone(), ms, peak_escal, elem_escal, tris, openings, tripped });
        done += 1;
        if done.is_multiple_of(500) {
            println!("  ...{done}/{} elements, {:.1}s elapsed", products.len(), t_all.elapsed().as_secs_f64());
            let _ = std::io::stdout().flush();
        }
    }
    let total_ms = t_all.elapsed().as_secs_f64() * 1000.0;
    let sum_ms: f64 = recs.iter().map(|r| r.ms).sum();
    let tripped_n = recs.iter().filter(|r| r.tripped).count();

    println!("\nTOTAL serial geometry: {:.0}ms over {} elements", total_ms, recs.len());
    println!("  elements > 1s: {over_1s}");
    println!(
        "  elements that tripped active budgets (per-boolean={cap:?}, per-element={ecap:?}): {tripped_n}"
    );

    recs.sort_by(|a, b| b.ms.partial_cmp(&a.ms).unwrap());
    for k in [1usize, 5, 10, 25, 50, 100] {
        if k <= recs.len() {
            let top: f64 = recs.iter().take(k).map(|r| r.ms).sum();
            println!("  top-{k:<3} slowest = {:.0}ms ({:.0}% of element time)", top, 100.0 * top / sum_ms.max(1.0));
        }
    }
    // escalation distribution (per-element TOTAL across all its booleans)
    let mut elems: Vec<u64> = recs.iter().map(|r| r.elem_escal).collect();
    elems.sort_unstable_by(|a, b| b.cmp(a));
    let pct = |p: f64| elems.get(((elems.len() as f64 * p) as usize).min(elems.len().saturating_sub(1))).copied().unwrap_or(0);
    println!("  per-element TOTAL escalations: max={} p99={} p95={} p90={} p50={}",
        elems.first().copied().unwrap_or(0), pct(0.01), pct(0.05), pct(0.10), pct(0.50));

    println!("\n--- 25 slowest elements ---");
    println!("{:>10}  {:>24}  {:>10}  {:>12}  {:>12}  {:>8}  {:>8}  tripped", "id", "type", "ms", "peak_escal", "elem_escal", "tris", "openings");
    for r in recs.iter().take(25) {
        println!("{:>10}  {:>24}  {:>10.1}  {:>12}  {:>12}  {:>8}  {:>8}  {}",
            r.id, r.ty, r.ms, r.peak_escal, r.elem_escal, r.tris, r.openings, r.tripped);
    }
}
