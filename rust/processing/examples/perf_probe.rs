// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `perf_probe` - one command to attribute load time across the whole native
//! pipeline (the same Rust code the browser runs through WASM), so a lever can
//! be found and re-measured instead of guessed.
//!
//! It drains the timings the pipeline already publishes
//! (`ProcessingStats.{parse,entity_scan,lookup,preprocess,geometry,total}_time_ms`,
//! the faceted-brep point cache, CSG-failure counts) plus an isolated
//! `build_entity_index` scan, and reports the parse-vs-geometry split with
//! sub-phase breakdown per fixture. It also drains the always-on CSG op census
//! (`--census`) so boolean workload is visible next to wall time.
//!
//! ```text
//! # human table (best-of-N, N=3 by default):
//! cargo run --profile profiling -p ifc-lite-processing --example perf_probe -- \
//!     tests/models/ara3d/schependomlaan.ifc --iters 5 --census
//!
//! # the default suite (every catalogued heavy fixture that is on disk):
//! cargo run --profile profiling -p ifc-lite-processing --example perf_probe -- --suite
//!
//! # machine-readable (JSON to stdout, table to stderr):
//! cargo run --profile profiling -p ifc-lite-processing --example perf_probe -- \
//!     --suite --json > /tmp/perf.json
//! ```
//!
//! Build with `--profile profiling` (release-grade opt + symbols + panic=unwind)
//! so a `samply record` on the produced binary yields a symbolized flamegraph;
//! `--features observability` additionally fills `faceted_brep_time_ms`.
//!
//! This is a measurement harness, NOT a regression gate: run on a quiet machine,
//! it already reports best-of-N to shave scheduler/GC noise, but treat single
//! runs as noisy and compare medians across runs.
//!
//! WASM parity note: `std::time::Instant` traps on wasm32, so in the browser
//! only `geometry_ms`/`total_ms` are self-timed; the parse/scan phases run in
//! JS workers and are timed there (viewer `ifc_model_loaded` PostHog milestones
//! and the console `[stream]` timeline). The *algorithmic* hotspots this probe
//! surfaces are identical on both targets because the Rust code is shared; the
//! WASM-only concerns (per-worker file re-decode, no-threads, memory bandwidth)
//! are orchestration-level and covered by the viewer benchmark, not here. See
//! `scripts/perf/README.md`.

use std::time::Instant;

use ifc_lite_core::build_entity_index;
use ifc_lite_geometry::csg::{reset_csg_census, take_csg_census};
use ifc_lite_processing::{process_geometry, ProcessingStats};

/// One fixture's best-of-N measurement plus the isolated scan.
struct Probe {
    path: String,
    file_mb: f64,
    entities: usize,
    index_build_ms: f64,
    // Best-of-N run (selected by minimum total_time_ms).
    stats: ProcessingStats,
    all_totals_ms: Vec<u64>,
    census: Option<CensusSummary>,
}

/// Aggregate of the always-on CSG op census for one run.
#[derive(Default)]
struct CensusSummary {
    subtract: u64,
    union: u64,
    intersection: u64,
    clip: u64,
    /// Sum of operand triangle counts across every recorded boolean - the real
    /// heavy-path kernel workload (analytic box clips never reach the census).
    operand_tris: u64,
}

// CSG op codes as recorded in `CsgOpRecord.op` (a `u8`, not an exported enum).
// Mirrors ifc_lite_geometry's census numbering; kept as named constants so a
// reorder there surfaces as a one-line change here rather than silently
// swapping the reported counts.
const OP_SUBTRACT: u8 = 0;
const OP_UNION: u8 = 1;
const OP_INTERSECTION: u8 = 2;
const OP_CLIP: u8 = 3;

fn summarize_census() -> CensusSummary {
    let mut s = CensusSummary::default();
    for r in take_csg_census() {
        match r.op {
            OP_SUBTRACT => s.subtract += 1,
            OP_UNION => s.union += 1,
            OP_INTERSECTION => s.intersection += 1,
            OP_CLIP => s.clip += 1,
            _ => {}
        }
        s.operand_tris += r.a_tris as u64 + r.b_tris as u64;
    }
    s
}

fn run(path: &str, iters: usize, want_census: bool) -> Option<Probe> {
    let content = match std::fs::read(path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("skip {path}: {e}");
            return None;
        }
    };
    let file_mb = content.len() as f64 / 1.048_576e6;

    // Isolated scan: build_entity_index alone times the pure structural scan
    // that the pipeline otherwise folds into entity_scan_ms. Best-of-3.
    let mut index_build_ms = f64::INFINITY;
    let mut entities = 0usize;
    for _ in 0..3 {
        let t = Instant::now();
        let idx = build_entity_index(&content);
        let ms = t.elapsed().as_secs_f64() * 1e3;
        entities = idx.len();
        index_build_ms = index_build_ms.min(ms);
    }

    // Full pipeline, best-of-N by total_time_ms. Census (if requested) is
    // drained from the run that was kept, so the op counts match the timing.
    let mut best: Option<ProcessingStats> = None;
    let mut best_total = u64::MAX;
    let mut best_census: Option<CensusSummary> = None;
    let mut all_totals_ms = Vec::with_capacity(iters);
    for _ in 0..iters.max(1) {
        if want_census {
            reset_csg_census();
        }
        let result = process_geometry(&content);
        let census = if want_census {
            Some(summarize_census())
        } else {
            None
        };
        all_totals_ms.push(result.stats.total_time_ms);
        if result.stats.total_time_ms <= best_total {
            best_total = result.stats.total_time_ms;
            best = Some(result.stats);
            best_census = census;
        }
    }

    Some(Probe {
        path: path.to_string(),
        file_mb,
        entities,
        index_build_ms,
        stats: best?,
        all_totals_ms,
        census: best_census,
    })
}

fn pct(part: u64, whole: u64) -> f64 {
    if whole == 0 {
        0.0
    } else {
        part as f64 / whole as f64 * 100.0
    }
}

fn print_human(p: &Probe) {
    let s = &p.stats;
    let total = s.total_time_ms.max(1);
    let parse = s.parse_time_ms;
    let geom = s.geometry_time_ms;
    let tris = s.total_triangles;
    let mtris_s = if geom > 0 {
        tris as f64 / (geom as f64 / 1e3) / 1e6
    } else {
        0.0
    };
    let cache_refs = s.point_cache_hits + s.point_cache_misses;
    let hit_rate = pct(s.point_cache_hits, cache_refs);

    eprintln!("\n=== {} ===", p.path);
    eprintln!(
        "  {:.1} MB | {} entities | {} meshes | {} verts | {} tris | {:.2} Mtris/s (geom)",
        p.file_mb, p.entities, s.total_meshes, s.total_vertices, tris, mtris_s,
    );
    eprintln!(
        "  best total {} ms  (runs: {:?} ms)",
        s.total_time_ms, p.all_totals_ms
    );
    eprintln!("  phase                    ms        % total");
    eprintln!(
        "  parse (pre-geometry)  {:>8}   {:>5.1}%",
        parse,
        pct(parse, total)
    );
    eprintln!(
        "    - index-scan alone  {:>8.1}   {:>5.1}%   (isolated build_entity_index)",
        p.index_build_ms,
        pct(p.index_build_ms as u64, total)
    );
    eprintln!(
        "    - entity_scan       {:>8}   {:>5.1}%",
        s.entity_scan_time_ms,
        pct(s.entity_scan_time_ms, total)
    );
    eprintln!(
        "    - lookup/styles     {:>8}   {:>5.1}%",
        s.lookup_time_ms,
        pct(s.lookup_time_ms, total)
    );
    eprintln!(
        "    - preprocess        {:>8}   {:>5.1}%",
        s.preprocess_time_ms,
        pct(s.preprocess_time_ms, total)
    );
    eprintln!(
        "  geometry              {:>8}   {:>5.1}%",
        geom,
        pct(geom, total)
    );
    if s.faceted_brep_time_ms > 0 {
        eprintln!(
            "    - faceted-brep      {:>8}   {:>5.1}%   (observability build)",
            s.faceted_brep_time_ms,
            pct(s.faceted_brep_time_ms, total)
        );
    }
    if cache_refs > 0 {
        eprintln!(
            "  brep point-cache      {} hits / {} misses ({:.1}% memoized)",
            s.point_cache_hits, s.point_cache_misses, hit_rate
        );
    }
    if s.total_csg_failures > 0 {
        eprintln!(
            "  csg failures          {} across {} products",
            s.total_csg_failures, s.products_with_failures
        );
    }
    if s.degenerate_triangles_dropped > 0 {
        eprintln!(
            "  degenerate dropped    {}",
            s.degenerate_triangles_dropped
        );
    }
    if let Some(c) = &p.census {
        eprintln!(
            "  csg census            {} subtract / {} union / {} intersect / {} clip | {} operand-tris",
            c.subtract, c.union, c.intersection, c.clip, c.operand_tris
        );
    }
}

fn print_json(probes: &[Probe]) {
    // Hand-rolled to avoid pulling serde_json into an example; the shape is
    // small and stable. Emits one object per fixture.
    let mut out = String::from("[\n");
    for (i, p) in probes.iter().enumerate() {
        let s = &p.stats;
        let census = p
            .census
            .as_ref()
            .map(|c| {
                format!(
                    r#","csg":{{"subtract":{},"union":{},"intersection":{},"clip":{},"operandTris":{}}}"#,
                    c.subtract, c.union, c.intersection, c.clip, c.operand_tris
                )
            })
            .unwrap_or_default();
        out.push_str(&format!(
            concat!(
                "  {{",
                r#""path":{:?},"fileMb":{:.3},"entities":{},"meshes":{},"vertices":{},"triangles":{},"#,
                r#""indexBuildMs":{:.2},"parseMs":{},"entityScanMs":{},"lookupMs":{},"preprocessMs":{},"#,
                r#""geometryMs":{},"facetedBrepMs":{},"totalMs":{},"allTotalsMs":{:?},"#,
                r#""pointCacheHits":{},"pointCacheMisses":{},"csgFailures":{},"degenerateDropped":{}{}}}"#,
            ),
            p.path,
            p.file_mb,
            p.entities,
            s.total_meshes,
            s.total_vertices,
            s.total_triangles,
            p.index_build_ms,
            s.parse_time_ms,
            s.entity_scan_time_ms,
            s.lookup_time_ms,
            s.preprocess_time_ms,
            s.geometry_time_ms,
            s.faceted_brep_time_ms,
            s.total_time_ms,
            p.all_totals_ms,
            s.point_cache_hits,
            s.point_cache_misses,
            s.total_csg_failures,
            s.degenerate_triangles_dropped,
            census,
        ));
        out.push_str(if i + 1 < probes.len() { ",\n" } else { "\n" });
    }
    out.push(']');
    println!("{out}");
}

/// Catalogued public manifest fixtures worth profiling, in rough phase-stress
/// order. All are STEP `.ifc` (the probe drives `process_geometry`, the STEP
/// path; IFCX/IFC5 use a separate pipeline and would report zero here) and all
/// are fetchable with `pnpm fixtures <path>`; each is skipped silently when not
/// on disk.
const SUITE: &[&str] = &[
    "tests/models/ara3d/AC20-FZK-Haus.ifc",              // small arch
    "tests/models/various/01_Snowdon_Towers_Sample_Structural(1).ifc", // structural
    "tests/models/various/01_BIMcollab_Example_ARC.ifc", // mid arch
    "tests/models/ara3d/schependomlaan.ifc",            // arch, void-CSG, parse-heavy
    "tests/models/ara3d/ISSUE_053_20181220Holter_Tower_10.ifc", // big parse
    "tests/models/various/O-S1-BWK-BIM architectural - BIM bouwkundig.ifc", // largest
];

fn main() {
    let mut iters = 3usize;
    let mut json = false;
    let mut census = false;
    let mut suite = false;
    let mut fixtures: Vec<String> = Vec::new();

    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--iters" => {
                iters = args
                    .next()
                    .and_then(|v| v.parse().ok())
                    .filter(|n| *n >= 1)
                    .unwrap_or_else(|| {
                        eprintln!("--iters expects a positive integer");
                        std::process::exit(2);
                    });
            }
            "--json" => json = true,
            "--census" => census = true,
            "--suite" => suite = true,
            other if other.starts_with("--") => {
                eprintln!("unknown flag: {other}");
                eprintln!("usage: perf_probe [<file.ifc>...] [--suite] [--iters N] [--census] [--json]");
                std::process::exit(2);
            }
            other => fixtures.push(other.to_string()),
        }
    }
    if suite {
        for f in SUITE {
            fixtures.push((*f).to_string());
        }
    }
    if fixtures.is_empty() {
        eprintln!("usage: perf_probe [<file.ifc>...] [--suite] [--iters N] [--census] [--json]");
        eprintln!("  no fixtures given; try --suite (uses catalogued models on disk)");
        std::process::exit(2);
    }

    eprintln!(
        "perf_probe: {} fixture(s), best-of-{}{}",
        fixtures.len(),
        iters,
        if census { ", +csg-census" } else { "" }
    );

    let mut probes = Vec::new();
    for f in &fixtures {
        if let Some(p) = run(f, iters, census) {
            print_human(&p);
            probes.push(p);
        }
    }

    if json {
        print_json(&probes);
    }

    if probes.is_empty() {
        eprintln!("\nno fixtures measured (all missing?). Fetch with: pnpm fixtures <path>");
        std::process::exit(1);
    }
}
