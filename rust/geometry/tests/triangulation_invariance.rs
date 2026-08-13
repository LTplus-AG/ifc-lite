// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Is the pipeline invariant to the triangulator's DIAGONAL CHOICE?
//!
//! Ear-clipping picks interior diagonals by a heuristic. For a given polygon
//! many diagonal sets are equally valid: same boundary edges, same total area,
//! same triangle count, no overlap, no degenerate triangles. Nothing downstream
//! is entitled to depend on which one it gets. Where something does, output
//! watertightness is accidental, and any triangulator change, version bump or
//! fast-path refactor can silently tear geometry.
//!
//! The measurement: process every void-hosting element twice, once through each
//! of two independent ear-clippers, and compare open boundary edges. The second
//! triangulator lives behind the `triangulation-alt` feature and is selected at
//! run time by `IFCLITE_TRIANGULATION_ALT`.
//!
//! Run:
//!   cargo test -p ifc-lite-geometry --features triangulation-alt \
//!     --test triangulation_invariance -- --nocapture
//!
//! Without the feature the test reports that it was skipped and passes, so the
//! default `cargo test` stays fast. The golden's own unit tests in
//! [`census_golden`] do NOT need the feature and run in the default suite.
//!
//! # What gates this, and why it is no longer a set of constants
//!
//! It used to be five pinned `BASELINE_*` ceilings over absolute corpus totals.
//! Those totals count defects across whatever the sweep actually meshed, so they
//! could not tell an existing mesh getting worse from an element that had never
//! meshed at all now meshing imperfectly — and they moved the *reassuring* way
//! when an element silently stopped meshing, because its defects left every sum
//! with it. Re-baselining was therefore indistinguishable from covering up.
//!
//! The gate is now a checked-in per-host golden (#2432): one row per swept void
//! host, keyed by `(manifest-relative path, express id)`. Regressions, coverage
//! losses, additions and reclassifications are separate outcomes with separate
//! messages, and the corpus totals are DERIVED from the golden rather than
//! hand-edited, so there is no constant left to bump. `MIN_MODELS` /
//! `MIN_VOID_HOSTS` remain as the floor: every other check is an upper bound, so
//! without them an unpopulated tree satisfies all of them vacuously.
//!
//! Every run also writes the rows it measured to [`RUN_REPORT_PATH`], which CI
//! uploads as an artifact, so re-blessing does not require reproducing the sweep
//! on the machine that disagreed. Re-blessing IN CI is refused outright (see
//! [`census_golden::bless_mode`]): the bless path returns before every check, so
//! a leaked `IFCLITE_CENSUS_BLESS` would leave the lane permanently and silently
//! green, which is worse than a lane that reports a problem.

mod census_golden;

use census_golden::{is_closed_solid, totals, HostRow, PreVoid};
use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
use ifc_lite_geometry::{propagate_voids_to_parts, GeometryRouter, Mesh};
use rustc_hash::FxHashMap;
use std::collections::BTreeSet;
use std::path::PathBuf;

/// The gated corpus: every `.ifc` in `tests/models/manifest.json` up to
/// `MAX_FIXTURE_BYTES`, resolved on disk.
///
/// Driven by the MANIFEST, not by walking the filesystem. No fixture is tracked in
/// git — they are all fetched by `scripts/fixtures/fetch-fixtures.mjs` — so a
/// filesystem walk measures whatever a given machine happens to have accumulated.
/// That is how the pinned baselines first ended up calibrated to one developer's
/// disk (116 models / 1355 void hosts) while CI swept a different population (111 /
/// 1165), which made the ceilings meaningless on CI. The manifest is the same
/// everywhere, so the population is too, and adding a fixture to it still widens
/// coverage for free.
const MAX_FIXTURE_BYTES: u64 = 50 * 1024 * 1024;

/// Per-host golden. See [`census_golden`].
const GOLDEN_PATH: &str = "tests/manifests/watertightness_census.tsv";

/// Where this run's own rows are written, every run, pass or fail.
///
/// Under `target/`, so it is gitignored and never mistaken for the golden. The
/// CI job uploads it as an artifact: the census log prints its per-element lists
/// truncated (`take(12)`, `take(15)`), so before this there was no way to
/// recover what a run actually measured, and re-blessing meant reproducing a
/// ~20-minute sweep over a 1.4 GB fixture corpus on a developer machine and
/// hoping it agreed with the runner. Now a drifted run hands back the exact rows
/// it saw.
const RUN_REPORT_PATH: &str = "../../target/watertightness_census.run.tsv";

const BLESS_ENV: &str = "IFCLITE_CENSUS_BLESS";

const BLESS_CMD: &str = "IFCLITE_CENSUS_BLESS=1 cargo test -p ifc-lite-geometry \
                         --features triangulation-alt --test triangulation_invariance";

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// `(manifest-relative path, absolute path)` for each gated fixture.
///
/// The relative path is the golden's key, NOT the basename: three basenames
/// repeat across the manifest under different vendor directories, and keying on
/// them would let one model's hosts answer for another's.
fn discover_models() -> Vec<(String, PathBuf)> {
    let models = crate_dir().join("..").join("..").join("tests/models");
    let Ok(raw) = std::fs::read_to_string(models.join("manifest.json")) else {
        return Vec::new();
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Vec::new();
    };
    let mut out: Vec<(String, PathBuf)> = json["files"]
        .as_array()
        .map(|files| {
            files
                .iter()
                .filter_map(|f| f["path"].as_str())
                .filter(|p| p.ends_with(".ifc"))
                .map(|rel| (rel.to_string(), models.join(rel)))
                // Size checked against the file ON DISK, not the manifest's recorded
                // `size`: a stale manifest or a replaced fetch would otherwise let an
                // oversized fixture through and silently change the swept population.
                .filter(|(_, p)| {
                    std::fs::metadata(p)
                        .map(|m| m.is_file() && m.len() <= MAX_FIXTURE_BYTES)
                        .unwrap_or(false)
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}

/// Corpus floor. Every other check here is an upper bound or a per-host
/// comparison scoped to the models actually swept, so without this a tree with
/// no fixtures passes all of them while measuring nothing. Set under the
/// manifest's full population (111 models / 1170 void hosts) so a single failed
/// fixture fetch does not red the build, but an unpopulated tree cannot pass.
const MIN_MODELS: usize = 105;
const MIN_VOID_HOSTS: usize = 1100;

/// Arm/disarm the differential oracle. A no-op without the feature, so this file
/// still compiles in the default `cargo test --workspace` run, where the test body
/// early-returns anyway.
#[cfg(feature = "triangulation-alt")]
fn set_alt(on: bool) {
    ifc_lite_geometry::set_alt_triangulator(on);
}
#[cfg(not(feature = "triangulation-alt"))]
fn set_alt(_on: bool) {}

fn void_index(content: &str) -> FxHashMap<u32, Vec<u32>> {
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

/// Same element with NO voids applied: isolates solid construction from CSG.
fn process_no_voids(content: &str, host_id: u32) -> Option<Mesh> {
    let ei = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, ei);
    let entity = decoder.decode_by_id(host_id).ok()?;
    let router = GeometryRouter::with_units(content, &mut decoder);
    router.process_element(&entity, &mut decoder).ok()
}

fn process(content: &str, host_id: u32, voids: &FxHashMap<u32, Vec<u32>>) -> Option<Mesh> {
    let ei = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, ei);
    let entity = decoder.decode_by_id(host_id).ok()?;
    let router = GeometryRouter::with_units(content, &mut decoder);
    router.process_element_with_voids(&entity, &mut decoder, voids).ok()
}

/// Open boundary edges on a 1 mm position-snapped topology, and separately the
/// count of DEGENERATE edges (both endpoints snapping to one position).
///
/// The distinction is load-bearing. A degenerate edge is a self-loop produced by
/// a triangle that collapsed under the snap, which happens wholesale on
/// georeferenced models: `Mesh.positions` is f32, and at UTM-scale coordinates
/// (~5e5) the f32 step is ~3 cm, so a 200 mm wall cannot be represented at all.
/// The pipeline's RTC offset exists to prevent that, but it is applied ABOVE
/// `GeometryRouter::process_element`, which this harness calls directly. Counting
/// self-loops as open boundary would therefore measure a harness artifact rather
/// than a watertightness defect.
fn edge_stats(mesh: &Mesh) -> (usize, usize) {
    let q = |v: f32| (v as f64 * 1.0e3).round() as i64;
    let mut vid: FxHashMap<(i64, i64, i64), u32> = FxHashMap::default();
    let mut id = |i: usize| -> u32 {
        let k = (
            q(mesh.positions[i * 3]),
            q(mesh.positions[i * 3 + 1]),
            q(mesh.positions[i * 3 + 2]),
        );
        let n = vid.len() as u32;
        *vid.entry(k).or_insert(n)
    };
    let mut bal: FxHashMap<(u32, u32), i32> = FxHashMap::default();
    let mut degenerate = 0usize;
    for tri in mesh.indices.chunks_exact(3) {
        let (a, b, c) = (id(tri[0] as usize), id(tri[1] as usize), id(tri[2] as usize));
        if a == b || b == c || c == a {
            degenerate += 1;
            continue; // a collapsed triangle has no meaningful boundary
        }
        for (x, y) in [(a, b), (b, c), (c, a)] {
            let (k, s) = if x < y { ((x, y), 1) } else { ((y, x), -1) };
            *bal.entry(k).or_insert(0) += s;
        }
    }
    (bal.values().filter(|&&v| v != 0).count(), degenerate)
}

fn open_boundary_edges(mesh: &Mesh) -> usize {
    edge_stats(mesh).0
}

/// Byte offset of each entity's `#id=` line, built in ONE pass over the file.
///
/// `representation_type` used to locate every line with `content.find("\n#id=")`,
/// which is O(file) per lookup, and it walks a frontier several levels deep. That
/// was affordable while it ran only for the ~200 torn hosts; the golden needs a
/// representation for all ~1170 swept hosts, and per-lookup scanning of a 50 MB
/// fixture is not. First occurrence wins, matching the `find` it replaces.
fn line_index(content: &str) -> FxHashMap<u32, usize> {
    let mut idx: FxHashMap<u32, usize> = FxHashMap::default();
    let mut pos = 0usize;
    for line in content.split_inclusive('\n') {
        let b = line.as_bytes();
        if b.first() == Some(&b'#') {
            let mut j = 1;
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1;
            }
            if j > 1 && b.get(j) == Some(&b'=') {
                if let Ok(id) = line[1..j].parse::<u32>() {
                    idx.entry(id).or_insert(pos);
                }
            }
        }
        pos += line.len();
    }
    idx
}

/// `RepresentationType` of an element's **Body** representation, read from the
/// STEP text. Prefers the `Body` identifier over `Axis`/`FootPrint`, and
/// resolves `MappedRepresentation` through `IFCMAPPEDITEM` ->
/// `IFCREPRESENTATIONMAP` to the source representation, because the mapped
/// wrapper says nothing about whether the geometry closes.
///
/// This decides whether a torn element is a defect or correct output: a
/// `SurfaceModel` or an `Axis` curve has no watertightness to lose.
fn representation_type(content: &str, lines: &FxHashMap<u32, usize>, id: u32) -> String {
    fn line_of<'a>(content: &'a str, lines: &FxHashMap<u32, usize>, eid: u32) -> Option<&'a str> {
        let i = *lines.get(&eid)?;
        let j = content[i..].find(';')? + i;
        Some(&content[i..j])
    }
    fn refs(line: &str) -> Vec<u32> {
        let mut out = Vec::new();
        let b = line.as_bytes();
        let mut i = 0;
        while i < b.len() {
            if b[i] == b'#' {
                let mut j = i + 1;
                while j < b.len() && b[j].is_ascii_digit() {
                    j += 1;
                }
                if j > i + 1 {
                    if let Ok(v) = line[i + 1..j].parse::<u32>() {
                        out.push(v);
                    }
                }
                i = j;
            } else {
                i += 1;
            }
        }
        out
    }
    /// (identifier, type) of an IFCSHAPEREPRESENTATION line.
    fn ident_and_type(line: &str) -> Option<(String, String)> {
        if !line.contains("IFCSHAPEREPRESENTATION") {
            return None;
        }
        let q: Vec<&str> = line.split('\'').collect();
        if q.len() >= 4 {
            Some((q[1].to_string(), q[3].to_string()))
        } else {
            None
        }
    }
    /// Follow a MappedRepresentation to the type of the mapped source.
    fn resolve_mapped(
        content: &str,
        lines: &FxHashMap<u32, usize>,
        rep_line: &str,
        depth: usize,
    ) -> Option<String> {
        if depth == 0 {
            return None;
        }
        for item in refs(rep_line) {
            let Some(l) = line_of(content, lines, item) else { continue };
            if !l.contains("IFCMAPPEDITEM") {
                continue;
            }
            for m in refs(l) {
                let Some(ml) = line_of(content, lines, m) else { continue };
                if !ml.contains("IFCREPRESENTATIONMAP") {
                    continue;
                }
                for src in refs(ml) {
                    let Some(sl) = line_of(content, lines, src) else { continue };
                    if let Some((_, t)) = ident_and_type(sl) {
                        if t == "MappedRepresentation" {
                            if let Some(inner) = resolve_mapped(content, lines, sl, depth - 1) {
                                return Some(inner);
                            }
                        }
                        return Some(t);
                    }
                }
            }
        }
        None
    }

    // Collect every shape representation reachable from the element.
    let mut found: Vec<(String, String, String)> = Vec::new(); // ident, type, line
    let mut frontier = vec![id];
    let mut seen = std::collections::HashSet::new();
    for _ in 0..5 {
        let mut next = Vec::new();
        for e in frontier {
            if !seen.insert(e) {
                continue;
            }
            let Some(l) = line_of(content, lines, e) else { continue };
            if let Some((ident, t)) = ident_and_type(l) {
                found.push((ident, t, l.to_string()));
                continue; // do not descend into representation items
            }
            next.extend(refs(l));
        }
        frontier = next;
    }
    if found.is_empty() {
        return "unknown".to_string();
    }
    // Prefer Body; fall back to whatever is there.
    let pick = found
        .iter()
        .find(|(ident, _, _)| ident == "Body")
        .unwrap_or(&found[0]);
    if pick.1 == "MappedRepresentation" {
        if let Some(t) = resolve_mapped(content, lines, &pick.2, 4) {
            return t;
        }
    }
    pick.1.clone()
}

/// Largest absolute coordinate in the mesh. f32 has ~24 bits of mantissa, so the
/// representable step is `2^-23 * magnitude`: about 1 mm at 8 km, but ~6 cm at
/// UTM scale (5e5). Above ~1e4 the f64 -> f32 downcast in `tris_to_mesh` cannot
/// preserve millimetre topology, and seams crack for reasons that have nothing to
/// do with the boolean.
/// Magnitude below which f32 comfortably carries the 1 mm topology this metric
/// measures. The f32 step is `2^-23 * magnitude`, so at 1e4 it would already be 1.2 mm
/// — coarser than the snap bucket, which means f32 merge artifacts would still be
/// counted as tears. 1e3 gives a 0.12 mm step, a 10x margin.
const F32_SAFE_MAGNITUDE: f64 = 1.0e3;

fn max_abs_coord(mesh: &Mesh) -> f64 {
    mesh.positions.iter().fold(0.0f64, |m, &v| m.max((v as f64).abs()))
}

fn fmt_host(r: &HostRow) -> String {
    format!(
        "{} #{}  {:<14} open={} tris={}",
        r.model, r.id, r.rep, r.open, r.tris
    )
}

#[test]
fn watertightness_is_invariant_to_the_triangulator() {
    if cfg!(not(feature = "triangulation-alt")) {
        eprintln!(
            "SKIPPED: rerun with --features triangulation-alt to enable the \
             differential oracle"
        );
        return;
    }

    let mut rows: Vec<HostRow> = Vec::new();
    let mut swept_models: BTreeSet<String> = BTreeSet::new();

    let models = discover_models();
    for (rel, path) in &models {
        let Ok(content) = std::fs::read_to_string(path) else {
            continue;
        };
        swept_models.insert(rel.clone());
        let voids = void_index(&content);
        let mut hosts: Vec<u32> = voids.keys().copied().collect();
        hosts.sort_unstable();
        if hosts.is_empty() {
            continue; // nothing to index the lines for
        }
        let lines = line_index(&content);

        for id in hosts {
            set_alt(false);
            let Some(base) = process(&content, id, &voids) else {
                continue;
            };
            set_alt(true);
            let alt = process(&content, id, &voids);
            set_alt(false);

            let (open, degenerate) = edge_stats(&base);
            // Only taken for torn hosts: it is a full second processing pass,
            // and it is only ever read to attribute a tear to construction or
            // to the boolean.
            let pre = if open == 0 {
                PreVoid::NotTaken
            } else {
                match process_no_voids(&content, id).map(|m| open_boundary_edges(&m)) {
                    Some(v) => PreVoid::Open(v),
                    None => PreVoid::Failed,
                }
            };
            rows.push(HostRow {
                model: rel.clone(),
                id,
                rep: representation_type(&content, &lines, id),
                open,
                tris: base.indices.len() / 3,
                collapsed: degenerate > 0,
                far: max_abs_coord(&base) >= F32_SAFE_MAGNITUDE,
                alt: alt.as_ref().map(open_boundary_edges),
                pre,
            });
        }
    }

    let models_seen = swept_models.len();
    let run = totals(&rows);

    println!("\n=== watertightness census (production triangulator) ===");
    println!("void hosts torn: {}/{}", run.torn, run.hosts);
    println!(
        "hosts with collapsed triangles (f32 precision): {}/{}",
        run.collapsed, run.hosts
    );
    println!("TOTAL unmatched edges across corpus: {}", run.open_edges);
    let mut by_rep: std::collections::BTreeMap<&str, usize> = Default::default();
    for r in rows.iter().filter(|r| r.open > 0) {
        *by_rep.entry(r.rep.as_str()).or_insert(0) += 1;
    }
    println!("\n  torn hosts by representation type:");
    for (rep, n) in &by_rep {
        println!(
            "  {:<20} {:>5}   {}",
            rep,
            n,
            if is_closed_solid(rep) { "<- SHOULD be watertight" } else { "open by design" }
        );
    }

    println!("\n=== triangulation invariance sweep ===");
    println!("models swept  : {models_seen} (of {} discovered)", models.len());
    println!("void hosts    : {}", run.hosts);
    println!("non-invariant : {}", run.non_invariant);
    if run.non_invariant > 0 {
        println!("\n  model / element             open(base -> alt)    tris");
        for r in rows.iter().filter(|r| r.diverged()) {
            let alt_open = match r.alt {
                None => "PROCESS FAILED".to_string(),
                Some(v) => v.to_string(),
            };
            println!(
                "  {:<27} {:>4} -> {:<13} {:>5}",
                format!("{} #{}", r.model, r.id),
                r.open,
                alt_open,
                r.tris
            );
        }
    }

    // Split closed-solid tears by whether the boolean caused them, and by
    // whether coordinate magnitude explains them instead. f32 cannot carry mm
    // topology far from the origin.
    let solids: Vec<&HostRow> =
        rows.iter().filter(|r| r.open > 0 && is_closed_solid(&r.rep)).collect();
    let mut near = (0usize, 0usize); // (pre-broken, csg-broke)
    let mut far = (0usize, 0usize);
    let mut pre_failed = 0usize;
    for r in &solids {
        let bucket = if r.far { &mut far } else { &mut near };
        match r.pre {
            PreVoid::Failed => pre_failed += 1,
            PreVoid::Open(0) => bucket.1 += 1,
            PreVoid::Open(_) => bucket.0 += 1,
            // Unreachable: `pre` is always taken for a torn host.
            PreVoid::NotTaken => {}
        }
    }
    println!("\n  closed-solid tears by coordinate magnitude:");
    println!(
        "    |coord| <  {F32_SAFE_MAGNITUDE:e} (f32 step 0.12 mm) : {} pre-broken, {} csg-broke",
        near.0, near.1
    );
    println!(
        "    |coord| >= {F32_SAFE_MAGNITUDE:e} (f32 too coarse)   : {} pre-broken, {} csg-broke",
        far.0, far.1
    );
    println!("\n  closed-solid tears, by origin:");
    println!("    already torn BEFORE any boolean : {}   <- solid construction", near.0 + far.0);
    println!("    watertight before, torn after   : {}   <- CSG kernel", near.1 + far.1);
    println!("    no-void processing failed       : {pre_failed}");

    // Smallest pre-broken closed solids: minimal reproducers for the
    // construction-path defect.
    let mut pre: Vec<&HostRow> = solids
        .iter()
        .filter(|r| matches!(r.pre, PreVoid::Open(v) if v > 0))
        .copied()
        .collect();
    pre.sort_by_key(|r| (r.tris, r.open));
    // Minimal reproducers for the kernel defect: watertight solid in, torn out,
    // at coordinates f32 handles cleanly.
    let mut kern: Vec<&HostRow> = solids
        .iter()
        .filter(|r| r.pre == PreVoid::Open(0) && !r.far)
        .copied()
        .collect();
    kern.sort_by_key(|r| (r.tris, r.open));
    println!("\n  smallest KERNEL-caused tears (watertight in, torn out, f32-safe):");
    println!("    rep            model / element                  open  tris");
    for r in kern.iter().take(12) {
        println!(
            "    {:<14} {:<32} {:>4}  {:>5}",
            r.rep,
            format!("{} #{}", r.model, r.id),
            r.open,
            r.tris
        );
    }
    println!("\n  smallest pre-broken closed solids (no voids applied):");
    println!("    rep            model / element                  open  tris");
    for r in pre.iter().take(15) {
        let p = match r.pre {
            PreVoid::Open(v) => v,
            _ => 0,
        };
        println!(
            "    {:<14} {:<32} {:>4}  {:>5}",
            r.rep,
            format!("{} #{}", r.model, r.id),
            p,
            r.tris
        );
    }

    // Written BEFORE any assertion, INCLUDING the floor below, so every failing
    // run hands back what it measured. An under-populated corpus is precisely
    // when the rows are wanted — they say which models loaded and which did not
    // — and writing after the floor would leave that run with no artifact at all.
    // Best-effort: a read-only target/ must not turn a green census red.
    let report_path = crate_dir().join(RUN_REPORT_PATH);
    if let Some(dir) = report_path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    match std::fs::write(&report_path, census_golden::render(&rows)) {
        Ok(()) => println!("\nthis run's rows: {}", report_path.display()),
        Err(e) => println!("\ncould not write {}: {e}", report_path.display()),
    }

    // FLOOR. Every check below is an upper bound or a comparison scoped to the
    // models actually swept, so a missing or partial `tests/models` tree (shallow
    // clone, fixtures not fetched, path drift) would otherwise yield zeros and a
    // green run that certifies nothing. Writing the run report above it is safe:
    // that file lives under `target/` and is never the gate. What must stay below
    // this floor is the BLESS path, so an under-populated tree can never write a
    // truncated golden.
    assert!(
        models_seen >= MIN_MODELS && run.hosts >= MIN_VOID_HOSTS,
        "corpus under-populated: {models_seen} models / {} void hosts, expected \
         at least {MIN_MODELS} / {MIN_VOID_HOSTS} — fixtures missing, so the checks \
         below would pass vacuously",
        run.hosts
    );

    let golden_path = crate_dir().join(GOLDEN_PATH);
    let golden_text = std::fs::read_to_string(&golden_path).unwrap_or_default();
    let golden = census_golden::parse(&golden_text)
        .unwrap_or_else(|e| panic!("{} is unreadable: {e}", golden_path.display()));

    let bless = census_golden::bless_mode(
        std::env::var_os(BLESS_ENV).is_some(),
        std::env::var_os("CI").is_some_and(|v| !v.is_empty() && v != "0" && v != "false"),
    )
    .unwrap_or_else(|e| panic!("{e}"));

    if bless {
        // Preserve the rows of models this run did NOT sweep, so blessing on a
        // partial fixture tree cannot silently delete their coverage.
        let mut next: Vec<HostRow> = golden
            .iter()
            .filter(|r| !swept_models.contains(&r.model))
            .cloned()
            .collect();
        let kept = next.len();
        next.extend(rows.iter().cloned());
        if let Some(dir) = golden_path.parent() {
            std::fs::create_dir_all(dir).expect("create golden directory");
        }
        std::fs::write(&golden_path, census_golden::render(&next)).expect("write golden");
        println!(
            "\nBLESSED {} — {} swept rows written, {kept} rows kept for unswept models",
            golden_path.display(),
            rows.len()
        );
        return;
    }

    assert!(
        !golden.is_empty(),
        "{} is missing or empty. Generate it with:\n  {BLESS_CMD}",
        golden_path.display()
    );

    let diff = census_golden::diff(&golden, &rows, &swept_models);
    let expected = totals(golden.iter().filter(|r| swept_models.contains(&r.model)));

    println!("\n=== per-host golden ({}) ===", GOLDEN_PATH);
    println!("regressed : {}", diff.regressed.len());
    println!("coverage loss (in golden, produced nothing): {}", diff.missing.len());
    println!("added (newly meshing): {}", diff.added.len());
    println!("reclassified: {}", diff.changed.len());
    println!("improved  : {}", diff.improved.len());
    for d in &diff.improved {
        println!("  IMPROVED  {}  [{}]", fmt_host(&d.run), d.reasons.join("; "));
    }

    // Not a failure: `MIN_MODELS` sits under the corpus precisely so a failed
    // fixture fetch does not red the build, and a model that did not load has no
    // hosts to call missing. But it is the one way coverage can still leave the
    // census quietly, so it is printed rather than left to be inferred.
    let unswept: BTreeSet<&str> = golden
        .iter()
        .map(|r| r.model.as_str())
        .filter(|m| !swept_models.contains(*m))
        .collect();
    if !unswept.is_empty() {
        println!(
            "NOT SWEPT (in the golden, no fixture on disk): {} model(s) — {}",
            unswept.len(),
            unswept.into_iter().collect::<Vec<_>>().join(", ")
        );
    }

    println!("\ncorpus totals (run vs golden, over the {models_seen} swept models):");
    println!("  void hosts        : {} vs {}", run.hosts, expected.hosts);
    println!("  torn hosts        : {} vs {}", run.torn, expected.torn);
    println!("  unmatched edges   : {} vs {}", run.open_edges, expected.open_edges);
    println!("  collapsed hosts   : {} vs {}", run.collapsed, expected.collapsed);
    println!("  genuine defects   : {} vs {}", run.torn_solid, expected.torn_solid);
    println!("  non-invariant     : {} vs {}", run.non_invariant, expected.non_invariant);

    // Regressions first: they are the only outcome that is unambiguously a
    // defect, and burying them under an addition list would repeat the mistake
    // this golden exists to fix.
    assert!(
        diff.regressed.is_empty(),
        "{} host(s) REGRESSED against the golden — an existing mesh got worse:\n{}",
        diff.regressed.len(),
        diff.regressed
            .iter()
            .map(|d| format!("  {}  [{}]", fmt_host(&d.run), d.reasons.join("; ")))
            .collect::<Vec<_>>()
            .join("\n")
    );

    assert!(
        diff.missing.is_empty(),
        "COVERAGE LOSS: {} host(s) in the golden produced NO geometry in this run, \
         from models that WERE swept. Absolute totals read this as an improvement \
         because the missing element's defects leave every sum with it:\n{}",
        diff.missing.len(),
        diff.missing.iter().map(|r| format!("  {}", fmt_host(r))).collect::<Vec<_>>().join("\n")
    );

    assert!(
        diff.added.is_empty(),
        "{} host(s) meshed that the golden does not carry. These are ADDITIONS, not \
         regressions: geometry that produced nothing before produces something now, \
         which inflates every corpus total without anything having degraded. Confirm \
         that is what happened, then re-bless:\n  {BLESS_CMD}\n{}",
        diff.added.len(),
        diff.added.iter().map(|r| format!("  {}", fmt_host(r))).collect::<Vec<_>>().join("\n")
    );

    assert!(
        diff.changed.is_empty(),
        "{} host(s) were RECLASSIFIED — neither better nor worse, but it changes what \
         the census believes it is measuring. Review, then re-bless:\n  {BLESS_CMD}\n{}",
        diff.changed.len(),
        diff.changed
            .iter()
            .map(|d| format!("  {}  [{}]", fmt_host(&d.run), d.reasons.join("; ")))
            .collect::<Vec<_>>()
            .join("\n")
    );

    // Corpus ceilings, DERIVED from the golden rather than pinned as editable
    // constants — there is no number here for a red build to tempt someone into
    // bumping. Implied by the per-host checks above, and kept because they are
    // what would catch a bug in the classifier itself, and because severity
    // (total unmatched edges) has to stay in view alongside counts: a fix once
    // took torn elements 76 -> 62 while driving one reveal wall from 42 unpaired
    // edges to 324, and an element-count gate saw only the improvement.
    for (name, got, want) in [
        ("total unmatched edges", run.open_edges, expected.open_edges),
        ("torn void hosts", run.torn, expected.torn),
        ("hosts with snap-collapsed triangles", run.collapsed, expected.collapsed),
        ("closed solids that are not watertight", run.torn_solid, expected.torn_solid),
        ("hosts depending on the triangulator's diagonal choice", run.non_invariant, expected.non_invariant),
    ] {
        assert!(got <= want, "{name} grew: {got} > {want} (golden-derived)");
    }
}
