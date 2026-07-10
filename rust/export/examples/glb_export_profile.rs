// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Reproducible GLB-export profile: splits export wall-time into phases so
//! throughput work can be attributed and re-measured instead of trusting
//! un-rerunnable external benchmark ratios.
//!
//! ```text
//! cargo run --release -p ifc-lite-export --example glb_export_profile -- <file.ifc> [--top N]
//! ```
//!
//! Phases reported:
//! 1. `index` - `build_entity_index` (the scan)
//! 2. `mesh` - `process_geometry` (full mesher; the suspected dominant phase)
//! 3. `export` - `export_glb_with_stats` end to end. It re-runs index+mesh
//!    internally, so `assemble+serialize ~= export - index - mesh` is an
//!    approximation, printed as such.
//!
//! Attribution: per-IFC-type mesh/vertex/triangle mass from the meshing
//! result (top N by triangles), which localizes WHERE the geometry cost sits
//! without instrumenting the mesher's hot loop. Per-element timers can be
//! added later behind a feature if type-level attribution proves too coarse.
//!
//! This is a measurement harness, NOT a regression gate: run on a quiet
//! machine, compare medians across runs, and treat single runs as noisy.

use std::collections::HashMap;
use std::time::Instant;

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().unwrap_or_else(|| {
        eprintln!("usage: glb_export_profile <file.ifc> [--top N]");
        std::process::exit(2);
    });
    // Strict flag parsing: a measurement tool that silently ignores a typo
    // records numbers under settings the caller did not ask for.
    let mut top_n = 15usize;
    while let Some(a) = args.next() {
        if a == "--top" {
            top_n = args
                .next()
                .and_then(|v| v.parse().ok())
                .unwrap_or_else(|| {
                    eprintln!("--top expects a positive integer");
                    std::process::exit(2);
                });
        } else {
            eprintln!("unknown argument: {a}\nusage: glb_export_profile <file.ifc> [--top N]");
            std::process::exit(2);
        }
    }

    // Force the in-memory assembler so the derived assemble+serialize metric
    // subtracts exactly ONE index+mesh pass. Over the streaming threshold the
    // bounded exporter meshes twice by design, which would misattribute the
    // second pass as assembly cost - the exact misread this harness exists to
    // prevent. Profile the bounded path explicitly via
    // IFC_LITE_GLB_STREAM_THRESHOLD_MB in the environment if that is the goal
    // (the env set here wins only when the caller did not set one).
    if std::env::var("IFC_LITE_GLB_STREAM_THRESHOLD_MB").is_err() {
        std::env::set_var("IFC_LITE_GLB_STREAM_THRESHOLD_MB", "0");
        println!("(in-memory assembler forced for a clean phase split)");
    }

    let content = std::fs::read(&path).unwrap_or_else(|e| {
        eprintln!("read {path}: {e}");
        std::process::exit(2);
    });
    println!("file: {path} ({:.1} MB)", content.len() as f64 / 1.048_576e6);

    // Phase 1: entity index (the scan).
    let t = Instant::now();
    let index = ifc_lite_export::build_entity_index(&content);
    let t_index = t.elapsed();
    println!(
        "index:   {:>9.1} ms  ({} entities)",
        t_index.as_secs_f64() * 1e3,
        index.len()
    );

    // Phase 2: full meshing (the suspected dominant phase).
    let t = Instant::now();
    let result = ifc_lite_processing::process_geometry(&content);
    let t_mesh = t.elapsed();
    let total_tris: usize = result.meshes.iter().map(|m| m.indices.len() / 3).sum();
    let total_verts: usize = result.meshes.iter().map(|m| m.positions.len() / 3).sum();
    println!(
        "mesh:    {:>9.1} ms  ({} meshes, {} verts, {} tris; {:.2} Mtris/s)",
        t_mesh.as_secs_f64() * 1e3,
        result.meshes.len(),
        total_verts,
        total_tris,
        total_tris as f64 / t_mesh.as_secs_f64() / 1e6,
    );

    // Faceted-brep point-cache instrumentation (perf/brep-point-cache hoist).
    // `hits / (hits + misses)` is the cross-element memoization rate: a high rate
    // on a shared-CartesianPoint model means the per-worker cache served shared
    // points instead of re-parsing them per part (the case-047/048 driver).
    // `faceted_brep_time_ms` is populated only when built with `--features
    // observability` (native); it is 0 otherwise.
    let s = &result.stats;
    let cache_refs = s.point_cache_hits + s.point_cache_misses;
    let hit_rate = if cache_refs > 0 {
        s.point_cache_hits as f64 / cache_refs as f64 * 100.0
    } else {
        0.0
    };
    println!(
        "brep pt-cache: {} hits, {} misses ({:.1}% memoized over {} point refs); faceted-brep phase {} ms",
        s.point_cache_hits, s.point_cache_misses, hit_rate, cache_refs, s.faceted_brep_time_ms,
    );

    // Per-type attribution of the geometry mass (top N by triangles).
    let mut by_type: HashMap<&str, (usize, usize)> = HashMap::new();
    for m in &result.meshes {
        let e = by_type.entry(m.ifc_type.as_str()).or_insert((0, 0));
        e.0 += 1;
        e.1 += m.indices.len() / 3;
    }
    let mut rows: Vec<_> = by_type.into_iter().collect();
    rows.sort_by_key(|(_, (_, tris))| std::cmp::Reverse(*tris));
    println!("\nper-type geometry mass (top {top_n} by triangles):");
    println!("{:>8}  {:>12}  type", "meshes", "triangles");
    for (ty, (count, tris)) in rows.into_iter().take(top_n) {
        println!("{count:>8}  {tris:>12}  {ty}");
    }
    drop(result);

    // Phase 3: the real export path end to end (index+mesh run again inside).
    let opts = ifc_lite_export::GltfOptions::default();
    let t = Instant::now();
    let (glb, stats) = ifc_lite_export::export_glb_with_stats(&content, &opts);
    let t_export = t.elapsed();
    let assemble = t_export
        .checked_sub(t_index + t_mesh)
        .map(|d| format!("{:.1} ms (approx: export - index - mesh)", d.as_secs_f64() * 1e3))
        .unwrap_or_else(|| "n/a (export ran faster than the separate phases)".to_string());
    println!(
        "\nexport:  {:>9.1} ms  ({} bytes GLB; {} meshes, {} tris after dedup/instancing)",
        t_export.as_secs_f64() * 1e3,
        glb.len(),
        stats.meshes,
        stats.triangles,
    );
    println!("assemble+serialize: {assemble}");
    println!(
        "note: set IFC_LITE_GLB_STREAM_THRESHOLD_MB explicitly to profile the \
         bounded two-pass assembler instead (it meshes twice by design, so the \
         derived assemble+serialize figure does not apply there)."
    );
}
