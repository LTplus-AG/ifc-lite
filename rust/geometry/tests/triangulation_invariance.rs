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
//! losses, additions, reclassifications and re-tessellations are separate
//! outcomes with separate messages, and the corpus totals are DERIVED from the
//! golden rather than hand-edited, so there is no constant left to bump.
//! `MIN_MODELS` / `MIN_VOID_HOSTS` remain as the floor: every other check is an
//! upper bound, so without them an unpopulated tree satisfies all of them
//! vacuously.
//!
//! Every run also writes the rows it measured to [`RUN_REPORT_PATH`], which CI
//! uploads as an artifact, so re-blessing does not require reproducing the sweep
//! on the machine that disagreed. Re-blessing IN CI is refused outright (see
//! [`census_golden::bless_mode`]): the bless path returns before every check, so
//! a leaked `IFCLITE_CENSUS_BLESS` would leave the lane permanently and silently
//! green, which is worse than a lane that reports a problem.
//!
//! # The heavy lane (#3434)
//!
//! [`MAX_FIXTURE_BYTES`] filters `discover_models()` BEFORE any file is opened,
//! so an oversized fixture is not merely un-pinned in the golden above — the
//! sweep never reads it at all. Two `ara3d` fixtures are excluded that way:
//! `ISSUE_053_20181220Holter_Tower_10.ifc` (169 MB) and
//! `ISSUE_068_ARK_NUS_skolebygg.ifc` (54 MB). AGENTS.md's perf section already
//! names this exact class as the one where "every shipped regression has
//! lived", and the census instrument did not touch it either. Per-PR CI still
//! does not, deliberately: this lane is weekly, and AGENTS.md is worded to say
//! per-PR rather than to advertise a gate list it tells you not to trust.
//!
//! [`heavy_fixture_issue_053_is_watertight`] and
//! [`heavy_fixture_issue_068_carries_the_known_3435_tear`], near the bottom of
//! this file, reach the two fixtures directly (bypassing `discover_models`'s
//! size filter, not raising [`MAX_FIXTURE_BYTES`] itself) and run the SAME
//! per-host walk via [`sweep`], gated through the SAME [`census_golden`]
//! machinery as the main corpus, against one shared golden,
//! [`HEAVY_GOLDEN_PATH`].
//!
//! ## What runs it
//!
//! `.github/workflows/geometry-census-heavy.yml`: weekly, plus
//! `workflow_dispatch` before a kernel-sensitive merge. Both tests are
//! `#[ignore]`d so neither `cargo test --workspace` nor the per-PR census job
//! pays for 223 MiB of fixture; `-- --ignored heavy_fixture` matches both and is
//! what that workflow runs.
//!
//! Wiring it is the whole of #3434. #3436 added these two tests and nothing
//! ran them: no workflow step, no script, no `--ignored` anywhere under
//! `.github/` or `scripts/`, so [`HEAVY_GOLDEN_PATH`] was a ratchet nobody
//! turned. AGENTS.md states the rule for `scripts/` gates — "a guard nothing
//! runs is the same absence as a guard that finds nothing" — and an `#[ignore]`
//! no `--ignored` ever reaches is the same shape in Rust.
//!
//! ## Why the known tear is IN the golden
//!
//! ISSUE_068 is torn, and #3436 pinned the CORRECT end state (`torn == 0`)
//! instead of recording the tear, so the test failed on every run by design.
//! Nothing can be wired to that: a lane that is red whatever happens carries
//! one bit and it is always the same bit. `assert_eq!(torn, 0)` reads
//! identically at today's torn population and at ten times it on an entirely
//! different set of hosts, so it cannot separate the KNOWN tear from a NEW
//! one — which is the only question a standing lane is there to answer.
//!
//! The tear is therefore pinned PER HOST in [`HEAVY_GOLDEN_PATH`], exactly as
//! the main corpus already pins its own torn hosts. The golden is a per-host
//! CEILING, so a tear on a host that was clean files under `regressed`, a host
//! that stops meshing under `missing`, a host absent from the golden under
//! `added`, and every one of those is red.
//!
//! Recording it is not blessing it away, because the POPULATION is pinned
//! separately as [`ISSUE_068_KNOWN_TORN_HOSTS`] and checked against the
//! checked-in golden by
//! [`the_heavy_golden_pins_the_known_3435_tear_population`] — which reads the
//! file with `include_str!`, needs no fixture and no sweep, and therefore runs
//! in the default `cargo test --workspace` on every PR. Moving that population
//! in EITHER direction reds that test until someone edits a constant whose name
//! says #3435. A fix has to lower it deliberately; a regression cannot raise it
//! quietly.
//!
//! ## Why no counts are written in this section
//!
//! #3436's prose here said ISSUE_068 measured 29 torn hosts / 285 open edges,
//! a doc comment beside it said 27/274, and by the time anything ran either
//! one neither was true: swept at `6f445b6f2` the fixture reads 363 void hosts,
//! 28 torn, 282 open edges, and its worst host `#43810` carries 40 open edges
//! rather than the 42 recorded next to it. No geometry work targeted this
//! fixture in between and no reader could have known any of that, because
//! nothing re-derived it. The counts now live in the golden and in one named
//! constant, both of which a test reads; the figures in this paragraph are
//! dated on purpose, as history rather than as a claim about `main`.

mod census_golden;

use census_golden::{is_closed_solid, totals, Delta, HostRow, PreVoid};
use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
use ifc_lite_geometry::kernel::mesh_volume::mesh_volume;
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
/// manifest's full population (112 models / 1170 void hosts) so a single failed
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

/// Two readings of watertightness plus the degenerate-triangle count, all from
/// ONE walk over ONE 1 mm position-snapped topology.
///
/// Both readings off the same walk is the point of #3397 rather than a tidiness
/// choice: two separate passes could be given two different snap tolerances, or
/// two different degenerate-skip rules, and the per-host comparison this census
/// now prints would silently stop comparing like with like.
struct EdgeStats {
    /// The SIGNED per-edge balance: undirected edges whose forward and reverse
    /// use counts DIFFER. The census's historical reading, unchanged.
    ///
    /// Blind to every topology where the two counts grow together, because the
    /// net stays zero: a face duplicated along with its opposite-wound twin, a
    /// duplicated shell, a 2-forward / 2-reverse seam. See `strict`.
    open: usize,
    /// The STRICT directed-pair rule: undirected edges NOT used exactly once
    /// forward and once reverse (#3397). This is the manifold condition the rest
    /// of the repo already checks — `touching_operand.rs` counts the two
    /// directions apart for this reason, and `issue_3353_boolean_tear.rs` pins
    /// `f != 1 || r != 1` — and it is a superset of `open` by construction,
    /// since `f != r` implies `(f, r) != (1, 1)`.
    strict: usize,
    /// Triangles that COLLAPSED under the snap (two of their three endpoints
    /// landing on one position), counted and then skipped by BOTH readings.
    ///
    /// The distinction is load-bearing. A degenerate edge is a self-loop
    /// produced by a triangle that collapsed under the snap, which happens
    /// wholesale on georeferenced models: `Mesh.positions` is f32, and at
    /// UTM-scale coordinates (~5e5) the f32 step is ~3 cm, so a 200 mm wall
    /// cannot be represented at all. The pipeline's RTC offset exists to prevent
    /// that, but it is applied ABOVE `GeometryRouter::process_element`, which
    /// this harness calls directly. Counting self-loops as open boundary would
    /// therefore measure a harness artifact rather than a watertightness defect.
    degenerate: usize,
}

fn edge_stats(mesh: &Mesh) -> EdgeStats {
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
    // (forward uses, reverse uses) per undirected edge, forward meaning the
    // low-to-high orientation. Keeping the two directions APART rather than
    // netting them is the whole of #3397: a net of zero cannot tell 1f/1r from
    // 2f/2r, and the second is a duplicated or non-manifold sheet.
    let mut uses: FxHashMap<(u32, u32), (u32, u32)> = FxHashMap::default();
    let mut degenerate = 0usize;
    for tri in mesh.indices.chunks_exact(3) {
        let (a, b, c) = (id(tri[0] as usize), id(tri[1] as usize), id(tri[2] as usize));
        if a == b || b == c || c == a {
            degenerate += 1;
            continue; // a collapsed triangle has no meaningful boundary
        }
        for (x, y) in [(a, b), (b, c), (c, a)] {
            let e = uses.entry((x.min(y), x.max(y))).or_insert((0, 0));
            if x < y {
                e.0 += 1;
            } else {
                e.1 += 1;
            }
        }
    }
    EdgeStats {
        open: uses.values().filter(|&&(f, r)| f != r).count(),
        strict: uses.values().filter(|&&(f, r)| f != 1 || r != 1).count(),
        degenerate,
    }
}

/// The SIGNED reading alone, for the `alt` and `pre` columns.
///
/// Those two stay signed deliberately (#3397). `alt` is gated through
/// [`HostRow::diverged`] and `pre` through `is_torn_solid`, so widening either
/// would move `non-invariant` and `genuine defects` on every host where the two
/// rules disagree — the same population this change exists to MEASURE, which
/// cannot be measured and re-baselined in one step. The cost is stated on
/// [`HostRow::open_is_comparable`]: a doubled sheet only one triangulator emits
/// is still invisible here.
fn open_boundary_edges(mesh: &Mesh) -> usize {
    edge_stats(mesh).open
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

/// Signed enclosed volume in whole cm³, for [`HostRow::vol`] (#3422), which
/// says where it is taken and why it is an integer. `kernel::mesh_volume`
/// reads the same f32 positions `edge_stats` does, so one mesh is one integer.
fn volume_cm3(mesh: &Mesh) -> i64 {
    (mesh_volume(mesh) * 1.0e6).round() as i64
}

/// One census row from a host's void-applied mesh. Every column that is a
/// reading OF THAT MESH is derived here and nowhere else, so a test that
/// builds a row from a mesh cannot drift from the sweep; `alt` and `pre` are
/// second processing passes and stay with the caller, which has already read
/// `stats` to decide whether `pre` is taken.
fn row_from_mesh(
    model: &str,
    id: u32,
    rep: String,
    mesh: &Mesh,
    stats: &EdgeStats,
    alt: Option<usize>,
    pre: PreVoid,
) -> HostRow {
    HostRow {
        model: model.to_string(),
        id,
        rep,
        open: stats.open,
        strict: stats.strict,
        tris: mesh.indices.len() / 3,
        collapsed: stats.degenerate > 0,
        far: max_abs_coord(mesh) >= F32_SAFE_MAGNITUDE,
        alt,
        pre,
        // The mirror of `pre`: taken exactly where that one is not. Same
        // SIGNED trigger, for the same reason.
        vol: (stats.open == 0).then(|| volume_cm3(mesh)),
    }
}

/// The golden a lane compares against, or that a bless overwrites.
///
/// Outside a bless an unreadable golden is fatal, whatever the reason: a lane
/// that carried on would be measuring against nothing.
///
/// In bless mode exactly ONE failure is tolerated, and it is the one a
/// column-adding change creates: [`census_golden::ParseError::Schema`], the
/// file on disk having one column fewer than `parse` demands (#3397, #3422).
/// Its rows are intact but cannot be reused without inventing the new column,
/// so the lane discards them and says so; every swept model is rewritten from
/// this run, and a model NOT swept has no rows to keep, which the bless line's
/// `kept` count shows. Before this the only way past the parse was the run
/// report under `target/`, which the heavy lane does not write.
///
/// Every OTHER failure — a bad number, an unreadable flag, a truncated write,
/// a mangled merge — is fatal in bless mode too. Treating it as an empty
/// golden would be the absence-reads-as-success shape: in the heavy lane the
/// two fixtures share one file and each blesses only its own model's rows, so
/// a bless of ISSUE_053 against a file carrying one corrupt ISSUE_068 row
/// would silently write a golden missing all 363 of that model's rows, taking
/// the #3435 tear pin with them. `parse` separates the two classes so this
/// function can refuse the second one.
fn read_golden(path: &std::path::Path, bless: bool) -> Vec<HostRow> {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    match census_golden::parse(&text) {
        Ok(rows) => rows,
        Err(e @ census_golden::ParseError::Schema { .. }) if bless => {
            println!(
                "\nBLESS WITHOUT COMPARISON: {} does not parse under the current golden \
                 schema ({e}). Its rows cannot be compared or kept, so every swept model \
                 is written from this run alone.",
                path.display()
            );
            Vec::new()
        }
        Err(e @ census_golden::ParseError::Malformed(_)) => panic!(
            "{} is CORRUPT, not merely on an older schema ({e}). A bless will not treat \
             this as an empty golden: the rows it would silently drop include every model \
             this run does not sweep. Fix or restore the file first.",
            path.display()
        ),
        Err(e) => panic!("{} is unreadable: {e}", path.display()),
    }
}

/// A golden one column short — the file every column-adding change leaves on
/// disk. A measuring run must die on it (comparing against nothing certifies
/// nothing); a bless must keep none of its rows, which cannot be reused
/// without inventing the missing column. One fixture for both arms, so they
/// cannot drift onto different inputs, removed before either assertion so a
/// failure does not leak it.
#[test]
fn a_golden_one_column_short_kills_a_measuring_run_and_is_kept_by_no_bless() {
    let path = std::env::temp_dir().join(format!("ifc-lite-3422-{}.tsv", std::process::id()));
    std::fs::write(
        &path,
        "model\tid\trep\topen\ttris\tcoll\tfar\talt\tpre\tstrict\na.ifc\t1\tCSG\t0\t12\t0\t0\t0\t-\t0\n",
    )
    .expect("write the old-schema golden");
    let measuring = std::panic::catch_unwind(|| read_golden(&path, false));
    let blessing = std::panic::catch_unwind(|| read_golden(&path, true));
    let _ = std::fs::remove_file(&path);

    let err = measuring.expect_err("a measuring run must die on a golden one column short");
    let text = err.downcast_ref::<String>().cloned().unwrap_or_default();
    assert!(text.contains("expected 11 columns, got 10"), "{text}");
    let rows = blessing.expect("a bless must tolerate a golden one column short");
    assert!(rows.is_empty(), "an old-schema row was kept: {rows:?}");
}

/// The other half of the same rule (#3422). A golden that is CORRUPT rather
/// than merely on an older schema is fatal in BOTH modes: the rows a bless
/// would discard include every model this run does not sweep, and in the heavy
/// lane, where two fixtures share one file, that is 363 rows and the #3435
/// tear pin.
///
/// The fixture is the schema-short row from the test above with the new column
/// present and unreadable, so the ONLY difference between the two is the class
/// of failure, not the file's shape. Without the split in
/// `census_golden::ParseError` this test passes an empty `Vec` back and writes
/// a golden missing the other model.
#[test]
fn a_bless_refuses_a_corrupt_golden_instead_of_treating_it_as_empty() {
    let path =
        std::env::temp_dir().join(format!("ifc-lite-3422-corrupt-{}.tsv", std::process::id()));
    std::fs::write(
        &path,
        "model\tid\trep\topen\ttris\tcoll\tfar\talt\tpre\tstrict\tvol\n\
         a.ifc\t1\tCSG\t0\t12\t0\t0\t0\t-\t0\tnot-a-number\n",
    )
    .expect("write the corrupt golden");
    let measuring = std::panic::catch_unwind(|| read_golden(&path, false));
    let blessing = std::panic::catch_unwind(|| read_golden(&path, true));
    let _ = std::fs::remove_file(&path);

    for (mode, outcome) in [("measuring", measuring), ("blessing", blessing)] {
        let err = outcome.expect_err("a corrupt golden must be fatal in {mode} mode");
        let text = err.downcast_ref::<String>().cloned().unwrap_or_default();
        assert!(text.contains("is CORRUPT, not merely on an older schema"), "{mode}: {text}");
        assert!(text.contains("bad volume"), "{mode}: {text}");
        // And it must NOT be described as a schema change, or the reader
        // reaches for the bless command that would destroy the file.
        assert!(!text.contains("BLESS WITHOUT COMPARISON"), "{mode}: {text}");
    }
}

/// The host, then the reasons that moved it. The one definition of that shape
/// for the four buckets that carry a [`Delta`], so their print lines and their
/// failure texts cannot drift apart. `missing` and `added` carry a bare
/// `HostRow` with no reasons, so they format through `fmt_host` instead.
fn fmt_delta(d: &Delta) -> String {
    format!("{}  [{}]", fmt_host(&d.run), d.reasons.join("; "))
}

/// One indented line per delta, for a failure message.
fn fmt_deltas(ds: &[Delta]) -> String {
    ds.iter().map(|d| format!("  {}", fmt_delta(d))).collect::<Vec<_>>().join("\n")
}

/// Every bucket, each host named, in one place for both lanes: the census
/// lane's comment above its call says why every bucket prints before any
/// assert. One definition so adding a bucket is one edit, not one per lane.
fn print_buckets(diff: &census_golden::Diff) {
    for d in &diff.improved {
        println!("  IMPROVED  {}", fmt_delta(d));
    }
    for d in &diff.regressed {
        println!("  REGRESSED  {}", fmt_delta(d));
    }
    for r in &diff.missing {
        println!("  COVERAGE LOSS  {}", fmt_host(r));
    }
    for d in &diff.retessellated {
        println!("  RETESSELLATED  {}", fmt_delta(d));
    }
    for d in &diff.volume_moved {
        println!("  VOLUME MOVED  {}", fmt_delta(d));
    }
    for r in &diff.added {
        println!("  ADDED  {}", fmt_host(r));
    }
    for d in &diff.changed {
        println!("  RECLASSIFIED  {}", fmt_delta(d));
    }
}

fn fmt_host(r: &HostRow) -> String {
    format!(
        "{} #{}  {:<14} open={} strict={} tris={}",
        r.model, r.id, r.rep, r.open, r.strict, r.tris
    )
}

/// Sweep every void host across `models`: process with and without the alt
/// triangulator, take the pre-void reading for torn hosts, and return one
/// [`HostRow`] per host plus the set of models that were actually opened
/// (whether or not they turned out to have any void hosts).
///
/// Shared by [`watertightness_census_and_triangulator_invariance`] and the heavy
/// lane at the bottom of this file (#3434), so the two lanes characterize a
/// host through the exact same walk rather than two implementations that can
/// drift apart.
fn sweep(models: &[(String, PathBuf)]) -> (Vec<HostRow>, BTreeSet<String>) {
    let mut rows: Vec<HostRow> = Vec::new();
    let mut swept_models: BTreeSet<String> = BTreeSet::new();

    for (rel, path) in models {
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

            let stats = edge_stats(&base);
            let open = stats.open;
            // Only taken for torn hosts: it is a full second processing pass,
            // and it is only ever read to attribute a tear to construction or
            // to the boolean. Triggered on the SIGNED reading, not the strict
            // one, for the reason `open_boundary_edges` gives: widening the
            // trigger would move `pre` on exactly the hosts #3397 exists to
            // count, re-baselining the population in the commit that measures
            // it.
            let pre = if open == 0 {
                PreVoid::NotTaken
            } else {
                match process_no_voids(&content, id).map(|m| open_boundary_edges(&m)) {
                    Some(v) => PreVoid::Open(v),
                    None => PreVoid::Failed,
                }
            };
            rows.push(row_from_mesh(
                rel,
                id,
                representation_type(&content, &lines, id),
                &base,
                &stats,
                alt.as_ref().map(open_boundary_edges),
                pre,
            ));
        }
    }

    // #3422: the wiring rule, asserted on every row this walk produces so both
    // lanes inherit it. A sweep that stopped taking the reading would diff
    // `Some` against `None`, which `classify` reads as "one reading is not a
    // comparison", so every watertight host would read unchanged and the
    // column would go dark with nothing failing; the golden pin in
    // `census_golden` only proves the reading was taken once.
    for r in &rows {
        assert!(
            r.volume_is_wired(),
            "{} #{}: vol {:?} with open {} — the sweep takes the reading exactly where \
             the host is watertight",
            r.model,
            r.id,
            r.vol,
            r.open
        );
    }

    (rows, swept_models)
}

/// Two gates share this one test. They cannot be split into two `#[test]`s
/// because the alternate triangulator is switched by a process-wide
/// `AtomicBool` (`triangulation::alt_oracle::set_alt_triangulator`), and
/// libtest runs tests as threads in one process, so two tests sweeping
/// concurrently would race on it. Sharing the sweep also avoids paying for
/// it twice.
///
/// GATE 1, invariance: does watertightness depend on the triangulator's
/// diagonal choice? Every void-hosting element is meshed twice, production
/// ear-clipper vs the alternate one, and `open_boundary_edges` is compared
/// per host into `run.non_invariant`.
///
/// GATE 2, regression: does this run match the pinned per-host golden
/// (`tests/manifests/watertightness_census.tsv`)? That is `diff.regressed`
/// and the corpus ceilings.
///
/// The gates overlap rather than partition. The golden's COUNT columns
/// (open, strict, tris, collapsed) are production-triangulator readings,
/// but it also pins each host's `alt` column, so `classify` can push
/// "newly depends on the triangulator's diagonal choice" into the same
/// `worse_counts` that feeds `diff.regressed`. A REGRESSED failure is
/// therefore NOT evidence either way on its own: only the per-host reasons
/// say which gate fired. #3404 and #3406 failed gate 2 while
/// `non-invariant` printed identically before and after (140 vs 140 -- the
/// triangulators still agreed exactly) and were called invariance failures
/// for hours because of it (#3353). The three asserts that can be reached
/// with the triangulators disagreeing now name their gate; the coverage,
/// re-tessellation, addition and reclassification asserts below are gate 2
/// by construction and are left unlabelled.
#[test]
fn watertightness_census_and_triangulator_invariance() {
    let _serial = CENSUS_SWEEP_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    if cfg!(not(feature = "triangulation-alt")) {
        eprintln!(
            "SKIPPED: rerun with --features triangulation-alt to enable the \
             differential oracle"
        );
        return;
    }

    let models = discover_models();
    let (rows, swept_models) = sweep(&models);

    let models_seen = swept_models.len();
    let run = totals(&rows);

    println!("\n=== watertightness census (production triangulator) ===");
    println!("void hosts torn: {}/{}", run.torn, run.hosts);
    println!(
        "hosts with collapsed triangles (f32 precision): {}/{}",
        run.collapsed, run.hosts
    );
    println!("TOTAL unmatched edges across corpus (signed):  {}", run.open_edges);
    println!("TOTAL directed-pair violations (strict):        {}", run.strict_edges);

    // #3397's measurement, and the reason `strict` is a SECOND column rather
    // than a replacement for `open`: how far apart the two rules actually are on
    // this corpus. A host listed here is certified watertight by the signed
    // balance while carrying edges that are not a clean one-forward /
    // one-reverse pair — a doubled sheet, a duplicated shell, or a 2f/2r seam.
    // Under the signed reading alone that population is not merely un-gated, it
    // is unknown, because `torn` and `total unmatched edges` both derive from
    // the count that cannot see it.
    let signed_only: Vec<&HostRow> = rows.iter().filter(|r| r.open == 0 && r.strict > 0).collect();
    println!(
        "\nwatertight by the SIGNED balance, torn by the STRICT directed-pair rule: {}/{}",
        signed_only.len(),
        run.hosts
    );
    // Two further readings, each saying only what it counts. The host tally
    // above answers #3397's question ("watertight by one rule, not the other");
    // these two say how far apart the rules are everywhere else, and are kept
    // separate from it because a corpus-wide edge total is NOT a statement
    // about the hosts listed above.
    println!(
        "  hosts where the two readings disagree at all (strict > open): {}/{}",
        rows.iter().filter(|r| r.strict > r.open).count(),
        run.hosts
    );
    // `strict` is a superset of `open` per host, so this subtraction cannot
    // wrap: every edge the signed balance counts is one the strict rule counts
    // too.
    println!(
        "  corpus edge totals: {} signed, {} strict — {} edges the signed balance cannot see",
        run.open_edges,
        run.strict_edges,
        run.strict_edges - run.open_edges
    );
    if !signed_only.is_empty() {
        println!("    rep            model / element                  strict  tris");
        for r in signed_only.iter().take(12) {
            println!(
                "    {:<14} {:<32} {:>6}  {:>5}",
                r.rep,
                format!("{} #{}", r.model, r.id),
                r.strict,
                r.tris
            );
        }
    }

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

    let bless = census_golden::bless_mode(
        std::env::var_os(BLESS_ENV).is_some(),
        std::env::var_os("CI").is_some_and(|v| !v.is_empty() && v != "0" && v != "false"),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    let golden_path = crate_dir().join(GOLDEN_PATH);
    let golden = read_golden(&golden_path, bless);

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
    // Says what it counts, because it does not count every host that shrank
    // while healing. One that was ALSO reclassified files under `changed` and
    // one that also worsened on another axis files under `regressed`; neither
    // reaches this line. On a wall-cut change the relabel is the likely path, so
    // this can read 0 on exactly the run the bucket was built for, which is why
    // `shrank_while_healing` prints under it. The golden-derived proportions
    // behind that live on `Diff::retessellated`, with the caveat that they go
    // stale on a re-bless.
    println!(
        "retessellated (smaller AND less torn, excluding hosts also reclassified \
         or worse on another axis): {}",
        diff.retessellated.len()
    );
    // The same class WITHOUT that exclusion. If these two disagree, the
    // difference is hosts that shrank while healing and were filed under
    // another verdict, and the reasons on those hosts carry the shrink.
    println!(
        "  ... called a re-tessellation, in any bucket: {}",
        diff.shrank_while_healing
    );
    println!(
        "volume moved (watertight both sides, enclosed volume differs): {}",
        diff.volume_moved.len()
    );
    println!("improved  : {}", diff.improved.len());
    // EVERY bucket names its hosts HERE, before any assert, `regressed`
    // included even though its assert happens to run first. The asserts run
    // one bucket at a time and the FIRST failure panics, so any bucket that
    // only names its hosts inside its own assert is a bare count whenever an
    // earlier one fails. Keeping every bucket in `print_buckets` means
    // reordering the asserts cannot silently cost a bucket its host names.
    //
    // The run that motivated this is the one where several buckets are
    // non-empty at once: whatever stays in `regressed` panics first, and every
    // host that shrank while healing would otherwise show up only as a count.
    print_buckets(&diff);

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
    println!("  strict-rule edges : {} vs {}", run.strict_edges, expected.strict_edges);
    println!("  collapsed hosts   : {} vs {}", run.collapsed, expected.collapsed);
    println!("  genuine defects   : {} vs {}", run.torn_solid, expected.torn_solid);
    println!("  non-invariant     : {} vs {}", run.non_invariant, expected.non_invariant);

    // Regressions first: they are the only outcome that is unambiguously a
    // defect, and burying them under an addition list would repeat the mistake
    // this golden exists to fix.
    assert!(
        diff.regressed.is_empty(),
        "{} host(s) REGRESSED against the pinned golden. This assert carries \
         BOTH gates, so it is not by itself a triangulator-invariance \
         failure and not by itself a plain golden mismatch. ONE rule decides \
         which, and it is per host: read the reasons below. A host whose \
         reason reads \"newly depends on the triangulator's diagonal choice\" \
         is GATE 1 (invariance); a host carrying only other reasons (open \
         edges, strict pairs, triangle count, collapse, classification) is \
         GATE 2 (regression against the production-triangulator columns). \
         The \"non-invariant : run vs golden\" totals printed above cannot \
         answer this and are not a shortcut past the reasons: one host \
         healing while another newly diverges leaves that pair EQUAL with a \
         gate-1 host listed right below, and a host added or gone missing \
         this run moves the pair with no regression at all:\n{}",
        diff.regressed.len(),
        fmt_deltas(&diff.regressed)
    );

    assert!(
        diff.missing.is_empty(),
        "COVERAGE LOSS: {} host(s) in the golden produced NO geometry in this run, \
         from models that WERE swept. Absolute totals read this as an improvement \
         because the missing element's defects leave every sum with it:\n{}",
        diff.missing.len(),
        diff.missing.iter().map(|r| format!("  {}", fmt_host(r))).collect::<Vec<_>>().join("\n")
    );

    // Separated from the regressions above on purpose. These hosts got SMALLER
    // and LESS TORN at once, which is what a cut that stops over-extending looks
    // like. Folding them in with geometry loss is what made this census score
    // the repair of its own defect class as damage. Still red, because the
    // golden is a per-host ceiling and these move it, but a reviewer must be
    // able to tell "this tore" from "this shrank while healing".
    assert!(
        diff.retessellated.is_empty(),
        "{} host(s) RE-TESSELLATED: fewer triangles with fewer open edges on a \
         torn host, or at unchanged enclosed volume on a watertight one. Usually \
         a cut that stopped over-extending or a mesher change. On a TORN host the \
         test is magnitude-blind - a near-total loss also lands here, so CHECK \
         THE SHRINK before blessing. If the shrink is intended, re-bless:\n  \
         {BLESS_CMD}\n{}",
        diff.retessellated.len(),
        fmt_deltas(&diff.retessellated)
    );

    // Separated from both of the above (#3422): the enclosed volume of a
    // watertight host moved, which no count sees when the topology holds. The
    // message carries why neither direction is a verdict.
    assert!(
        diff.volume_moved.is_empty(),
        "{} host(s) moved in ENCLOSED VOLUME while watertight on both sides. \
         Neither direction is a verdict: less volume is an over-cut growing or a \
         void that was silently skipped now applying; more is a healed over-cut \
         or a void that stopped applying. Read the percentage against what the \
         change was meant to do, then re-bless:\n  {BLESS_CMD}\n{}",
        diff.volume_moved.len(),
        fmt_deltas(&diff.volume_moved)
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
        "{} host(s) were RECLASSIFIED. The relabel itself is neither better nor \
         worse, but it changes what the census believes it is measuring, and a \
         host can be reclassified AND have shrunk: READ THE REASONS, they carry \
         the other axes.\n\
         \n\
         A reason reading `(fewer triangles, less torn)` here is MAGNITUDE-BLIND, \
         exactly as under RE-TESSELLATED: a host that lost 90% of its mesh says \
         the same words as one that stopped over-extending by a millimetre. This \
         is the likelier landing spot for a wall-cut change, because the relabel \
         outranks the shrink and a wall-cut is what flips SweptSolid to \
         Clipping. CHECK THE SHRINK before blessing.\n\
         \n\
         Review, then re-bless:\n  {BLESS_CMD}\n{}",
        diff.changed.len(),
        fmt_deltas(&diff.changed)
    );

    // Backstop. The five asserts above hand-enumerate the buckets that need a
    // bless, and `requires_bless` enumerates them again; nothing else keeps the
    // two lists in step. Add a seventh outcome, wire it into `requires_bless`
    // where the unit tests exercise it, forget the assert here, and the census
    // reports that whole class as a printed count and passes GREEN. This never
    // fires before one of the five does, so they keep their own messages; it is
    // here for the bucket nobody wrote an assert for.
    assert!(
        !diff.requires_bless(),
        "the diff requires a bless but no assert above claimed it, so a bucket \
         has been added to `Diff::requires_bless` without a check here. Whatever \
         moved is in the per-bucket counts printed above."
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
        ("total strict directed-pair violations", run.strict_edges, expected.strict_edges),
        ("torn void hosts", run.torn, expected.torn),
        ("hosts with snap-collapsed triangles", run.collapsed, expected.collapsed),
        ("closed solids that are not watertight", run.torn_solid, expected.torn_solid),
    ] {
        assert!(
            got <= want,
            "{name} grew: {got} > {want} (GATE 2, golden-derived ceiling; \
             unrelated to triangulator invariance)"
        );
    }

    // Kept out of the loop above, though it is the same shape, because it is
    // the one ceiling that IS gate 1 rather than gate 2.
    //
    // Reaching it means every assert above passed, so `diff.regressed` and
    // `diff.added` are both EMPTY -- there is no early return between them
    // and here. That rules out the two ordinary ways this total grows: a
    // matched host that newly diverges goes to `worse_counts` and panics as
    // REGRESSED, and an added host that diverges panics as ADDED. So this
    // fires alone or not at all, and what it catches is a classifier bug
    // that moved the total without moving any one host's own `diverged()`
    // reading. Do not delete it as redundant with the loop: nothing above
    // can reach the same state.
    assert!(
        run.non_invariant <= expected.non_invariant,
        "hosts depending on the triangulator's diagonal choice grew: {} > {} \
         (GATE 1, triangulator invariance -- this IS a genuine invariance \
         regression, not merely a golden mismatch)",
        run.non_invariant,
        expected.non_invariant
    );
}

/// A unit cube as 8 welded vertices and 12 consistently wound triangles.
///
/// Every one of its 18 undirected edges is used exactly once forward and once
/// reverse, which is what makes it a valid null case for BOTH readings at once:
/// a fixture that were merely balanced would leave `strict` untested.
fn unit_cube() -> Mesh {
    let mut m = Mesh::new();
    m.positions = vec![
        0.0, 0.0, 0.0, // 0
        1.0, 0.0, 0.0, // 1
        1.0, 1.0, 0.0, // 2
        0.0, 1.0, 0.0, // 3
        0.0, 0.0, 1.0, // 4
        1.0, 0.0, 1.0, // 5
        1.0, 1.0, 1.0, // 6
        0.0, 1.0, 1.0, // 7
    ];
    m.indices = vec![
        0, 3, 2, 0, 2, 1, // z = 0
        4, 5, 6, 4, 6, 7, // z = 1
        0, 1, 5, 0, 5, 4, // y = 0
        1, 2, 6, 1, 6, 5, // x = 1
        2, 3, 7, 2, 7, 6, // y = 1
        3, 0, 4, 3, 4, 7, // x = 0
    ];
    m
}

/// [`unit_cube`] with one existing face triangle re-emitted AND its reverse.
///
/// Every position is already in the mesh, so this adds no boundary at all: the
/// three affected edges go from 1 forward / 1 reverse to 2 forward / 2 reverse.
/// That is the exact shape the signed balance cancels to zero on.
///
/// ONE fixture rather than a copy per test, because the six indices are what
/// makes it a doubling rather than a hole: a copy that drifted would leave the
/// superset test below asserting `strict >= open` over some other mesh, and
/// passing.
/// `n` disjoint doubled sheets: one triangle and its reverse, side by side.
///
/// The shape the volume column cannot read (#3422). The signed balance
/// certifies it watertight — every undirected edge is used once forward and
/// once reverse — and the divergence sum over a surface that encloses nothing
/// is exactly 0, so a census row for it carries `open = 0`, `strict = 0` and
/// `vol = Some(0)`. Real hosts of this shape exist: a wall modelled as a
/// zero-thickness face, a duplicated shell that cancels itself.
fn doubled_sheets(n: usize) -> Mesh {
    let mut m = Mesh::default();
    for i in 0..n {
        let (b, x) = ((m.positions.len() / 3) as u32, i as f32 * 4.0);
        m.positions.extend_from_slice(&[x, 0.0, 0.0, x + 1.0, 0.0, 0.0, x, 1.0, 0.0]);
        m.indices.extend_from_slice(&[b, b + 1, b + 2, b, b + 2, b + 1]);
    }
    m
}

/// #3422, the zero-volume hole in the volume column's own routing. A host that
/// loses HALF its sheets is watertight on both sides and reads 0 cm³ on both,
/// so "the enclosed volume did not change" is true and says nothing. Routing
/// the triangle drop on it filed a vanished component as a friendly
/// re-tessellation.
///
/// Measured through `row_from_mesh`, the sweep's own row builder, so the zero
/// is the reading the sweep would take and not a synthetic one.
#[test]
fn a_watertight_host_reading_zero_volume_is_not_re_tessellated_when_it_shrinks() {
    let swept: BTreeSet<String> = ["sheets.ifc".to_string()].into_iter().collect();
    let row = |m: &Mesh| {
        let s = edge_stats(m);
        row_from_mesh("sheets.ifc", 1, "Brep".into(), m, &s, Some(s.open), PreVoid::NotTaken)
    };
    let (before, after) = (row(&doubled_sheets(2)), row(&doubled_sheets(1)));

    // The premise: watertight by both rules on both sides, and zero volume on
    // both, with half the mesh gone.
    for (what, r) in [("before", &before), ("after", &after)] {
        assert_eq!(r.open, 0, "{what}: the signed balance certifies a doubled sheet");
        assert_eq!(r.strict, 0, "{what}: and so does the strict rule, on disjoint sheets");
        assert_eq!(r.vol, Some(0), "{what}: a surface enclosing nothing reads 0 cm³");
    }
    assert_eq!((before.tris, after.tris), (4, 2), "half the mesh must be gone");

    let d = census_golden::diff(&[before], &[after], &swept);
    assert_eq!(d.regressed.len(), 1, "a vanished sheet is geometry lost");
    assert!(d.retessellated.is_empty(), "not a re-tessellation: there is no volume to be unchanged");
    assert!(d.volume_moved.is_empty(), "and 0 -> 0 is not a move either");
    let reasons = d.regressed[0].reasons.join("; ");
    assert!(reasons.contains("triangles 4 -> 2 (geometry lost)"), "{reasons}");
}

fn doubled_face_cube() -> Mesh {
    let mut m = unit_cube();
    m.indices.extend_from_slice(&[0, 3, 2, 0, 2, 3]);
    m
}

/// #3397. The census measured watertightness with a SIGNED per-edge balance, so
/// a face duplicated along with its opposite-wound twin contributes one extra
/// forward AND one extra reverse use of each of its edges, cancels to zero, and
/// is certified closed. Both readings now come off the same walk, and this is
/// the mesh they disagree on.
#[test]
fn a_doubled_coincident_face_is_invisible_to_the_signed_balance_but_not_the_strict_rule() {
    let clean = edge_stats(&unit_cube());
    assert_eq!(clean.open, 0, "a closed cube has no unbalanced edges");
    assert_eq!(clean.strict, 0, "and every one of its edges is a clean 1f/1r pair");
    assert_eq!(clean.degenerate, 0);

    let s = edge_stats(&doubled_face_cube());
    // Pins the signed column's BLIND SPOT as a measurement rather than
    // asserting it is right. This is the reading the census still gates its
    // defect population on, so what it cannot see has to be written down.
    assert_eq!(s.open, 0, "the signed balance cannot see a doubled coincident sheet");
    assert_eq!(s.strict, 3, "the strict rule sees all three of its edges");
    assert_eq!(s.degenerate, 0);
}

/// The superset relation the two columns are compared under. A real hole moves
/// BOTH readings, so `strict` is not merely a different number: `f != r` implies
/// `(f, r) != (1, 1)`, and a census row with `strict < open` would be a state
/// neither this walk nor the golden's parser should ever produce.
#[test]
fn a_real_hole_moves_both_readings_and_strict_is_never_below_open() {
    let mut holed = unit_cube();
    holed.indices.truncate(holed.indices.len() - 3); // drop one triangle
    let s = edge_stats(&holed);
    assert_eq!(s.open, 3, "the three edges of the missing triangle are unbalanced");
    assert_eq!(s.strict, 3, "and the strict rule counts the same three");

    for m in [unit_cube(), holed, doubled_face_cube()] {
        let s = edge_stats(&m);
        assert!(s.strict >= s.open, "strict {} < open {}", s.strict, s.open);
    }
}

/// A triangle that collapses under the 1 mm snap is skipped by BOTH readings, so
/// it cannot inflate the strict count the way it would if only `open` skipped
/// it. `HostRow.collapsed` is what reports the collapse instead.
#[test]
fn a_snap_collapsed_triangle_is_skipped_by_both_readings() {
    let mut m = unit_cube();
    // Two vertices 0.1 mm apart snap to one position, so this triangle is a
    // self-loop rather than a boundary. Positions are metres; the snap is 1 mm.
    let base = (m.positions.len() / 3) as u32;
    m.positions.extend_from_slice(&[5.0, 5.0, 5.0, 5.0001, 5.0, 5.0, 5.0, 6.0, 5.0]);
    m.indices.extend_from_slice(&[base, base + 1, base + 2]);

    let s = edge_stats(&m);
    assert_eq!(s.degenerate, 1, "the collapsed triangle is counted");
    assert_eq!(s.open, 0, "and contributes no unbalanced edge");
    assert_eq!(s.strict, 0, "nor any strict violation, or every far-field host would gain some");
}

/// One 2.0 x 0.1 x 3.0 m panel with one rectangular opening through it, twice:
/// wall #50 with the opening as authored (0.5 x 1.0 m), wall #150 with the
/// SAME opening scaled by `scale` in its own plane, centre unmoved. That is
/// the #3219 shape as a fixture: an opening cut larger than authored, on a
/// host that is watertight either way.
fn over_cut_fixture(scale: f64) -> String {
    let (w, h) = (0.5 * scale, 1.0 * scale);
    let z0 = 1.5 - h / 2.0;
    format!(
        r##"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('#3422 over-cut census probe'),'2;1');
FILE_NAME('overcut.ifc','2026-09-03T00:00:00',(''),(''),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
#2=IFCOWNERHISTORY($,$,$,.NOCHANGE.,$,$,$,0);
#5=IFCCARTESIANPOINT((0.,0.,0.));
#6=IFCDIRECTION((0.,0.,1.));
#7=IFCDIRECTION((1.,0.,0.));
#8=IFCAXIS2PLACEMENT3D(#5,#6,#7);
#10=IFCUNITASSIGNMENT((#11));
#11=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#8,$);
#1=IFCPROJECT('0proj0000000000000001',#2,'P',$,$,$,$,(#20),#10);
#30=IFCLOCALPLACEMENT($,#8);
#40=IFCCARTESIANPOINT((0.,0.));
#41=IFCDIRECTION((1.,0.));
#42=IFCAXIS2PLACEMENT2D(#40,#41);
/* --- wall #50: the panel, opening as authored --- */
#43=IFCRECTANGLEPROFILEDEF(.AREA.,'',#42,2.,0.1);
#44=IFCEXTRUDEDAREASOLID(#43,#8,#6,3.);
#45=IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#44));
#46=IFCPRODUCTDEFINITIONSHAPE($,$,(#45));
#50=IFCWALLSTANDARDCASE('authoredwall00000001',#2,'wall',$,$,#30,#46,'t1');
/* opening 0.5 wide x 0.3 deep, z from 1.0 to 2.0: centre (0, 0, 1.5) */
#60=IFCCARTESIANPOINT((0.,0.,1.));
#61=IFCAXIS2PLACEMENT3D(#60,#6,#7);
#62=IFCRECTANGLEPROFILEDEF(.AREA.,'',#42,0.5,0.3);
#63=IFCEXTRUDEDAREASOLID(#62,#61,#6,1.);
#64=IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#63));
#65=IFCPRODUCTDEFINITIONSHAPE($,$,(#64));
#66=IFCOPENINGELEMENT('authoredopening00001',#2,'op',$,$,#30,#65,'t2');
#70=IFCRELVOIDSELEMENT('authoredvoid0000001',#2,$,$,#50,#66);
/* --- wall #150: the same panel, opening scaled about its centre --- */
#143=IFCRECTANGLEPROFILEDEF(.AREA.,'',#42,2.,0.1);
#144=IFCEXTRUDEDAREASOLID(#143,#8,#6,3.);
#145=IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#144));
#146=IFCPRODUCTDEFINITIONSHAPE($,$,(#145));
#150=IFCWALLSTANDARDCASE('overcutwall000000001',#2,'wall',$,$,#30,#146,'t3');
#160=IFCCARTESIANPOINT((0.,0.,{z0:?}));
#161=IFCAXIS2PLACEMENT3D(#160,#6,#7);
#162=IFCRECTANGLEPROFILEDEF(.AREA.,'',#42,{w:?},0.3);
#163=IFCEXTRUDEDAREASOLID(#162,#161,#6,{h:?});
#164=IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#163));
#165=IFCPRODUCTDEFINITIONSHAPE($,$,(#164));
#166=IFCOPENINGELEMENT('overcutopening000001',#2,'op',$,$,#30,#165,'t4');
#170=IFCRELVOIDSELEMENT('overcutvoid00000001',#2,$,$,#150,#166);
ENDSEC;
END-ISO-10303-21;"##
    )
}

/// #3422. The census row vocabulary before this change (`open`, `strict`,
/// `tris`, `coll`, `far`, `alt`, `pre`) is COUNTS and FLAGS over topology, and
/// the golden is a ceiling: a host may get better for free. An opening cut
/// larger than authored on a watertight host, the #3219 shape, reads one of
/// two ways under that vocabulary, and both are green:
///
/// - at 1.4x every count holds and the pair is an IDENTICAL row;
/// - at 1.6x the cutter emits MORE triangles, and a grown `tris` files under
///   `improved`, which requires no bless.
///
/// Measured on the pipeline rather than on synthetic rows: both walls go
/// through the `process` / `edge_stats` / `max_abs_coord` path the sweep uses,
/// and the two rows are then diffed as golden and run. Only the enclosed
/// volume separates them, and only the volume column makes the pair require a
/// bless.
///
/// Runs in the default `cargo test`: it needs no fixture and no alternate
/// triangulator.
#[test]
fn an_over_cut_on_a_watertight_host_requires_a_bless() {
    let swept: BTreeSet<String> = ["overcut.ifc".to_string()].into_iter().collect();

    for (scale, tris_grow) in [(1.4, false), (1.6, true)] {
        let ifc = over_cut_fixture(scale);
        let voids = void_index(&ifc);
        let authored = process(&ifc, 50, &voids).expect("authored wall meshes");
        let over_cut = process(&ifc, 150, &voids).expect("over-cut wall meshes");

        let (a, b) = (edge_stats(&authored), edge_stats(&over_cut));
        // The rows exactly as the sweep records a host, through the same
        // builder, so this test measures the sweep's own row and not a copy.
        let row = |mesh: &Mesh, s: &EdgeStats| {
            row_from_mesh("overcut.ifc", 1, "SweptSolid".into(), mesh, s, Some(s.open), PreVoid::NotTaken)
        };
        let (wired_a, wired_b) = (row(&authored, &a), row(&over_cut, &b));
        // Both must be WATERTIGHT, or this probes the torn-host rules instead.
        assert_eq!(wired_a.open, 0, "{scale}x: authored wall must be watertight");
        assert_eq!(wired_b.open, 0, "{scale}x: over-cut wall must be watertight");
        assert_eq!(wired_a.strict, wired_b.strict, "{scale}x: strict");
        assert_eq!(wired_a.collapsed, wired_b.collapsed, "{scale}x: collapsed");
        assert_eq!(wired_a.far, wired_b.far, "{scale}x: far");
        // The one count that CAN move, pinned per scale so the test says which
        // green reading it is exercising. If either arm flips, the fixture has
        // stopped demonstrating that reading and the test must say so rather
        // than pass on the other one.
        let (ta, tb) = (wired_a.tris, wired_b.tris);
        if tris_grow {
            assert!(tb > ta, "{scale}x: expected MORE triangles, got {ta} -> {tb}");
        } else {
            assert_eq!(ta, tb, "{scale}x: expected the same triangle count");
        }

        // The volume is what differs. Panel 2.0 x 0.1 x 3.0 = 0.6 m³, less the
        // opening 0.5 x 0.1 x 1.0 = 0.05 m³ authored and 0.05 * scale² over-cut.
        // Read to within the primitive's documented quantization floor —
        // `mesh_to_tris` snaps every coordinate to 1/65536 m, so the reading
        // drifts by up to surface_area * SNAP_GRID, about 14 m² * 15.3 µm =
        // 210 cm³ here — never to the exact figure, which the 0.05 m faces
        // (not grid-representable) would miss by a few tens of cm³.
        const SNAP_NOISE_CM3: i64 = 250;
        let (va, vb) = (
            wired_a.vol.expect("watertight, so the sweep takes the reading"),
            wired_b.vol.expect("watertight, so the sweep takes the reading"),
        );
        assert_eq!(va.signum(), vb.signum(), "{scale}x: both walls wound the same way");
        assert!(
            (va.abs() - 550_000).abs() <= SNAP_NOISE_CM3,
            "{scale}x: authored 0.55 m³, read {va} cm³"
        );
        let want_drop = (50_000.0 * (scale * scale - 1.0)) as i64;
        let drop = va.abs() - vb.abs();
        assert!(
            (drop - want_drop).abs() <= SNAP_NOISE_CM3,
            "{scale}x: over-cut removes {want_drop} cm³ more, read {drop}"
        );

        // The pre-#3422 census: the over-cut requires no bless either way.
        let blind = census_golden::diff(
            &[HostRow { vol: None, ..wired_a.clone() }],
            &[HostRow { vol: None, ..wired_b.clone() }],
            &swept,
        );
        assert!(
            !blind.requires_bless(),
            "{scale}x: without a volume column the census sees nothing to bless"
        );
        if tris_grow {
            assert_eq!(blind.improved.len(), 1, "{scale}x: and calls the over-cut an improvement");
            let reasons = blind.improved[0].reasons.join("; ");
            assert!(reasons.contains("(improved)"), "{reasons}");
        } else {
            assert!(blind.improved.is_empty(), "{scale}x: the over-cut is an identical row");
        }

        // With the column, the pair is a volume move and the golden must absorb it.
        let seen = census_golden::diff(&[wired_a], &[wired_b], &swept);
        assert!(
            seen.requires_bless(),
            "{scale}x: an opening cut larger than authored left the census green"
        );
        assert_eq!(seen.volume_moved.len(), 1, "{scale}x: the over-cut files as a volume move");
        assert!(seen.regressed.is_empty() && seen.improved.is_empty(), "{scale}x");
        let reasons = seen.volume_moved[0].reasons.join("; ");
        assert!(reasons.contains(&format!("enclosed volume {va} -> {vb} cm³")), "{reasons}");
    }
}

/* -------------------------------------------------------------------- *
 * The heavy lane (#3434). See the module doc's "heavy lane" section.   *
 * -------------------------------------------------------------------- */

/// Per-host golden for BOTH heavy fixtures, diffed through the same
/// [`census_golden`] machinery as the main corpus.
///
/// One file rather than one per fixture: [`census_golden::diff`] keys rows on
/// `(model, id)` and scopes its coverage-loss check to the models a run
/// actually swept, so a single-fixture run reads and re-writes only its own
/// rows. Two files would be two copies of the same header and the same bless
/// path for no separation the keys do not already give.
const HEAVY_GOLDEN_PATH: &str = "tests/manifests/watertightness_census_heavy.tsv";

/// Gates both fixtures in one pass — what
/// `.github/workflows/geometry-census-heavy.yml` runs, spelled here so the
/// failure messages hand back the command that reproduces them.
const HEAVY_LANE_CMD: &str = "cargo test -p ifc-lite-geometry --features triangulation-alt \
                              --test triangulation_invariance \
                              -- --ignored --nocapture --test-threads=1 heavy_fixture";

/// Blesses BOTH fixtures in one pass.
///
/// `--test-threads=1` is belt and braces over [`CENSUS_SWEEP_LOCK`], which is
/// what actually makes running both safe. It still earns its place: it keeps
/// the two fixtures (223 MiB of IFC, plus their entity indices) from being
/// resident at once, and it makes the serialization visible in the command
/// rather than only in the source.
const HEAVY_BLESS_CMD: &str = "IFCLITE_CENSUS_BLESS=1 cargo test -p ifc-lite-geometry \
                               --features triangulation-alt --test triangulation_invariance \
                               -- --ignored --nocapture --test-threads=1 heavy_fixture";

const ISSUE_053_MODEL: &str = "ara3d/ISSUE_053_20181220Holter_Tower_10.ifc";
const ISSUE_068_MODEL: &str = "ara3d/ISSUE_068_ARK_NUS_skolebygg.ifc";

/// #3435's live population: ISSUE_068 void hosts with `open > 0`.
///
/// An EQUALITY, and deliberately so in both directions. A ceiling would let the
/// count fall without anyone tightening it — the cost [`census_golden::Diff`]
/// documents on its `improved` bucket — and here a fall is the news, because
/// #3435 is meant to reach zero and take this constant, and eventually the
/// ISSUE_068 lane's special case, with it.
///
/// Checked against the checked-in golden with no fixture and no sweep by
/// [`the_heavy_golden_pins_the_known_3435_tear_population`], so the value
/// cannot drift from the file it describes.
const ISSUE_068_KNOWN_TORN_HOSTS: usize = 28;

/// Coverage floors, one per heavy fixture, bounding BOTH the checked-in golden
/// and every sweep that gates or blesses against it. [`MIN_VOID_HOSTS`]'s job,
/// for these two fixtures.
///
/// Set with the same deliberate SLACK as `MIN_VOID_HOSTS` (1100 against a
/// population of 1170), at ~94% of the measured 289 and 363. Pinning them at
/// the exact row count would make this floor fire on a single host that stopped
/// meshing — and it sits ABOVE the golden diff, so it would pre-empt the
/// `COVERAGE LOSS` assert, which names every lost host, with a blunt "the
/// fixture is truncated". The floor exists for the catastrophic case, where the
/// tree is half-fetched and every ceiling below would be vacuous; the per-host
/// diff is the right instrument for anything smaller.
const ISSUE_053_MIN_HOSTS: usize = 271;
const ISSUE_068_MIN_HOSTS: usize = 341;

/// Serializes EVERY caller of [`sweep`] in this binary.
///
/// [`set_alt`] toggles a PROCESS-GLOBAL flag, so two sweeps running at once
/// would read one sweep's edge counts under the other's triangulator, and the
/// two heavy lanes additionally read-modify-write the one
/// [`HEAVY_GOLDEN_PATH`] on a bless.
///
/// Held by all three sweeping tests, not just the two heavy ones. Being a
/// single `#[test]` protected the main census from ITSELF, never from a
/// sibling, and #3434 added two siblings: `--include-ignored` without
/// `--test-threads=1` runs the main census concurrently with both heavy lanes
/// and races the flag. The workflow passes `--test-threads=1`, so this closes a
/// hazard for a developer running the file by hand rather than one CI can hit —
/// which is exactly the kind that gets found late.
///
/// Poisoning is absorbed deliberately: a panicking sweep is this file's normal
/// failure mode, and it must not turn a sibling's verdict into a lock-poison
/// panic that hides what that sibling actually measured.
static CENSUS_SWEEP_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Sweep one heavy fixture, report what it measured, and gate it against
/// [`HEAVY_GOLDEN_PATH`].
///
/// Returns the run's totals, or `None` when `IFCLITE_CENSUS_BLESS` rewrote the
/// golden instead of gating against it. An `Option` rather than totals plus a
/// flag so that there is no path on which a caller can reach an assertion
/// holding numbers from a run that measured nothing.
fn run_heavy_lane(model: &str, min_hosts: usize) -> Option<census_golden::Totals> {
    let _serial = CENSUS_SWEEP_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    // PANICS without the feature, where the main census SKIPS and passes, and
    // the difference is the same one that governs a missing fixture below.
    // The main census runs inside `cargo test --workspace`, so it must not red
    // a build that never asked for the oracle. These two are `#[ignore]`d and
    // only ever run because something named them, and without the feature
    // `set_alt` is a no-op: the `alt` column stops being a second opinion and
    // silently becomes a copy of `open`. Skipping quietly there is a heavy
    // lane reporting success for a comparison it did not make — and a workflow
    // that lost the flag in an edit would go green, not red.
    //
    // Spelled as an `if` rather than `assert!(cfg!(...), ..)` because the
    // latter is a constant assertion and `clippy::assertions_on_constants`
    // (a `-D warnings` gate here) rejects it.
    if cfg!(not(feature = "triangulation-alt")) {
        panic!("the heavy lane needs the differential oracle. Run:\n  {HEAVY_LANE_CMD}");
    }

    // Named directly rather than filtered out of `discover_models`, which
    // excludes both of these by `MAX_FIXTURE_BYTES` before opening anything —
    // reaching an oversized fixture is the entire point of this lane.
    //
    // PANICS on an absent fixture, the opposite of what the rest of this
    // repo's fixture-gated tests do, and that is the point. They skip because
    // they run inside `cargo test --workspace`, where an absent corpus must
    // not red the build. This lane is `#[ignore]`d and only ever runs because
    // something asked for it BY NAME, so a silent pass here is a heavy lane
    // reporting success over a file it never opened.
    let path = crate_dir().join("..").join("..").join("tests/models").join(model);
    assert!(
        path.is_file(),
        "{model} is not on disk under tests/models/ — fetch it with `pnpm fixtures` \
         before running this lane"
    );

    let (rows, swept_models) = sweep(&[(model.to_string(), path)]);
    let run = totals(&rows);

    println!("\n=== heavy lane: {model} ===");
    println!("void hosts    : {}", run.hosts);
    println!("torn hosts    : {}", run.torn);
    println!("unmatched edges (signed) : {}", run.open_edges);
    println!("strict-rule edges        : {}", run.strict_edges);

    let mut torn: Vec<&HostRow> = rows.iter().filter(|r| r.open > 0).collect();
    torn.sort_by_key(|r| std::cmp::Reverse(r.open));
    if !torn.is_empty() {
        println!("\n  torn hosts (worst first):");
        for r in torn.iter().take(15) {
            println!("  TORN  {}", fmt_host(r));
        }
    }

    // Written BEFORE every assertion, for the reason [`RUN_REPORT_PATH`] is:
    // the run that DISAGREES with the golden is exactly the run whose rows are
    // wanted, and a report written after the gate is never written on it.
    // Best-effort — a read-only `target/` must not red a passing lane.
    //
    // One report path PER FIXTURE, unlike the main census's single
    // `RUN_REPORT_PATH`: the workflow runs both tests out of one binary, so a
    // shared path would leave whichever finished last as the only artifact and
    // the other run would look like it had never happened.
    let stem = model.rsplit('/').next().unwrap_or(model).trim_end_matches(".ifc");
    let report_path =
        crate_dir().join(format!("../../target/watertightness_census.heavy.{stem}.tsv"));
    if let Some(dir) = report_path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    match std::fs::write(&report_path, census_golden::render(&rows)) {
        Ok(()) => println!("\nthis run's rows: {}", report_path.display()),
        Err(e) => println!("\ncould not write {}: {e}", report_path.display()),
    }

    // FLOOR, and it sits above the bless path for the same reason the main
    // census's does: an under-populated run must never be able to write a
    // truncated golden. `> 0` would not have done that job — a run that meshed
    // one host of 363 satisfies it, and the bless path below returns before
    // every check, so it would write a one-row golden and delete 362 ceilings.
    // This is `MIN_VOID_HOSTS`, per fixture.
    assert!(
        run.hosts >= min_hosts,
        "swept {model} and found {} void host(s), below the floor of {min_hosts}. Either \
         the fixture is truncated or the pipeline stopped meshing a class of host; \
         either way the ceilings in {HEAVY_GOLDEN_PATH} would be vacuous against this \
         run, so it must not gate and must not bless",
        run.hosts
    );

    let bless = census_golden::bless_mode(
        std::env::var_os(BLESS_ENV).is_some(),
        std::env::var_os("CI").is_some_and(|v| !v.is_empty() && v != "0" && v != "false"),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    let golden_path = crate_dir().join(HEAVY_GOLDEN_PATH);
    let golden = read_golden(&golden_path, bless);

    if bless {
        // Keeping the rows of models this run did not sweep is what lets the
        // two fixtures share one golden and be blessed one at a time.
        // `CENSUS_SWEEP_LOCK`, held for all of this function, is what makes the
        // read-modify-write safe when both lanes bless in one invocation.
        let mut next: Vec<HostRow> =
            golden.iter().filter(|r| !swept_models.contains(&r.model)).cloned().collect();
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
        return None;
    }

    // Scoped to THIS model, not `!golden.is_empty()`: the two fixtures share
    // one file, so a golden that had lost every ISSUE_068 row would still be
    // non-empty and would gate that fixture as 363 `added` rows — red, but
    // describing the wrong event.
    assert!(
        golden.iter().any(|r| r.model == model),
        "{} carries no rows for {model}. Generate them with:\n  {HEAVY_BLESS_CMD}",
        golden_path.display()
    );

    let diff = census_golden::diff(&golden, &rows, &swept_models);

    println!("regressed : {}", diff.regressed.len());
    println!("coverage loss (in golden, produced nothing): {}", diff.missing.len());
    println!("added (newly meshing): {}", diff.added.len());
    println!("reclassified: {}", diff.changed.len());
    println!("retessellated: {}", diff.retessellated.len());
    // Printed under `retessellated` exactly as the main census does: that
    // bucket can read 0 on the very run it exists for, when a reclassification
    // outranks it, and this tally is the only thing that says so.
    println!("  of which shrank while healing: {}", diff.shrank_while_healing);
    println!("volume moved: {}", diff.volume_moved.len());
    println!("improved  : {}", diff.improved.len());
    print_buckets(&diff);

    assert!(
        diff.regressed.is_empty(),
        "{} host(s) in {model} REGRESSED against {HEAVY_GOLDEN_PATH}:\n{}",
        diff.regressed.len(),
        fmt_deltas(&diff.regressed)
    );
    assert!(
        diff.missing.is_empty(),
        "COVERAGE LOSS in {model}: {} host(s) in the golden produced no geometry in \
         this run:\n{}",
        diff.missing.len(),
        diff.missing.iter().map(fmt_host).collect::<Vec<_>>().join("\n")
    );
    assert!(
        !diff.requires_bless(),
        "the diff against {HEAVY_GOLDEN_PATH} requires a bless — review the buckets \
         printed above, then:\n  {HEAVY_BLESS_CMD}"
    );

    Some(run)
}

/// #3434. ISSUE_053 (Holter Tower, 169 MB) is the exact fixture AGENTS.md's
/// perf section names as "where every shipped regression has lived", and until
/// this lane it was invisible to the census: `discover_models` excludes it by
/// size before ever opening the file. It measures clean, so on top of the
/// per-host golden diff [`run_heavy_lane`] performs it also asserts the
/// aggregate.
///
/// That aggregate is belt and braces, and worth stating as such rather than
/// overselling. Every check the diff makes is a per-host CEILING, so a golden
/// whose `open` columns had all been blessed up from 0 would satisfy it while
/// this fixture had quietly stopped being the clean-corpus coverage win it was
/// added for. [`the_heavy_golden_pins_the_known_3435_tear_population`] already
/// rejects exactly that golden, on every PR — but it does NOT run inside this
/// workflow, which invokes `--ignored heavy_fixture` and so selects only the
/// two lanes. This line is what closes that gap for a runner that gates the
/// sweep without ever having gated the file.
#[test]
#[ignore = "heavy-fixture lane (#3434), run by .github/workflows/geometry-census-heavy.yml: \
            ISSUE_053 is 169 MB, excluded from the default sweep by MAX_FIXTURE_BYTES"]
fn heavy_fixture_issue_053_is_watertight() {
    let Some(run) = run_heavy_lane(ISSUE_053_MODEL, ISSUE_053_MIN_HOSTS) else {
        return;
    };
    assert_eq!(
        run.torn, 0,
        "{ISSUE_053_MODEL} is pinned clean (0 torn hosts); now {} host(s) are torn. If \
         this is a genuine, reviewed regression, bless it into {HEAVY_GOLDEN_PATH} like \
         any other golden change; if not, it is the exact defect class #3434 exists to \
         surface",
        run.torn
    );
}

/// #3434 built this lane; the tear it found is #3435. ISSUE_068 (54 MB) carries
/// a live, unfixed CSG defect: a population of void hosts that read watertight
/// before their voids are applied and torn after, concentrated on hosts taking
/// many sequential boolean cuts against one swept solid — the shape AGENTS.md's
/// perf section warns about for this fixture class.
///
/// The tear is pinned per host in [`HEAVY_GOLDEN_PATH`] and its size in
/// [`ISSUE_068_KNOWN_TORN_HOSTS`]; the module doc's "heavy lane" section
/// argues why recording it beats asserting `torn == 0` on every run. What this
/// lane therefore catches is a tear that is NEW — a host clean in the golden
/// that tore, a host that stopped meshing, a host the golden has never seen —
/// and a #3435 that got better or worse as a whole. What it does not catch is
/// #3435 itself: that stays open, and this lane is what tells anyone working on
/// it whether they moved it.
#[test]
#[ignore = "heavy-fixture lane (#3434), run by .github/workflows/geometry-census-heavy.yml: \
            ISSUE_068 is 54 MB, excluded from the default sweep by MAX_FIXTURE_BYTES"]
fn heavy_fixture_issue_068_carries_the_known_3435_tear() {
    let Some(run) = run_heavy_lane(ISSUE_068_MODEL, ISSUE_068_MIN_HOSTS) else {
        return;
    };
    assert_eq!(
        run.torn, ISSUE_068_KNOWN_TORN_HOSTS,
        "{ISSUE_068_MODEL} has {} torn void host(s) / {} open edges, against a pinned \
         #3435 population of {ISSUE_068_KNOWN_TORN_HOSTS}. FEWER means #3435 moved and \
         the pin plus {HEAVY_GOLDEN_PATH} should be tightened to match — say which \
         change did it. MORE means a new tear, and the per-host diff printed above \
         names the hosts. Either way this is a real event, not a threshold to bump:\n  \
         {HEAVY_BLESS_CMD}",
        run.torn, run.open_edges
    );
}

/// The pin that makes "quietly re-blessed away" impossible.
///
/// Reads the CHECKED-IN golden with `include_str!` — no fixture, no sweep, no
/// feature — so unlike the two lanes above it runs in the default
/// `cargo test --workspace` on every PR. The sweep that PRODUCES the golden
/// runs weekly; this is what watches the file in between.
///
/// Between them: the weekly sweep is the only thing that can measure a new
/// tear, and this test is the only thing that can catch a golden edited to
/// absorb one. Blessing #3435 out of the file moves the golden's torn-row count
/// and reds this test until someone edits [`ISSUE_068_KNOWN_TORN_HOSTS`], a
/// named constant in the diff whose name says which issue is being moved.
#[test]
fn the_heavy_golden_pins_the_known_3435_tear_population() {
    let rows = census_golden::parse(include_str!("manifests/watertightness_census_heavy.tsv"))
        .expect("the checked-in heavy golden must parse");

    // Both readings come from `census_golden::totals`, the same function the
    // sweep's own numbers come from, so "torn" cannot mean one thing in the
    // weekly lane and another in this per-PR pin.
    let for_model = |m: &str| totals(rows.iter().filter(|r| r.model == m));
    let t053 = for_model(ISSUE_053_MODEL);
    let t068 = for_model(ISSUE_068_MODEL);

    assert!(
        t053.hosts >= ISSUE_053_MIN_HOSTS && t068.hosts >= ISSUE_068_MIN_HOSTS,
        "the heavy golden is under-populated: {} rows for ISSUE_053 (floor {}), {} for \
         ISSUE_068 (floor {}). A golden blessed against a half-fetched tests/models tree \
         looks like this, and every ceiling in it would then be vacuous",
        t053.hosts,
        ISSUE_053_MIN_HOSTS,
        t068.hosts,
        ISSUE_068_MIN_HOSTS
    );

    assert_eq!(
        t053.torn,
        0,
        "{ISSUE_053_MODEL} is the heavy lane's CLEAN fixture and its golden must carry \
         no torn host. A torn row here means a regression was blessed in rather than \
         fixed"
    );
    assert_eq!(
        t068.torn, ISSUE_068_KNOWN_TORN_HOSTS,
        "the heavy golden records {} torn host(s) for {ISSUE_068_MODEL}, but \
         ISSUE_068_KNOWN_TORN_HOSTS says {ISSUE_068_KNOWN_TORN_HOSTS}. If #3435 moved, \
         move both together and say which change did it; if it did not, this golden was \
         edited without one",
        t068.torn
    );

    // The same property the main golden's sibling test pins: `f != r` implies
    // `(f, r) != (1, 1)`, so no walk can emit `strict < open`. A hand-edited or
    // badly merged row can.
    for r in &rows {
        assert!(
            r.strict >= r.open,
            "{} #{}: strict {} < open {} — no walk can produce this row",
            r.model,
            r.id,
            r.strict,
            r.open
        );
    }
}
