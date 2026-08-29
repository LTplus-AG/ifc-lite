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
//! names this exact class — "a heavy CSG model (Holter/ISSUE_053) since CI
//! never touches that class and that is where every shipped regression has
//! lived" — and until #3434 the census instrument did not touch it either.
//!
//! [`heavy_fixture_issue_053_is_watertight`] and
//! [`heavy_fixture_issue_068_has_a_known_boolean_tear`], near the bottom of this
//! file, reach the two fixtures directly (bypassing `discover_models`'s size
//! filter, not raising [`MAX_FIXTURE_BYTES`] itself) and run the SAME per-host
//! walk via [`sweep`]. Both are `#[ignore]`d, this repo's existing convention
//! for a fixture too expensive for the default `cargo test` — see
//! `wall_opening_cut_regression.rs` and `issue_053_heavy_csg_probe.rs` for the
//! same pattern. Run them SEPARATELY -- they have OPPOSITE expectations, and a
//! bare `heavy_fixture` filter matches both, so it always reports a failure:
//!
//!   # passes: ISSUE_053 against its own golden
//!   cargo test -p ifc-lite-geometry --features triangulation-alt \
//!     --test triangulation_invariance \
//!     -- --ignored --nocapture heavy_fixture_issue_053_is_watertight
//!
//!   # FAILS TODAY, deliberately -- it asserts the #3435 tear is gone
//!   cargo test -p ifc-lite-geometry --features triangulation-alt \
//!     --test triangulation_invariance \
//!     -- --ignored --nocapture heavy_fixture_issue_068
//!
//! ISSUE_053 measures CLEAN (289/289 void hosts watertight) and is checked
//! against its own per-host golden, [`HEAVY_GOLDEN_PATH`], exactly like the
//! main corpus above — a genuine, gated coverage win. ISSUE_068 measures 29
//! torn hosts / 285 open edges, a live, unfixed CSG defect now tracked as
//! #3435 (one host, `IFCWALLSTANDARDCASE #43810`, carries 38
//! `IfcRelVoidsElement` cuts against one swept solid and 27 of the 29 torn
//! hosts are confirmed CSG-caused: `pre` reads watertight, `post` does not).
//! That is NOT written into any golden: doing so would freeze a live bug as
//! expected, checked-in output, which is the opposite of what #3434 is for.
//! Its test instead asserts the CORRECT end state (`torn == 0`) and is
//! expected to FAIL until #3435 is fixed, documenting the defect rather than
//! certifying it.

mod census_golden;

use census_golden::{is_closed_solid, totals, Delta, HostRow, PreVoid};
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

/// Fixtures excluded from [`discover_models`] by [`MAX_FIXTURE_BYTES`], reached
/// deliberately by the opt-in heavy lane at the bottom of this file (#3434).
/// Relative to `tests/models/`, matching `discover_models`'s keys.
const HEAVY_FIXTURES: &[&str] = &[
    "ara3d/ISSUE_053_20181220Holter_Tower_10.ifc",
    "ara3d/ISSUE_068_ARK_NUS_skolebygg.ifc",
];

/// `(manifest-relative path, absolute path)` for each fixture in
/// [`HEAVY_FIXTURES`] that is actually on disk.
///
/// Unlike `discover_models`, this does NOT check size against
/// `MAX_FIXTURE_BYTES` — reaching an oversized fixture is the entire point —
/// and it does not read `manifest.json` either: it names its fixtures
/// directly rather than filtering the full corpus down to two entries. A
/// fixture not yet fetched is silently skipped rather than failing the lane,
/// matching `discover_models`'s treatment of a missing file.
fn discover_heavy_models() -> Vec<(String, PathBuf)> {
    let models = crate_dir().join("..").join("..").join("tests/models");
    HEAVY_FIXTURES
        .iter()
        .map(|rel| (rel.to_string(), models.join(rel)))
        .filter(|(_, p)| p.is_file())
        .collect()
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
            rows.push(HostRow {
                model: rel.clone(),
                id,
                rep: representation_type(&content, &lines, id),
                open,
                strict: stats.strict,
                tris: base.indices.len() / 3,
                collapsed: stats.degenerate > 0,
                far: max_abs_coord(&base) >= F32_SAFE_MAGNITUDE,
                alt: alt.as_ref().map(open_boundary_edges),
                pre,
            });
        }
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
    println!("improved  : {}", diff.improved.len());
    // EVERY bucket names its hosts HERE, before any assert, `regressed`
    // included even though its assert happens to run first. The asserts run
    // regressed -> missing -> retessellated -> added -> changed and the FIRST
    // failure panics, so any bucket that only names its hosts inside its own
    // assert is a bare count whenever an earlier one fails. Keeping all six in
    // this block means reordering the asserts cannot silently cost a bucket its
    // host names.
    //
    // The run that motivated this is the one where several buckets are
    // non-empty at once: whatever stays in `regressed` panics first, and every
    // host that shrank while healing would otherwise show up only as a count.
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
    for r in &diff.added {
        println!("  ADDED  {}", fmt_host(r));
    }
    for d in &diff.changed {
        println!("  RECLASSIFIED  {}", fmt_delta(d));
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
        "{} host(s) RE-TESSELLATED: fewer triangles AND fewer open edges. Usually \
         a cut that stopped over-extending, but the test is magnitude-blind - a \
         near-total loss on a torn host also lands here, so CHECK THE SHRINK \
         before blessing. If the shrink is intended, re-bless:\n  {BLESS_CMD}\n{}",
        diff.retessellated.len(),
        fmt_deltas(&diff.retessellated)
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

/* -------------------------------------------------------------------- *
 * The heavy lane (#3434). See the module doc's "heavy lane" section.   *
 * -------------------------------------------------------------------- */

/// Per-host golden for the heavy lane's CLEAN fixture only — ISSUE_053. Never
/// carries ISSUE_068: see the module doc's "heavy lane" section for why.
const HEAVY_GOLDEN_PATH: &str = "tests/manifests/watertightness_census_heavy.tsv";

const HEAVY_BLESS_CMD: &str = "IFCLITE_CENSUS_BLESS=1 cargo test -p ifc-lite-geometry \
                               --features triangulation-alt --test triangulation_invariance \
                               -- --ignored heavy_fixture_issue_053_is_watertight";

const ISSUE_053_MODEL: &str = "ara3d/ISSUE_053_20181220Holter_Tower_10.ifc";
const ISSUE_068_MODEL: &str = "ara3d/ISSUE_068_ARK_NUS_skolebygg.ifc";

/// #3434. ISSUE_053 (Holter Tower, 169 MB) is the exact fixture AGENTS.md's
/// perf section names as "where every shipped regression has lived", and until
/// this test it was invisible to the census: `discover_models` excludes it by
/// size before ever opening the file. Measured clean — 289/289 void hosts
/// watertight — so unlike ISSUE_068 below it gets a real per-host golden,
/// [`HEAVY_GOLDEN_PATH`], diffed through the exact same [`census_golden`]
/// machinery as the main corpus: a genuine, gated coverage win rather than a
/// bare smoke check.
///
/// `#[ignore]`d: 169 MB is too expensive for the default `cargo test`. Run:
///
///   cargo test -p ifc-lite-geometry --features triangulation-alt \
///     --test triangulation_invariance -- --ignored --nocapture \
///     heavy_fixture_issue_053_is_watertight
///
/// Bless only after confirming a change is a genuine, reviewed fix — same rule
/// as the main golden:
///
///   IFCLITE_CENSUS_BLESS=1 cargo test -p ifc-lite-geometry \
///     --features triangulation-alt --test triangulation_invariance \
///     -- --ignored heavy_fixture_issue_053_is_watertight
#[test]
#[ignore = "manual heavy-fixture lane (#3434): ISSUE_053 is 169 MB, excluded from the default sweep by MAX_FIXTURE_BYTES"]
fn heavy_fixture_issue_053_is_watertight() {
    if cfg!(not(feature = "triangulation-alt")) {
        eprintln!(
            "SKIPPED: rerun with --features triangulation-alt to enable the \
             differential oracle"
        );
        return;
    }

    let models: Vec<(String, PathBuf)> =
        discover_heavy_models().into_iter().filter(|(rel, _)| rel == ISSUE_053_MODEL).collect();
    assert!(
        !models.is_empty(),
        "{ISSUE_053_MODEL} is not on disk under tests/models/ — fetch it with \
         scripts/fixtures/fetch-fixtures.mjs before running this lane"
    );

    let (rows, swept_models) = sweep(&models);
    let run = totals(&rows);

    println!("\n=== heavy lane: {ISSUE_053_MODEL} ===");
    println!("void hosts    : {}", run.hosts);
    println!("torn hosts    : {}", run.torn);
    println!("unmatched edges (signed) : {}", run.open_edges);
    println!("strict-rule edges        : {}", run.strict_edges);

    assert!(
        run.hosts > 0,
        "swept {ISSUE_053_MODEL} but found no void hosts — the fixture loaded \
         but is empty of the class this lane exists to measure, which is itself \
         a sign something is wrong"
    );

    let golden_path = crate_dir().join(HEAVY_GOLDEN_PATH);
    let golden_text = std::fs::read_to_string(&golden_path).unwrap_or_default();
    let golden = census_golden::parse(&golden_text)
        .unwrap_or_else(|e| panic!("{} is unreadable: {e}", golden_path.display()));

    let bless = census_golden::bless_mode(
        std::env::var_os(BLESS_ENV).is_some(),
        std::env::var_os("CI").is_some_and(|v| !v.is_empty() && v != "0" && v != "false"),
    )
    .unwrap_or_else(|e| panic!("{e}"));

    if bless {
        // Preserve rows of heavy models this run did not sweep (none today,
        // since the golden only ever carries ISSUE_053, but the same rule as
        // the main golden's bless path applies if that ever changes).
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
        return;
    }

    assert!(
        !golden.is_empty(),
        "{} is missing or empty. Generate it with:\n  {HEAVY_BLESS_CMD}",
        golden_path.display()
    );

    let diff = census_golden::diff(&golden, &rows, &swept_models);

    println!("regressed : {}", diff.regressed.len());
    println!("coverage loss (in golden, produced nothing): {}", diff.missing.len());
    println!("added (newly meshing): {}", diff.added.len());
    println!("reclassified: {}", diff.changed.len());
    println!("retessellated: {}", diff.retessellated.len());
    println!("improved  : {}", diff.improved.len());
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
    for r in &diff.added {
        println!("  ADDED  {}", fmt_host(r));
    }
    for d in &diff.changed {
        println!("  RECLASSIFIED  {}", fmt_delta(d));
    }

    assert!(
        diff.regressed.is_empty(),
        "{} host(s) in {ISSUE_053_MODEL} REGRESSED against {HEAVY_GOLDEN_PATH}:\n{}",
        diff.regressed.len(),
        fmt_deltas(&diff.regressed)
    );
    assert!(
        diff.missing.is_empty(),
        "COVERAGE LOSS in {ISSUE_053_MODEL}: {} host(s) in the golden produced no \
         geometry in this run:\n{}",
        diff.missing.len(),
        diff.missing.iter().map(fmt_host).collect::<Vec<_>>().join("\n")
    );
    assert!(
        !diff.requires_bless(),
        "the diff against {HEAVY_GOLDEN_PATH} requires a bless (added, reclassified, or \
         re-tessellated rows present) — review the buckets printed above, then:\n  {HEAVY_BLESS_CMD}"
    );

    // The fixture measured clean when #3434 added this lane (289/289 void
    // hosts watertight). Kept as an explicit assertion alongside the golden
    // diff above: the diff's checks are all CEILINGS, so a golden whose `open`
    // columns silently grew from 0 to some small number on every row would
    // still pass them while this fixture stopped being the coverage win #3434
    // added it for.
    assert_eq!(
        run.torn, 0,
        "{ISSUE_053_MODEL} was clean (0 torn hosts) when #3434 measured it; now {} host(s) \
         are torn. If this is a genuine, reviewed regression, bless it into \
         {HEAVY_GOLDEN_PATH} like any other golden change; if not, it is the exact defect \
         class #3434 exists to surface",
        run.torn
    );
}

/// #3434 built this lane; the tear itself is #3435. ISSUE_068 (54 MB) is
/// torn: 29 of 363 void hosts, 285 total open edges, deterministic across two
/// independent runs. The worst single host is `IFCWALLSTANDARDCASE #43810`:
/// 42 open edges across 38 `IfcRelVoidsElement` cuts against one swept solid —
/// the "many sequential boolean cuts" shape AGENTS.md's perf section warns
/// about for this fixture class. 27 of the 29 torn hosts are confirmed
/// CSG-caused (a `pre`-void reading of watertight going to torn `post`-void),
/// so this is a boolean-kernel bug to fix, not corpus noise to record.
///
/// Deliberately asserts the CORRECT end state (`torn == 0`), not today's
/// count, and is expected to FAIL until #3435 is fixed — the same convention
/// `wall_opening_cut_regression.rs` and `issue_3353_boolean_tear.rs` already
/// use for a known, unfixed defect. This fixture is NOT in any golden: writing
/// its 29 torn rows into a checked-in baseline would freeze a live bug as
/// expected, passing output, which is the opposite of what #3434 is for. Once
/// #3435 is fixed, remove `#[ignore]` here — and, if the fixture is then
/// clean, fold ISSUE_068 into [`heavy_fixture_issue_053_is_watertight`]'s
/// golden-backed pattern instead of leaving it as a bare assertion.
///
/// `#[ignore]`d for the same reason `heavy_fixture_issue_053_is_watertight` is:
/// too expensive for the default `cargo test`. Run:
///
///   cargo test -p ifc-lite-geometry --features triangulation-alt \
///     --test triangulation_invariance -- --ignored --nocapture \
///     heavy_fixture_issue_068_has_a_known_boolean_tear
#[test]
#[ignore = "documents a known, unfixed CSG tear (#3434) — expected to fail until the tear is fixed"]
fn heavy_fixture_issue_068_has_a_known_boolean_tear() {
    if cfg!(not(feature = "triangulation-alt")) {
        eprintln!(
            "SKIPPED: rerun with --features triangulation-alt to enable the \
             differential oracle"
        );
        return;
    }

    let models: Vec<(String, PathBuf)> =
        discover_heavy_models().into_iter().filter(|(rel, _)| rel == ISSUE_068_MODEL).collect();
    assert!(
        !models.is_empty(),
        "{ISSUE_068_MODEL} is not on disk under tests/models/ — fetch it with \
         scripts/fixtures/fetch-fixtures.mjs before running this lane"
    );

    let (rows, _swept_models) = sweep(&models);
    let run = totals(&rows);

    println!("\n=== heavy lane: {ISSUE_068_MODEL} ===");
    println!("void hosts total : {}", run.hosts);
    println!("torn hosts       : {}", run.torn);
    println!("unmatched edges (signed) : {}", run.open_edges);
    println!("strict-rule edges        : {}", run.strict_edges);
    let mut torn: Vec<&HostRow> = rows.iter().filter(|r| r.open > 0).collect();
    torn.sort_by_key(|r| std::cmp::Reverse(r.open));
    println!("\n  torn hosts (worst first):");
    for r in torn.iter().take(15) {
        println!("  TORN  {}", fmt_host(r));
    }

    assert_eq!(
        run.torn, 0,
        "{ISSUE_068_MODEL} has {} torn void host(s) / {} open edges — a known, unfixed \
         CSG defect tracked as #3435 (surfaced by the #3434 heavy lane). This assertion \
         pins the CORRECT end state, not today's count, so this test stays red on \
         purpose until #3435 is fixed rather than certifying it. See the module doc's \
         \"heavy lane\" section for why this fixture carries no golden.",
        run.torn, run.open_edges
    );
}
