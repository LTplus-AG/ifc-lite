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
//! default `cargo test` stays fast.
//!
//! The pinned `BASELINE_*` constants are ceilings, not an allow-list: each is a
//! defect count to drive DOWN, and the test fails if any grows. `MIN_MODELS` /
//! `MIN_VOID_HOSTS` are the matching floor, so a corpus that failed to load cannot
//! satisfy the ceilings vacuously.

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
use ifc_lite_geometry::{propagate_voids_to_parts, GeometryRouter, Mesh};
use rustc_hash::FxHashMap;
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

fn discover_models() -> Vec<PathBuf> {
    let models = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("tests/models");
    let Ok(raw) = std::fs::read_to_string(models.join("manifest.json")) else {
        return Vec::new();
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Vec::new();
    };
    let mut out: Vec<PathBuf> = json["files"]
        .as_array()
        .map(|files| {
            files
                .iter()
                .filter(|f| f["path"].as_str().is_some_and(|p| p.ends_with(".ifc")))
                .filter_map(|f| f["path"].as_str())
                .map(|rel| models.join(rel))
                // Size checked against the file ON DISK, not the manifest's recorded
                // `size`: a stale manifest or a replaced fetch would otherwise let an
                // oversized fixture through and silently change the swept population.
                .filter(|p| {
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

/// Pinned baselines over the auto-discovered corpus (116 fixtures, 1355 void
/// hosts, measured 2026-07-29). Counted only for hosts whose coordinates are
/// small enough that f32 can carry millimetre topology (see `max_abs_coord`);
/// far-field hosts are reported but not gated, because this harness runs below
/// the pipeline's RTC offset and their tears are an artifact of that, not of the
/// geometry. Both are defect counts to drive DOWN; the test
/// fails if either grows. `TORN_SOLID` is the number that matters: hosts whose
/// Body representation is a closed solid and which are nonetheless not
/// watertight. SurfaceModel and Tessellation are reported separately because
/// they need not close.
///
/// NB: `Tessellation` is only conditionally open — an `IfcTriangulatedFaceSet`
/// with `Closed = .T.` is a solid. Treating the whole bucket as open is a
/// simplification that UNDER-counts defects; revisit once `BASELINE_TORN_SOLID` is
/// worked down.
const BASELINE_NON_INVARIANT: usize = 133;
const BASELINE_TORN_SOLID: usize = 41;
/// Total torn void hosts across the corpus, and hosts carrying at least one
/// snap-collapsed triangle. Gated so the µm-scatter fix in
/// `prism_cut::dedup_cut_vertices` cannot silently regress: it took these from
/// 257 and 61 respectively.
const BASELINE_TORN_TOTAL: usize = 199;
const BASELINE_COLLAPSED: usize = 51;
/// TOTAL unmatched edges across the corpus, not just the COUNT of torn elements.
///
/// Element counts alone are severity-blind, and that nearly shipped a bad fix: a
/// seam-preserving consolidation took torn elements from 76 down to 62 while
/// driving one reveal wall from 42 unpaired edges to 324. Both readings are "one
/// torn element", so the element gate saw only the improvement. Gate the total so
/// a fix cannot trade many small tears for a few catastrophic ones.
const BASELINE_OPEN_EDGE_TOTAL: usize = 17_792;

/// Corpus floor. The ceilings above are all upper bounds, so without this a tree
/// with no fixtures passes every one of them while measuring nothing. Set just under
/// the manifest's full population (111 models / 1165 void hosts) so a single failed
/// fixture fetch does not red the build, but an unpopulated tree cannot pass.
const MIN_MODELS: usize = 105;
const MIN_VOID_HOSTS: usize = 1100;

/// Representation types that describe a CLOSED solid and are therefore
/// legitimately expected to produce watertight geometry.
fn is_closed_solid(rep: &str) -> bool {
    matches!(rep, "SweptSolid" | "CSG" | "Clipping" | "Brep" | "AdvancedBrep")
}

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

/// `RepresentationType` of an element's **Body** representation, read from the
/// STEP text. Prefers the `Body` identifier over `Axis`/`FootPrint`, and
/// resolves `MappedRepresentation` through `IFCMAPPEDITEM` ->
/// `IFCREPRESENTATIONMAP` to the source representation, because the mapped
/// wrapper says nothing about whether the geometry closes.
///
/// This decides whether a torn element is a defect or correct output: a
/// `SurfaceModel` or an `Axis` curve has no watertightness to lose.
fn representation_type(content: &str, id: u32) -> String {
    fn line_of(content: &str, eid: u32) -> Option<&str> {
        let pat = format!("\n#{eid}=");
        let i = content.find(&pat)? + 1;
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
    fn resolve_mapped(content: &str, rep_line: &str, depth: usize) -> Option<String> {
        if depth == 0 {
            return None;
        }
        for item in refs(rep_line) {
            let Some(l) = line_of(content, item) else { continue };
            if !l.contains("IFCMAPPEDITEM") {
                continue;
            }
            for m in refs(l) {
                let Some(ml) = line_of(content, m) else { continue };
                if !ml.contains("IFCREPRESENTATIONMAP") {
                    continue;
                }
                for src in refs(ml) {
                    let Some(sl) = line_of(content, src) else { continue };
                    if let Some((_, t)) = ident_and_type(sl) {
                        if t == "MappedRepresentation" {
                            if let Some(inner) = resolve_mapped(content, sl, depth - 1) {
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
            let Some(l) = line_of(content, e) else { continue };
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
        if let Some(t) = resolve_mapped(content, &pick.2, 4) {
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

struct Divergence {
    model: String,
    id: u32,
    base_open: usize,
    alt_open: Option<usize>,
    base_tris: usize,
    alt_tris: usize,
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

    let mut divergences: Vec<Divergence> = Vec::new();
    // Absolute census: hosts that are not watertight AT ALL, independent of
    // which triangulator ran. Separate defect class from non-invariance.
    let mut torn: Vec<(String, String, u32, usize)> = Vec::new();
    // Open edges of the SAME element with no voids applied, index-aligned to `torn`.
    let mut pre_tears: Vec<usize> = Vec::new();
    let mut tri_counts: Vec<usize> = Vec::new();
    // Hosts with at least one triangle collapsed by the 1 mm snap: f32 precision
    // loss on large coordinates, not a topology defect.
    let mut collapsed = 0usize;
    let mut open_edge_total = 0usize;
    // Largest |coordinate| per torn host, index-aligned to `torn`.
    let mut mags: Vec<f64> = Vec::new();
    let mut swept = 0usize;
    let mut models_seen = 0usize;

    let models = discover_models();
    for path in &models {
        let Ok(content) = std::fs::read_to_string(path) else {
            continue;
        };
        models_seen += 1;
        let basename = path
            .file_name()
            .map(|f| f.to_string_lossy().into_owned())
            .unwrap_or_default();
        let voids = void_index(&content);
        let mut hosts: Vec<u32> = voids.keys().copied().collect();
        hosts.sort_unstable();

        for id in hosts {
            set_alt(false);
            let Some(base) = process(&content, id, &voids) else {
                continue;
            };
            set_alt(true);
            let alt = process(&content, id, &voids);
            set_alt(false);

            swept += 1;
            let bo = open_boundary_edges(&base);
            if edge_stats(&base).1 > 0 {
                collapsed += 1;
            }
            open_edge_total += bo;
            if bo > 0 {
                mags.push(max_abs_coord(&base));
                let rep = representation_type(&content, id);
                // Was it already torn BEFORE any boolean?
                let pre = process_no_voids(&content, id)
                    .map(|m| open_boundary_edges(&m))
                    .unwrap_or(usize::MAX);
                torn.push((rep, basename.clone(), id, bo));
                pre_tears.push(pre);
                tri_counts.push(base.indices.len() / 3);
            }
            match alt {
                None => divergences.push(Divergence {
                    model: basename.clone(),
                    id,
                    base_open: bo,
                    alt_open: None,
                    base_tris: base.indices.len() / 3,
                    alt_tris: 0,
                }),
                Some(alt) => {
                    let ao = open_boundary_edges(&alt);
                    if bo != ao {
                        divergences.push(Divergence {
                            model: basename.clone(),
                            id,
                            base_open: bo,
                            alt_open: Some(ao),
                            base_tris: base.indices.len() / 3,
                            alt_tris: alt.indices.len() / 3,
                        });
                    }
                }
            }
        }
    }

    println!("\n=== watertightness census (production triangulator) ===");
    println!("void hosts torn: {}/{swept}", torn.len());
    println!("hosts with collapsed triangles (f32 precision): {collapsed}/{swept}");
    println!("TOTAL unmatched edges across corpus: {open_edge_total}");
    let mut by_rep: std::collections::BTreeMap<String, usize> = Default::default();
    for (rep, _, _, _) in &torn {
        *by_rep.entry(rep.clone()).or_insert(0) += 1;
    }
    println!("\n  torn hosts by representation type:");
    for (rep, n) in &by_rep {
        let closed = matches!(rep.as_str(), "SweptSolid" | "CSG" | "Clipping" | "Brep" | "AdvancedBrep");
        println!("  {:<20} {:>5}   {}", rep, n, if closed { "<- SHOULD be watertight" } else { "open by design" });
    }

    println!("\n=== triangulation invariance sweep ===");
    println!("models swept  : {models_seen} (of {} discovered)", models.len());
    println!("void hosts    : {swept}");
    println!("non-invariant : {}", divergences.len());
    if !divergences.is_empty() {
        println!("\n  model / element             open(base -> alt)    tris(base -> alt)");
        for d in &divergences {
            let alt_open = match d.alt_open {
                None => "PROCESS FAILED".to_string(),
                Some(v) => v.to_string(),
            };
            println!(
                "  {:<27} {:>4} -> {:<13} {:>5} -> {}",
                format!("{} #{}", d.model, d.id),
                d.base_open,
                alt_open,
                d.base_tris,
                d.alt_tris
            );
        }
    }

    // Split closed-solid tears by whether the boolean caused them.
    let mut pre_broken = 0usize;
    let mut csg_broke = 0usize;
    let mut pre_failed = 0usize;
    for (i, (rep, _, _, _)) in torn.iter().enumerate() {
        if !is_closed_solid(rep) {
            continue;
        }
        match pre_tears[i] {
            usize::MAX => pre_failed += 1,
            0 => csg_broke += 1,
            _ => pre_broken += 1,
        }
    }
    // Is the tear population explained by coordinate magnitude rather than by
    // the boolean? f32 cannot carry mm topology far from the origin.
    // (pre-broken, csg-broke), split at `F32_SAFE_MAGNITUDE`.
    let mut near = (0usize, 0usize);
    let mut far = (0usize, 0usize);
    for (i, (rep, _, _, _)) in torn.iter().enumerate() {
        if !is_closed_solid(rep) {
            continue;
        }
        let bucket = if mags[i] < F32_SAFE_MAGNITUDE { &mut near } else { &mut far };
        match pre_tears[i] {
            0 => bucket.1 += 1,
            usize::MAX => {}
            _ => bucket.0 += 1,
        }
    }
    println!("\n  closed-solid tears by coordinate magnitude:");
    println!("    |coord| <  {F32_SAFE_MAGNITUDE:e} (f32 step 0.12 mm) : {} pre-broken, {} csg-broke", near.0, near.1);
    println!("    |coord| >= {F32_SAFE_MAGNITUDE:e} (f32 too coarse)   : {} pre-broken, {} csg-broke", far.0, far.1);

    println!("\n  closed-solid tears, by origin:");
    println!("    already torn BEFORE any boolean : {pre_broken}   <- solid construction");
    println!("    watertight before, torn after   : {csg_broke}   <- CSG kernel");
    println!("    no-void processing failed       : {pre_failed}");

    // Smallest pre-broken closed solids: minimal reproducers for the
    // construction-path defect.
    let mut pre: Vec<(&str, &str, u32, usize, usize)> = torn
        .iter()
        .enumerate()
        .filter(|(i, (rep, _, _, _))| is_closed_solid(rep) && pre_tears[*i] > 0 && pre_tears[*i] != usize::MAX)
        .map(|(i, (rep, m, id, _))| (rep.as_str(), m.as_str(), *id, pre_tears[i], tri_counts[i]))
        .collect();
    pre.sort_by_key(|r| (r.4, r.3));
    // Minimal reproducers for the kernel defect: watertight solid in, torn out,
    // at coordinates f32 handles cleanly.
    let mut kern: Vec<(&str, &str, u32, usize, usize)> = torn
        .iter()
        .enumerate()
        .filter(|(i, (rep, _, _, _))| {
            is_closed_solid(rep) && pre_tears[*i] == 0 && mags[*i] < F32_SAFE_MAGNITUDE
        })
        .map(|(i, (rep, m, id, open))| (rep.as_str(), m.as_str(), *id, *open, tri_counts[i]))
        .collect();
    kern.sort_by_key(|r| (r.4, r.3));
    println!("\n  smallest KERNEL-caused tears (watertight in, torn out, f32-safe):");
    println!("    rep            model / element                  open  tris");
    for (rep, m, id, open, tris) in kern.iter().take(12) {
        println!("    {:<14} {:<32} {:>4}  {:>5}", rep, format!("{m} #{id}"), open, tris);
    }

    println!("\n  smallest pre-broken closed solids (no voids applied):");
    println!("    rep            model / element                  open  tris");
    for (rep, m, id, open, tris) in pre.iter().take(15) {
        println!("    {:<14} {:<32} {:>4}  {:>5}", rep, format!("{m} #{id}"), open, tris);
    }

    let torn_solid = near.0 + near.1;
    println!("\ngenuine defects (closed solid, f32-safe coordinates): {torn_solid} (baseline {BASELINE_TORN_SOLID})");
    println!("  of which the boolean caused: {}", near.1);
    println!("  of which arrived torn      : {}", near.0);
    println!("far-field (below RTC, f32 cannot hold mm): {} not gated", far.0 + far.1);
    println!("non-invariant total: {} (baseline {BASELINE_NON_INVARIANT})", divergences.len());

    // FLOOR. Every other assertion here is an upper bound, so a missing or partial
    // `tests/models` tree (shallow clone, fixtures not fetched, path drift) yields
    // zeros and a green run that certifies nothing. Pin the corpus size too.
    assert!(
        models_seen >= MIN_MODELS && swept >= MIN_VOID_HOSTS,
        "corpus under-populated: {models_seen} models / {swept} void hosts, expected \
         at least {MIN_MODELS} / {MIN_VOID_HOSTS} — fixtures missing, so the ceilings \
         below would pass vacuously"
    );

    assert!(
        open_edge_total <= BASELINE_OPEN_EDGE_TOTAL,
        "total unmatched edges grew: {open_edge_total} > {BASELINE_OPEN_EDGE_TOTAL}"
    );
    assert!(
        torn.len() <= BASELINE_TORN_TOTAL,
        "total torn void hosts grew: {} > {BASELINE_TORN_TOTAL}",
        torn.len()
    );
    assert!(
        collapsed <= BASELINE_COLLAPSED,
        "hosts with snap-collapsed triangles grew: {collapsed} > {BASELINE_COLLAPSED}"
    );
    assert!(
        torn_solid <= BASELINE_TORN_SOLID,
        "closed-solid elements that are not watertight grew: {torn_solid} > {BASELINE_TORN_SOLID}"
    );
    assert!(
        divergences.len() <= BASELINE_NON_INVARIANT,
        "elements depending on the triangulator's diagonal choice grew: {} > {BASELINE_NON_INVARIANT}",
        divergences.len()
    );
}
