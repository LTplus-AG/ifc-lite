// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Per-host golden for the watertightness census, and the diff that gives its
//! numbers a DIRECTION (#2432).
//!
//! The census used to gate absolute totals over whatever the sweep happened to
//! mesh. Two opposite events moved those totals the same way:
//!
//! 1. an existing mesh got worse — a regression, and
//! 2. an element that previously failed to mesh at all now meshes imperfectly —
//!    an improvement.
//!
//! and one event moved them the *reassuring* way while being the worst of the
//! three: an element that silently stopped meshing takes its own defects out of
//! every total, so coverage loss reads as an improvement.
//!
//! Absolute totals cannot separate those, because nothing in them pins element
//! identity across runs. This module does: one row per swept void host, keyed by
//! `(model, express id)`, checked in and diffed. The four cases are then
//! distinct, and the failure message says which one happened.
//!
//! # The key is the manifest-relative PATH, not the basename
//!
//! Three basenames appear twice in the fixture manifest
//! (`basin-tessellation.ifc`, `tessellation-with-individual-colors.ifc`,
//! `column-straight-rectangle-tessellation.ifc`, each under two vendor
//! directories). Keying on the basename would collide their hosts and let one
//! model's row answer for another's.
//!
//! # Models that were not swept are not compared
//!
//! `MIN_MODELS` deliberately sits under the full corpus so a single failed
//! fixture fetch does not red the build. A whole-corpus golden would throw that
//! away: every host of an unfetched model would read as coverage loss. So the
//! diff is scoped to the models this run actually swept, and blessing preserves
//! the rows of the ones it did not. The census prints the models it did not
//! sweep, because that is the one remaining way coverage can leave quietly.
//!
//! # Scope
//!
//! The census sweeps VOID HOSTS, so this gives coverage-regression detection for
//! those ~1170 elements, not for every product in the corpus. An element with no
//! `IfcRelVoidsElement` that stops meshing is still invisible here. Widening the
//! sweep is a separate, much more expensive change: the ~20-minute run already
//! only processes about one element in a hundred.

use std::collections::{BTreeMap, BTreeSet};

/// Representation types that describe a CLOSED solid and are therefore
/// legitimately expected to produce watertight geometry.
pub fn is_closed_solid(rep: &str) -> bool {
    matches!(rep, "SweptSolid" | "CSG" | "Clipping" | "Brep" | "AdvancedBrep")
}

/// Open boundary edges of the same host with NO voids applied — the reading
/// that separates "arrived torn" from "the boolean tore it".
///
/// Only computed for hosts that are torn WITH voids, because that is the only
/// place it is read; recomputing it for the ~85% of hosts that are watertight
/// would double the sweep for nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreVoid {
    /// Host is watertight with voids applied, so the no-void reading was never taken.
    NotTaken,
    /// Processing the host without voids failed outright.
    Failed,
    /// Open boundary edges without voids.
    Open(usize),
}

/// One swept void host.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostRow {
    /// Manifest-relative path of the fixture. See the module note on basenames.
    pub model: String,
    pub id: u32,
    /// `RepresentationType` of the Body representation.
    pub rep: String,
    /// Open boundary edges on the 1 mm snapped topology.
    pub open: usize,
    /// Triangles in the emitted mesh. Load-bearing on its own: a host whose mesh
    /// degrades to EMPTY still returns `Ok` and still reports `open == 0`, which
    /// is indistinguishable from a perfect watertight solid under an
    /// open-count-only golden.
    pub tris: usize,
    /// Host carries at least one triangle collapsed by the 1 mm snap.
    pub collapsed: bool,
    /// Largest |coordinate| is beyond what f32 can carry mm topology at, so this
    /// host's tears are an artifact of running below the pipeline's RTC offset.
    /// Reported, never gated.
    pub far: bool,
    /// Open boundary edges under the ALTERNATE triangulator. `None` when that
    /// pass failed to process the host at all.
    pub alt: Option<usize>,
    /// See [`PreVoid`]. Diagnostic: carried so the origin split and the
    /// closed-solid expectation are derivable from the golden, never compared.
    pub pre: PreVoid,
}

impl HostRow {
    /// Does this host's watertightness depend on the triangulator's diagonal
    /// choice? A failed alternate pass counts as divergence — it is a difference
    /// in outcome, and the old census counted it as one too.
    pub fn diverged(&self) -> bool {
        self.alt != Some(self.open)
    }

    /// Is this a genuine watertightness defect: a closed solid, torn, at
    /// coordinates f32 handles cleanly, whose no-void pass did not itself fail?
    pub fn is_torn_solid(&self) -> bool {
        self.open > 0
            && is_closed_solid(&self.rep)
            && !self.far
            && self.pre != PreVoid::Failed
    }

    fn key(&self) -> (&str, u32) {
        (self.model.as_str(), self.id)
    }
}

/// The corpus totals the census reports, every one of them a pure function of a
/// set of host rows.
///
/// Deriving both the run's readings and the golden's expectations from ONE
/// function is the point: the previous ceilings were hand-written constants that
/// could only be checked against the log of a green run, and nothing forced the
/// number in the source to still mean what the sweep computes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Totals {
    pub hosts: usize,
    pub torn: usize,
    pub open_edges: usize,
    pub collapsed: usize,
    pub torn_solid: usize,
    pub non_invariant: usize,
}

pub fn totals<'a>(rows: impl IntoIterator<Item = &'a HostRow>) -> Totals {
    let mut t = Totals {
        hosts: 0,
        torn: 0,
        open_edges: 0,
        collapsed: 0,
        torn_solid: 0,
        non_invariant: 0,
    };
    for r in rows {
        t.hosts += 1;
        t.open_edges += r.open;
        t.torn += usize::from(r.open > 0);
        t.collapsed += usize::from(r.collapsed);
        t.torn_solid += usize::from(r.is_torn_solid());
        t.non_invariant += usize::from(r.diverged());
    }
    t
}

/// A host that is present in both the golden and the run, and differs.
///
/// Only the run's row is carried: every reason string names both sides
/// (`"open edges 10 -> 11"`), so a second copy of the golden row would be one
/// more thing that can disagree with the message next to it.
#[derive(Clone, Debug)]
pub struct Delta {
    pub run: HostRow,
    /// Human-readable, one per dimension that moved.
    pub reasons: Vec<String>,
}

/// The four outcomes the old aggregate totals could not tell apart, plus the
/// one they could not see at all.
#[derive(Default, Debug)]
pub struct Diff {
    /// Strictly worse on at least one gated dimension. A real regression.
    pub regressed: Vec<Delta>,
    /// In the golden, its model WAS swept, and it produced nothing. Coverage
    /// loss — the defect class that used to make every total look better.
    pub missing: Vec<HostRow>,
    /// Meshed in this run and absent from the golden. An addition, not a defect.
    pub added: Vec<HostRow>,
    /// Differs in a way that is neither better nor worse: the host was
    /// reclassified. See [`reclassifications`].
    pub changed: Vec<Delta>,
    /// Strictly better. Reported, never a failure.
    ///
    /// So the golden is a CEILING per host, not an equality snapshot, and a fix
    /// does not red the lane it improves. The cost is that the ratchet does not
    /// self-tighten: after an unblessed improvement from 40 open edges to 10, a
    /// later slide back to 40 reads as clean. Blessing is what tightens it, and
    /// the improvement list printed by the census is the prompt to do so. Making
    /// improvements fail instead would buy that tightening at the price of
    /// redding every geometry fix on the commit that makes it, which is the
    /// friction that got the old constants bumped without scrutiny.
    pub improved: Vec<Delta>,
}

impl Diff {
    /// Everything the golden must be re-blessed to absorb.
    pub fn requires_bless(&self) -> bool {
        !self.regressed.is_empty()
            || !self.missing.is_empty()
            || !self.added.is_empty()
            || !self.changed.is_empty()
    }
}

/// Should this run rewrite the golden instead of gating against it?
///
/// Blessing REWRITES the gate's own expectations and returns before every check
/// below it, so a blessing run is vacuously green — the one path by which this
/// census could report "all good" because it stopped measuring. On a developer
/// machine that is a deliberate act and exactly what the flag is for. In CI it
/// would disarm the lane silently and permanently, so it is refused there: CI
/// re-blesses by downloading the run-rows artifact, which every run writes
/// unconditionally, gated or not.
pub fn bless_mode(bless_set: bool, in_ci: bool) -> Result<bool, &'static str> {
    if bless_set && in_ci {
        return Err(
            "refusing to bless in CI: blessing rewrites the golden and skips every check \
             below it, so the lane would be vacuously green. Download the run-rows \
             artifact from this job and commit it as the golden instead.",
        );
    }
    Ok(bless_set)
}

/// Dimensions on which a matched pair can be RECLASSIFIED: neither better nor
/// worse, but a different thing is now being measured, so the census must not
/// absorb it silently.
///
/// `far` belongs here with `rep` because both are inputs to
/// [`HostRow::is_torn_solid`] that carry no direction of their own. A host
/// crossing the f32 magnitude threshold enters or leaves the gated defect
/// population without any of its own counts moving, which is exactly the kind of
/// silent population change this golden exists to surface.
fn reclassifications(g: &HostRow, r: &HostRow) -> Vec<String> {
    let mut out = Vec::new();
    if g.rep != r.rep {
        out.push(format!("representation {} -> {}", g.rep, r.rep));
    }
    if g.far != r.far {
        let side = |f: bool| if f { "far-field" } else { "f32-safe" };
        out.push(format!("coordinate magnitude {} -> {}", side(g.far), side(r.far)));
    }
    out
}

/// How one matched pair moved.
#[derive(Default)]
struct Classified {
    /// A COUNT this host carries got worse. Directional on its own: no
    /// relabelling of the host can make more unmatched edges into good news.
    worse_counts: Vec<String>,
    /// The gated `is_torn_solid` predicate started holding. Kept apart from
    /// `worse_counts` because it is DERIVED from `rep`/`far`/`pre` as well as
    /// from `open`, so a pure reclassification flips it without any count
    /// moving, and calling that a geometry regression would be the same
    /// misattribution in the opposite direction.
    worse_gated: Vec<String>,
    better: Vec<String>,
}

/// Classify one matched pair.
fn classify(g: &HostRow, r: &HostRow) -> Classified {
    let mut c = Classified::default();

    if r.open > g.open {
        c.worse_counts.push(format!("open edges {} -> {}", g.open, r.open));
    } else if r.open < g.open {
        c.better.push(format!("open edges {} -> {}", g.open, r.open));
    }

    // Triangles SHRINKING is the loss direction: geometry disappeared while the
    // host still reported success.
    if r.tris < g.tris {
        c.worse_counts.push(format!("triangles {} -> {} (geometry lost)", g.tris, r.tris));
    } else if r.tris > g.tris {
        c.better.push(format!("triangles {} -> {}", g.tris, r.tris));
    }

    if r.collapsed && !g.collapsed {
        c.worse_counts.push("gained snap-collapsed triangles".to_string());
    } else if !r.collapsed && g.collapsed {
        c.better.push("no longer has snap-collapsed triangles".to_string());
    }

    if r.diverged() && !g.diverged() {
        c.worse_counts.push("newly depends on the triangulator's diagonal choice".to_string());
    } else if !r.diverged() && g.diverged() {
        c.better.push("no longer depends on the triangulator's diagonal choice".to_string());
    }

    // The gated predicate itself, not only its inputs. `is_torn_solid` also reads
    // `pre`, and a no-void pass that starts or stops failing moves a host into or
    // out of the genuine-defect population while `open`, `tris`, `collapsed` and
    // `alt` all hold. Without this the derived `closed solids that are not
    // watertight` ceiling could grow with every per-host check silent — a total
    // moving with nothing to attribute it to, which is the whole complaint.
    if r.is_torn_solid() && !g.is_torn_solid() {
        c.worse_gated
            .push("newly a genuine watertightness defect (closed solid, f32-safe, torn)".to_string());
    } else if !r.is_torn_solid() && g.is_torn_solid() {
        c.better.push("no longer a genuine watertightness defect".to_string());
    }

    c
}

/// Diff a run against the golden, scoped to the models this run actually swept.
///
/// A host is only ever reported MISSING when its model was swept — see the
/// module note on fixture-fetch tolerance.
pub fn diff(golden: &[HostRow], run: &[HostRow], swept_models: &BTreeSet<String>) -> Diff {
    let by_key: BTreeMap<(&str, u32), &HostRow> = golden.iter().map(|r| (r.key(), r)).collect();
    let seen: BTreeSet<(&str, u32)> = run.iter().map(|r| r.key()).collect();

    let mut out = Diff::default();
    for r in run {
        let Some(g) = by_key.get(&r.key()) else {
            out.added.push(r.clone());
            continue;
        };
        let reclassified = reclassifications(g, r);
        let c = classify(g, r);
        let delta = |reasons| Delta { run: r.clone(), reasons };
        // Order matters, and it is the whole point of the issue.
        //
        // A worsened COUNT outranks everything, including a reclassification.
        // Filing a host that both changed representation type AND tore further
        // under "reclassified — review, then re-bless" would invite precisely
        // the re-bless that absorbs the tear. Worse on any count also outranks
        // an improvement on another: trading a tear for a collapse is not a
        // wash.
        //
        // A reclassification then outranks the DERIVED `is_torn_solid` flip,
        // because a host relabelled `SurfaceModel -> CSG` joins the gated defect
        // population without a single one of its counts moving, and that is a
        // change of question, not a degradation.
        if !c.worse_counts.is_empty() {
            let mut reasons = c.worse_counts;
            reasons.extend(c.worse_gated);
            reasons.extend(reclassified);
            out.regressed.push(delta(reasons));
        } else if !reclassified.is_empty() {
            let mut reasons = reclassified;
            reasons.extend(c.worse_gated);
            out.changed.push(delta(reasons));
        } else if !c.worse_gated.is_empty() {
            out.regressed.push(delta(c.worse_gated));
        } else if !c.better.is_empty() {
            out.improved.push(delta(c.better));
        }
    }
    for g in golden {
        if swept_models.contains(&g.model) && !seen.contains(&g.key()) {
            out.missing.push(g.clone());
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Serialization
//
// TSV, one host per line, sorted. The whole point of this file is that a human
// reviews its diff, and a 1170-element JSON array does not diff readably: one
// changed count would render as a multi-line hunk. One line per host means one
// changed host is one changed line.
// ---------------------------------------------------------------------------

const HEADER: &str = "\
# Per-host watertightness census golden. Generated, do not hand-edit.
#
# Re-bless with:
#   IFCLITE_CENSUS_BLESS=1 cargo test -p ifc-lite-geometry \\
#     --features triangulation-alt --test triangulation_invariance
#
# model: manifest-relative path (basenames are NOT unique across the corpus).
# open:  open boundary edges, 1 mm snapped topology.
# tris:  emitted triangles. A shrink is geometry loss even when open stays 0.
# coll:  1 if any triangle collapsed under the snap.
# far:   1 if |coord| is past what f32 carries mm topology at (reported, not gated).
# alt:   open edges under the alternate triangulator, or x if that pass failed.
# pre:   open edges with no voids applied; x if that pass failed, - if not taken.
model\tid\trep\topen\ttris\tcoll\tfar\talt\tpre";

fn pre_token(p: PreVoid) -> String {
    match p {
        PreVoid::NotTaken => "-".to_string(),
        PreVoid::Failed => "x".to_string(),
        PreVoid::Open(v) => v.to_string(),
    }
}

fn parse_pre(tok: &str) -> Result<PreVoid, String> {
    match tok {
        "-" => Ok(PreVoid::NotTaken),
        "x" => Ok(PreVoid::Failed),
        v => v.parse().map(PreVoid::Open).map_err(|_| format!("bad pre {v:?}")),
    }
}

fn parse_flag(tok: &str) -> Result<bool, String> {
    match tok {
        "0" => Ok(false),
        "1" => Ok(true),
        v => Err(format!("bad flag {v:?}")),
    }
}

pub fn render(rows: &[HostRow]) -> String {
    let mut rows: Vec<&HostRow> = rows.iter().collect();
    rows.sort_by(|a, b| a.key().cmp(&b.key()));
    let mut out = String::from(HEADER);
    for r in rows {
        let alt = r.alt.map(|v| v.to_string()).unwrap_or_else(|| "x".to_string());
        out.push_str(&format!(
            "\n{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
            r.model,
            r.id,
            r.rep,
            r.open,
            r.tris,
            u8::from(r.collapsed),
            u8::from(r.far),
            alt,
            pre_token(r.pre),
        ));
    }
    out.push('\n');
    out
}

pub fn parse(text: &str) -> Result<Vec<HostRow>, String> {
    let mut out = Vec::new();
    for (n, line) in text.lines().enumerate() {
        // Skip comments, the column header and blank lines. `model\t` catches
        // the header without also swallowing a fixture literally named "model".
        if line.is_empty() || line.starts_with('#') || line.starts_with("model\t") {
            continue;
        }
        let f: Vec<&str> = line.split('\t').collect();
        if f.len() != 9 {
            return Err(format!("line {}: expected 9 columns, got {}", n + 1, f.len()));
        }
        let num = |i: usize| -> Result<usize, String> {
            f[i].parse::<usize>().map_err(|_| format!("line {}: bad number {:?}", n + 1, f[i]))
        };
        out.push(HostRow {
            model: f[0].to_string(),
            id: f[1].parse().map_err(|_| format!("line {}: bad id {:?}", n + 1, f[1]))?,
            rep: f[2].to_string(),
            open: num(3)?,
            tris: num(4)?,
            collapsed: parse_flag(f[5]).map_err(|e| format!("line {}: {e}", n + 1))?,
            far: parse_flag(f[6]).map_err(|e| format!("line {}: {e}", n + 1))?,
            alt: if f[7] == "x" { None } else { Some(num(7)?) },
            pre: parse_pre(f[8]).map_err(|e| format!("line {}: {e}", n + 1))?,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(model: &str, id: u32, open: usize, tris: usize) -> HostRow {
        HostRow {
            model: model.to_string(),
            id,
            rep: "SweptSolid".to_string(),
            open,
            tris,
            collapsed: false,
            far: false,
            alt: Some(open),
            pre: PreVoid::NotTaken,
        }
    }

    fn swept(models: &[&str]) -> BTreeSet<String> {
        models.iter().map(|m| m.to_string()).collect()
    }

    #[test]
    fn a_grown_open_count_is_a_regression_and_a_shrunk_one_is_not() {
        let g = vec![row("a.ifc", 1, 10, 100)];
        let worse = diff(&g, &[row("a.ifc", 1, 11, 100)], &swept(&["a.ifc"]));
        assert_eq!(worse.regressed.len(), 1, "open 10 -> 11 must regress");
        assert!(worse.improved.is_empty());

        let better = diff(&g, &[row("a.ifc", 1, 9, 100)], &swept(&["a.ifc"]));
        assert!(better.regressed.is_empty(), "open 10 -> 9 must not regress");
        assert_eq!(better.improved.len(), 1);
        assert!(!better.requires_bless(), "an improvement alone must not red the build");
    }

    #[test]
    fn losing_triangles_regresses_even_while_open_stays_zero() {
        // The failure this column exists for: a host whose mesh degrades to
        // empty still returns Ok and still reports open == 0, which reads as a
        // perfect watertight solid under an open-count-only golden.
        let g = vec![row("a.ifc", 1, 0, 800)];
        let d = diff(&g, &[row("a.ifc", 1, 0, 0)], &swept(&["a.ifc"]));
        assert_eq!(d.regressed.len(), 1, "800 -> 0 triangles must regress");
        assert!(d.regressed[0].reasons[0].contains("geometry lost"));
    }

    #[test]
    fn a_host_that_stopped_meshing_is_coverage_loss_not_an_improvement() {
        // The #2382 bug class: under absolute totals this element's defects
        // simply leave the sum and the census reads greener.
        let g = vec![row("a.ifc", 1, 40, 100), row("a.ifc", 2, 0, 50)];
        let d = diff(&g, &[row("a.ifc", 2, 0, 50)], &swept(&["a.ifc"]));
        assert_eq!(d.missing.len(), 1);
        assert_eq!(d.missing[0].id, 1);
        assert!(d.improved.is_empty(), "a vanished host is not an improvement");
        assert!(d.requires_bless());
    }

    #[test]
    fn a_model_that_was_not_swept_reports_no_coverage_loss() {
        // Fixture-fetch tolerance: MIN_MODELS sits under the corpus on purpose.
        let g = vec![row("a.ifc", 1, 40, 100), row("unfetched.ifc", 7, 0, 20)];
        let d = diff(&g, &[row("a.ifc", 1, 40, 100)], &swept(&["a.ifc"]));
        assert!(d.missing.is_empty(), "an unswept model's hosts are not missing");
        assert!(!d.requires_bless());
    }

    #[test]
    fn a_newly_meshing_host_is_an_addition_not_a_regression() {
        let g = vec![row("a.ifc", 1, 0, 100)];
        let d = diff(&g, &[row("a.ifc", 1, 0, 100), row("a.ifc", 2, 90, 400)], &swept(&["a.ifc"]));
        assert!(d.regressed.is_empty(), "recovered geometry must not read as a regression");
        assert_eq!(d.added.len(), 1);
        assert_eq!(d.added[0].id, 2);
        assert!(d.requires_bless(), "an addition must still be acknowledged");
    }

    #[test]
    fn worse_on_one_dimension_beats_better_on_another() {
        let mut r = row("a.ifc", 1, 5, 400);
        r.collapsed = true;
        let d = diff(&[row("a.ifc", 1, 10, 100)], &[r], &swept(&["a.ifc"]));
        assert_eq!(d.regressed.len(), 1, "a gained collapse is not offset by fewer open edges");
        assert!(d.improved.is_empty());
    }

    #[test]
    fn a_newly_triangulator_dependent_host_regresses() {
        let mut r = row("a.ifc", 1, 10, 100);
        r.alt = Some(12);
        let d = diff(&[row("a.ifc", 1, 10, 100)], &[r], &swept(&["a.ifc"]));
        assert_eq!(d.regressed.len(), 1);
        assert!(d.regressed[0].reasons[0].contains("diagonal choice"));

        // A failed alternate pass is a divergence too.
        let mut f = row("a.ifc", 1, 10, 100);
        f.alt = None;
        let d = diff(&[row("a.ifc", 1, 10, 100)], &[f], &swept(&["a.ifc"]));
        assert_eq!(d.regressed.len(), 1);
    }

    #[test]
    fn crossing_the_f32_magnitude_threshold_is_a_reclassification() {
        // `far` is an input to `is_torn_solid` with no direction of its own, so a
        // host crossing the threshold enters or leaves the gated defect
        // population while every count it carries holds. Silently absorbing that
        // would be a population change with nothing to attribute it to.
        let mut g = row("a.ifc", 1, 4, 100);
        g.rep = "CSG".to_string();
        g.pre = PreVoid::Open(0);
        g.far = true;
        let mut r = g.clone();
        r.far = false;
        let d = diff(&[g.clone()], &[r], &swept(&["a.ifc"]));
        assert_eq!(d.changed.len(), 1, "a far -> near flip must be acknowledged");
        assert!(d.changed[0].reasons[0].contains("coordinate magnitude"));
        assert!(d.regressed.is_empty());
        assert!(d.improved.is_empty());
    }

    #[test]
    fn a_no_void_pass_that_stops_failing_makes_the_host_a_gated_defect() {
        // The other input to `is_torn_solid` that moves on its own. With `pre`
        // Failed the host is excluded from the genuine-defect count; once that
        // pass succeeds it joins, and `open`, `tris`, `collapsed` and `alt` are
        // all unmoved. Only the gated predicate itself sees this.
        let mut g = row("a.ifc", 1, 4, 100);
        g.rep = "CSG".to_string();
        g.pre = PreVoid::Failed;
        assert!(!g.is_torn_solid());
        let mut r = g.clone();
        r.pre = PreVoid::Open(0);
        assert!(r.is_torn_solid());

        let d = diff(&[g.clone()], &[r.clone()], &swept(&["a.ifc"]));
        assert_eq!(d.regressed.len(), 1, "joining the gated defect set is a regression");
        assert!(d.regressed[0].reasons[0].contains("genuine watertightness defect"));

        // And the reverse direction is an improvement, not a regression.
        let back = diff(&[r], &[g], &swept(&["a.ifc"]));
        assert!(back.regressed.is_empty());
        assert_eq!(back.improved.len(), 1);
    }

    /// Every `HostRow` shape that matters, for the exhaustive invariant below.
    fn variants() -> Vec<HostRow> {
        let mut out = Vec::new();
        for rep in ["CSG", "SurfaceModel"] {
            for open in [0usize, 3] {
                for tris in [0usize, 5] {
                    for collapsed in [false, true] {
                        for far in [false, true] {
                            for alt in [None, Some(0usize), Some(3), Some(9)] {
                                for pre in
                                    [PreVoid::NotTaken, PreVoid::Failed, PreVoid::Open(0), PreVoid::Open(2)]
                                {
                                    out.push(HostRow {
                                        model: "a.ifc".to_string(),
                                        id: 1,
                                        rep: rep.to_string(),
                                        open,
                                        tris,
                                        collapsed,
                                        far,
                                        alt,
                                        pre,
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
        out
    }

    #[test]
    fn a_clean_diff_can_never_let_a_derived_total_grow() {
        // The census still prints and asserts corpus ceilings, now DERIVED from
        // the golden. Those assertions are only honest if they are implied by the
        // per-host checks: a total that can grow while every host reads clean
        // would fail with a message naming no element, which is precisely the
        // unattributable number this issue is about.
        //
        // Exhaustive over every dimension the classifier reads, both sides.
        let vs = variants();
        let all = swept(&["a.ifc"]);
        let mut checked = 0usize;
        for g in &vs {
            for r in &vs {
                let d = diff(std::slice::from_ref(g), std::slice::from_ref(r), &all);
                if d.requires_bless() {
                    continue;
                }
                checked += 1;
                let (want, got) = (totals([g]), totals([r]));
                assert!(got.open_edges <= want.open_edges, "open edges: {g:?} -> {r:?}");
                assert!(got.torn <= want.torn, "torn: {g:?} -> {r:?}");
                assert!(got.collapsed <= want.collapsed, "collapsed: {g:?} -> {r:?}");
                assert!(got.torn_solid <= want.torn_solid, "torn solid: {g:?} -> {r:?}");
                assert!(got.non_invariant <= want.non_invariant, "non-invariant: {g:?} -> {r:?}");
                assert_eq!(got.hosts, want.hosts);
            }
        }
        // Guard against the loop vacuously skipping everything.
        assert!(checked > vs.len(), "only {checked} clean pairs of {}", vs.len() * vs.len());
    }

    #[test]
    fn a_reclassified_host_that_also_tore_further_is_a_regression() {
        // The re-bless trap. Under a reclassification-first rule this host reads
        // as "reclassified — review, then re-bless", and the re-bless absorbs a
        // 10 -> 400 tear without anyone having been told there was one.
        let mut r = row("a.ifc", 1, 400, 100);
        r.rep = "CSG".to_string();
        let d = diff(&[row("a.ifc", 1, 10, 100)], &[r], &swept(&["a.ifc"]));
        assert!(d.changed.is_empty(), "a worsened count must not be filed as a relabel");
        assert_eq!(d.regressed.len(), 1);
        let reasons = d.regressed[0].reasons.join("; ");
        assert!(reasons.contains("open edges 10 -> 400"), "{reasons}");
        assert!(reasons.contains("representation SweptSolid -> CSG"), "{reasons}");
    }

    #[test]
    fn joining_the_gated_defect_set_by_relabel_alone_is_a_reclassification() {
        // The opposite misattribution. `is_torn_solid` reads `rep`, so a host
        // relabelled SurfaceModel -> CSG enters the gated defect population with
        // every count it carries unmoved. That is a change of question, not a
        // degradation, and calling it a regression would send someone hunting a
        // geometry bug that does not exist.
        let mut g = row("a.ifc", 1, 4, 100);
        g.rep = "SurfaceModel".to_string();
        g.pre = PreVoid::Open(0);
        assert!(!g.is_torn_solid());
        let mut r = g.clone();
        r.rep = "CSG".to_string();
        assert!(r.is_torn_solid());

        let d = diff(&[g], &[r], &swept(&["a.ifc"]));
        assert!(d.regressed.is_empty(), "a pure relabel is not a geometry regression");
        assert_eq!(d.changed.len(), 1);
        let reasons = d.changed[0].reasons.join("; ");
        assert!(reasons.contains("representation SurfaceModel -> CSG"), "{reasons}");
        // Still says the gated population grew — acknowledged, not hidden.
        assert!(reasons.contains("genuine watertightness defect"), "{reasons}");
    }

    #[test]
    fn blessing_is_refused_in_ci_and_allowed_locally() {
        // The one path that returns green without measuring anything.
        assert_eq!(bless_mode(true, false), Ok(true), "a developer may re-bless");
        assert_eq!(bless_mode(false, true), Ok(false));
        assert_eq!(bless_mode(false, false), Ok(false));
        let err = bless_mode(true, true).expect_err("CI must never bless");
        assert!(err.contains("vacuously green"), "{err}");
    }

    #[test]
    fn a_reclassified_representation_is_neither_better_nor_worse() {
        let mut r = row("a.ifc", 1, 10, 100);
        r.rep = "CSG".to_string();
        let d = diff(&[row("a.ifc", 1, 10, 100)], &[r], &swept(&["a.ifc"]));
        assert!(d.regressed.is_empty());
        assert!(d.improved.is_empty());
        assert_eq!(d.changed.len(), 1);
        assert!(d.requires_bless());
    }

    #[test]
    fn identical_basenames_under_different_directories_stay_distinct() {
        // Three basenames genuinely repeat across the fixture manifest. Keying
        // on the basename would let one model's row answer for another's.
        let g = vec![row("x/basin.ifc", 1, 0, 10), row("y/basin.ifc", 1, 0, 10)];
        let run = vec![row("x/basin.ifc", 1, 0, 10), row("y/basin.ifc", 1, 99, 10)];
        let d = diff(&g, &run, &swept(&["x/basin.ifc", "y/basin.ifc"]));
        assert_eq!(d.regressed.len(), 1);
        assert_eq!(d.regressed[0].run.model, "y/basin.ifc");
    }

    #[test]
    fn render_round_trips_through_parse() {
        let rows = vec![
            HostRow {
                model: "vendor/a.ifc".to_string(),
                id: 42,
                rep: "CSG".to_string(),
                open: 7,
                tris: 300,
                collapsed: true,
                far: false,
                alt: None,
                pre: PreVoid::Open(3),
            },
            HostRow {
                model: "vendor/a.ifc".to_string(),
                id: 7,
                rep: "SurfaceModel".to_string(),
                open: 0,
                tris: 0,
                collapsed: false,
                far: true,
                alt: Some(0),
                pre: PreVoid::Failed,
            },
        ];
        let text = render(&rows);
        let back = parse(&text).expect("round trip");
        // render sorts, so compare against the sorted expectation.
        let mut want = rows.clone();
        want.sort_by(|a, b| (a.model.as_str(), a.id).cmp(&(b.model.as_str(), b.id)));
        assert_eq!(back, want);
        // And the file is stable: re-rendering what we parsed is byte-identical.
        assert_eq!(render(&back), text);
    }

    #[test]
    fn a_truncated_row_is_an_error_not_a_silently_short_golden() {
        let err = parse("model\tid\trep\topen\ttris\tcoll\tfar\talt\tpre\na.ifc\t1\tCSG\t0\t0\t0\t0\n")
            .expect_err("a 7-column row must not parse");
        assert!(err.contains("expected 9 columns"), "{err}");
    }

    #[test]
    fn torn_solid_counts_only_f32_safe_closed_solids_that_processed() {
        let solid = |rep: &str, open: usize, far: bool, pre: PreVoid| HostRow {
            rep: rep.to_string(),
            open,
            far,
            pre,
            ..row("a.ifc", 1, 0, 10)
        };
        assert!(solid("CSG", 4, false, PreVoid::Open(0)).is_torn_solid());
        assert!(!solid("CSG", 0, false, PreVoid::Open(0)).is_torn_solid(), "watertight");
        assert!(!solid("SurfaceModel", 4, false, PreVoid::Open(0)).is_torn_solid(), "open by design");
        assert!(!solid("CSG", 4, true, PreVoid::Open(0)).is_torn_solid(), "far field is not gated");
        assert!(!solid("CSG", 4, false, PreVoid::Failed).is_torn_solid(), "no-void pass failed");
    }
}
