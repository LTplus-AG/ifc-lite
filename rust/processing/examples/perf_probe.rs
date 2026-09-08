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
//! `--fingerprint` checks ordered mesh payloads after timing (excludes text,
//! material definitions, UVs, textures and instancing); see `perf_probe/fingerprint.rs`.

#[path = "perf_probe/fingerprint.rs"]
mod fingerprint;

#[path = "perf_probe/measurement.rs"]
mod measurement;

use ifc_lite_geometry::csg::take_csg_census;
use ifc_lite_processing::ProcessingStats;

/// One fixture's best-of-N measurement plus the isolated scan.
struct Probe {
    path: String,
    file_mb: f64,
    entities: usize,
    index_build_ms: Option<f64>,
    cold_timing: Option<measurement::ColdTiming>,
    // Best-of-N run (selected by minimum total_time_ms).
    stats: ProcessingStats,
    all_totals_ms: Vec<u64>,
    /// Full process_geometry call, including metadata after ProcessingStats closes.
    all_wall_ms: Vec<f64>,
    fingerprints: Option<Vec<String>>,
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

// CSG op codes match `CsgOpRecord.op`.
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
    if let Some(hashes) = &p.fingerprints {
        eprintln!("  ordered mesh FNV-1a64 (per run): {hashes:?}");
    }
    eprintln!("  phase                    ms        % total");
    eprintln!("  full pipeline wall: {:?} ms (includes final metadata)", p.all_wall_ms);
    eprintln!(
        "  parse (pre-geometry)  {:>8}   {:>5.1}%",
        parse,
        pct(parse, total)
    );
    if let Some(index_ms) = p.index_build_ms {
        eprintln!("    - index-scan alone  {index_ms:>8.1}   {:>5.1}%", pct(index_ms as u64, total));
    } else {
        eprintln!("    - isolated index scan skipped (--cold)");
    }
    if let Some(cold) = &p.cold_timing {
        eprintln!("  file read {:.2} ms; full load {:.2} ms (fresh process; OS cache uncontrolled)",
            cold.file_read_ms, cold.full_load_wall_ms);
    }
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
        let hashes = p.fingerprints.as_ref()
            .map(|h| format!(r#","meshFingerprintsFnv1a64":{h:?}"#)).unwrap_or_default();
        let cold = p.cold_timing.as_ref().map(|t| format!(
            r#","fileReadMs":{:.3},"fullLoadWallMs":{:.3},"cold":true"#,
            t.file_read_ms, t.full_load_wall_ms,
        )).unwrap_or_default();
        out.push_str(&format!(
            concat!(
                "  {{",
                r#""path":{},"fileMb":{:.3},"entities":{},"meshes":{},"vertices":{},"triangles":{},"#,
                r#""indexBuildMs":{},"parseMs":{},"entityScanMs":{},"lookupMs":{},"preprocessMs":{},"#,
                r#""geometryMs":{},"facetedBrepMs":{},"totalMs":{},"allTotalsMs":{:?},"#,
                r#""allWallMs":{:?},"#,
                r#""pointCacheHits":{},"pointCacheMisses":{},"csgFailures":{},"degenerateDropped":{}{}{}{}}}"#,
            ),
            serde_json::to_string(&p.path).expect("serialize fixture path"),
            p.file_mb,
            p.entities,
            s.total_meshes,
            s.total_vertices,
            s.total_triangles,
            p.index_build_ms.map(|ms| format!("{ms:.2}")).unwrap_or_else(|| "null".into()),
            s.parse_time_ms,
            s.entity_scan_time_ms,
            s.lookup_time_ms,
            s.preprocess_time_ms,
            s.geometry_time_ms,
            s.faceted_brep_time_ms,
            s.total_time_ms,
            p.all_totals_ms,
            p.all_wall_ms,
            s.point_cache_hits,
            s.point_cache_misses,
            s.total_csg_failures,
            s.degenerate_triangles_dropped,
            census,
            hashes,
            cold,
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
    let mut fingerprint = false;
    let mut suite = false;
    let mut cold = false;
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
            "--fingerprint" => fingerprint = true,
            "--suite" => suite = true,
            "--cold" => cold = true,
            other if other.starts_with("--") => {
                eprintln!("unknown flag: {other}");
                eprintln!("usage: perf_probe [<file.ifc>...] [--suite] [--iters N] [--cold] [--census] [--fingerprint] [--json]");
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
        eprintln!("usage: perf_probe [<file.ifc>...] [--suite] [--iters N] [--cold] [--census] [--fingerprint] [--json]");
        eprintln!("  no fixtures given; try --suite (uses catalogued models on disk)");
        std::process::exit(2);
    }

    if let Err(message) = measurement::validate_cold(cold, iters, fixtures.len()) {
        eprintln!("{message}");
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
        if let Some(p) = measurement::run(f, iters, census, fingerprint, cold) {
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
