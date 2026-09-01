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
//! `(model, express id)`, checked in and diffed. The cases are then distinct,
//! and the failure message says which one happened.
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
    /// Open boundary edges on the 1 mm snapped topology, read as a SIGNED
    /// per-edge balance: an undirected edge counts when its forward and its
    /// reverse use counts DIFFER.
    ///
    /// #3397 kept this reading rather than replacing it. [`HostRow::strict`] is
    /// the stricter reading of the same walk, and the two are carried side by
    /// side precisely so they can be compared per host — replacing this one
    /// would restate every number in the golden at once and surface every
    /// pre-existing non-manifold host as a new tear, which is a different
    /// decision from measuring how many there are.
    pub open: usize,
    /// Undirected edges of the SAME 1 mm snapped topology whose directed uses
    /// are not exactly one forward and one reverse — the manifold condition
    /// `touching_operand.rs` and the #3353 tear pin already use (#3397).
    ///
    /// A superset of [`HostRow::open`] by construction: `forward != reverse`
    /// implies `(forward, reverse) != (1, 1)`. What it sees that `open` cannot
    /// is every topology where the two directed counts grow TOGETHER, leaving
    /// the signed net at zero: a face duplicated along with its opposite-wound
    /// twin, a wholesale duplicated shell, a 2-forward / 2-reverse non-manifold
    /// seam. The two DUPLICATION cases also grow `tris`, and a grown `tris`
    /// files under `better`, so before this column the census reported a
    /// duplicated sheet as an improvement. The seam is stated without that
    /// claim: four triangles meeting on one edge need not have arrived by
    /// duplication, so `tris` may not have moved at all, and then nothing in
    /// the row moved either.
    ///
    /// Both readings come off ONE walk in `edge_stats`, over one snapped
    /// topology, so they cannot drift into two measurements of two meshes.
    pub strict: usize,
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

    /// Can this row's `open` be COMPARED against another's as repair?
    ///
    /// Read `open` for what it is first: `edge_stats` accumulates a SIGNED
    /// per-edge balance and counts the non-zero entries, so a duplicated face
    /// contributes one forward and one reverse use and CANCELS to zero. That is
    /// weaker than the directed-pair rule (`forward == 1 && reverse == 1`) used
    /// by the #3353 tear pin, and the two can disagree: a mesh can be watertight
    /// by this count and non-manifold by the strict one. So a fall in `open` can
    /// mean a face was duplicated rather than a tear repaired. Raised by the
    /// #3391 review, where a signed count and a strict one gave contradictory
    /// readings on the same mesh.
    ///
    /// WHAT IS NOW MEASURED (#3397). The row carries [`HostRow::strict`], the
    /// directed-pair reading of the same walk, and `classify` gates a RISE in it
    /// as a worsened count. So the duplication hazard above is no longer
    /// un-gated: the pair that hides it — `open` falling while `strict` rises —
    /// files as a regression, and a worsened count outranks the re-tessellation
    /// verdict, which is where a falling `open` would otherwise buy a friendly
    /// message.
    ///
    /// WHAT IS STILL NOT. `strict` is deliberately kept out of this predicate
    /// and out of [`Self::is_torn_solid`], so the gated defect population and
    /// the `torn` / `torn_solid` / `total unmatched edges` totals all still read
    /// the SIGNED count: a host that has always been non-manifold is not
    /// reclassified into a tear by this change. `alt` and `pre` are signed
    /// readings too, so a duplicated sheet that only ONE triangulator emits
    /// stays invisible to [`Self::diverged`]. And neither reading sees a
    /// self-intersection, or coincidence finer than the 1 mm snap, or anything
    /// about a host with no `IfcRelVoidsElement` — the sweep's own scope.
    ///
    /// Not a weakening of [`Self::open_is_a_defect_count`] and not a
    /// strengthening: the two are INCOMPARABLE, because they add different
    /// fourth clauses to the same base. This one allows a FAR-FIELD count,
    /// which is noisy rather than meaningless, and refuses a COLLAPSED one,
    /// which the other never looks at. The census already treats
    /// a far host's open count as meaningful when it RISES, since that reds the
    /// build with no gate at all, so refusing to credit the same count when it
    /// FALLS was an asymmetry rather than caution. Measured cost of that
    /// asymmetry on the #3219 run: the re-tessellation bucket reported 0 while
    /// 20 hosts shrank with their open edges improving, all of them `far`, 11
    /// blocked by this clause alone. The noise is reported in the reason instead.
    pub fn open_is_comparable(&self) -> bool {
        self.open_is_a_reading() && !self.collapsed
    }

    /// The pair both readings below agree on, factored out because neither is a
    /// weakening of the other: they add different fourth clauses, so without
    /// this the shared half was written twice and only prose said they were
    /// related. See either caller for what the two clauses mean.
    fn open_is_a_reading(&self) -> bool {
        is_closed_solid(&self.rep) && self.pre != PreVoid::Failed
    }

    /// Is this row's `open` a watertightness READING at all, whatever its value?
    ///
    /// An open shell's boundary edges are structural rather than a defect, a
    /// far-field count is an f32 artifact (`far` is "reported, never gated"),
    /// and a failed no-void pass leaves nothing to attribute the tearing to.
    /// Says nothing about whether the count is zero, which is why this is
    /// separate from [`Self::is_torn_solid`]: a run whose open count fell to 0
    /// is the ideal repair, not a disqualified reading.
    ///
    /// Reads the SIGNED `open`, not [`HostRow::strict`], and #3397 left it that
    /// way on purpose. This predicate defines the gated defect population, so
    /// swapping the reading would move `torn_solid` on every host that is
    /// watertight by one rule and not the other, in one commit, with no way to
    /// tell those hosts from geometry that actually changed. The strict reading
    /// is gated as its OWN count instead; see [`Self::open_is_comparable`] for
    /// what that does and does not buy.
    pub fn open_is_a_defect_count(&self) -> bool {
        self.open_is_a_reading() && !self.far
    }

    /// Is this a genuine watertightness defect: a closed solid, torn, at
    /// coordinates f32 handles cleanly, whose no-void pass did not itself fail?
    pub fn is_torn_solid(&self) -> bool {
        self.open > 0 && self.open_is_a_defect_count()
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
    /// Sum of [`HostRow::strict`]. A ceiling of its own ALONGSIDE `open_edges`,
    /// never instead of it: the two are readings of the same corpus, and the gap
    /// between them is how many edges the signed balance cannot see. That is a
    /// corpus-wide EDGE figure and not #3397's headline number, which is a HOST
    /// count (`open == 0 && strict > 0`) and is computed in the census itself.
    pub strict_edges: usize,
    pub collapsed: usize,
    pub torn_solid: usize,
    pub non_invariant: usize,
}

pub fn totals<'a>(rows: impl IntoIterator<Item = &'a HostRow>) -> Totals {
    let mut t = Totals {
        hosts: 0,
        torn: 0,
        open_edges: 0,
        strict_edges: 0,
        collapsed: 0,
        torn_solid: 0,
        non_invariant: 0,
    };
    for r in rows {
        t.hosts += 1;
        t.open_edges += r.open;
        t.strict_edges += r.strict;
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

/// The outcomes the old aggregate totals could not tell apart, plus the ones
/// they could not see at all. `missing` is the sharp case: a host that stopped
/// meshing removes its own defects from every sum, so the totals rendered a
/// coverage loss as an IMPROVEMENT.
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
    /// Fewer triangles AND fewer open edges: on a TORN host, the mesh got
    /// smaller and less torn at the same time. Still requires a bless, because
    /// the golden is a per-host ceiling and this moves it, but it is not the
    /// same event as losing geometry and must not be counted as one.
    ///
    /// Scoring every triangle drop as loss made this census unable to see the
    /// class it was pointed at. Measured by running the candidate #3219 cap fix
    /// through this lane: of the 32 hosts it calls regressed, 20 had FEWER open
    /// edges than the golden, and 9 of those now file here instead. Every one of
    /// the 20 was `far`, which is what moved that axis from gating to tagging.
    ///
    /// That run needs a fix that is not checked into this repo, so the figure
    /// cannot be re-derived from the tree the way the golden tallies below can.
    /// It is a different measurement from the eligible-row count quoted further
    /// down, over a different population.
    ///
    /// Scope, stated because it is easy to overestimate: this can only fire
    /// where BOTH sides satisfy `open_is_comparable`, which is neither weaker
    /// nor stronger than `is_torn_solid`. It is more permissive on the
    /// far-field axis, so a golden row that is far and torn qualifies here
    /// while `g.is_torn_solid()` is false, and more restrictive on the collapse
    /// axis, which `is_torn_solid` does not read at all.
    ///
    /// The figures below are a property of the golden AS CHECKED IN, not of the
    /// rule, so a re-bless can invalidate them and nothing here would notice.
    /// Recount before relying on them, over
    /// `tests/manifests/watertightness_census.tsv`, by tallying rows with
    /// `open > 0` into four groups: rep not in `is_closed_solid`, else
    /// `pre == x`, else `coll == 1`, else eligible. The `pre` group is empty in
    /// the golden as checked in, which is exactly why it is easy to leave out of
    /// a recount and wrong to. Recounted after the local-frame cut stopped
    /// baking its centre into f32: 86 of 1170 rows are eligible, 17 of them
    /// far-field. 1005 have `open == 0` and at `0 -> 0` open cannot fall; of
    /// the 165 that are torn, 35 are open shells whose boundary edges are
    /// structural. A shrink anywhere else still reads as geometry loss. The row
    /// vocabulary genuinely cannot tell a
    /// healed over-cut from a vanished component on a watertight host, and red
    /// is the right answer while that is true. Separating those needs a volume
    /// dimension the golden does not carry yet.
    ///
    /// It over-fires in the other direction too, and for the same missing
    /// dimension. A torn host that loses a whole solid item can land here: at
    /// golden `open=40 tris=800`, a run of `open=2 tris=400` has dropped half
    /// the mesh, yet tris is non-zero and open did fall, so it is filed as a
    /// re-tessellation and described as "less torn". Only the total vanish
    /// (`tris == 0`) is caught by rule. Nothing passes silently, since this
    /// bucket is red either way, but the failure text is friendlier than the
    /// event deserves and the exposure is a wrong BLESS. Do not add a
    /// proportionality heuristic to patch it: that is a second magnitude rule
    /// on a vocabulary with no magnitude in it, which is the same mistake as
    /// reading a triangle count as damage. The volume dimension is the fix.
    pub retessellated: Vec<Delta>,
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
    /// Hosts the classifier called a re-tessellation, counted WHATEVER bucket
    /// won the verdict.
    ///
    /// Not "every host whose tris and open both fell": this counts exactly the
    /// pairs that reached `c.retessellated`, so the eligibility rules still
    /// apply. A shell whose 40 boundary edges became 12 while it shrank is NOT
    /// here, because that fall is not repair; nor is a total vanish. Those are
    /// geometry loss and are counted as regressions.
    ///
    /// `retessellated` only holds the ones where nothing outranked it, and a
    /// reclassification does. A wall-cut change is what flips
    /// `SweptSolid <-> Clipping`, so on the run this bucket exists for the
    /// relabel is the likely companion and `retessellated.len()` can read 0
    /// while many hosts shrank while healing. Without this tally that population
    /// is recoverable only by grepping reason strings across three buckets,
    /// which is the census going quiet about its own subject.
    pub shrank_while_healing: usize,
}

impl Diff {
    /// Everything the golden must be re-blessed to absorb.
    pub fn requires_bless(&self) -> bool {
        !self.regressed.is_empty()
            || !self.missing.is_empty()
            || !self.added.is_empty()
            || !self.changed.is_empty()
            || !self.retessellated.is_empty()
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
/// `far` and `pre` belong here with `rep` because all three are inputs to
/// [`HostRow::is_torn_solid`] that carry no direction of their own. A host
/// crossing the f32 magnitude threshold, or a no-void probe starting or
/// stopping to fail, enters or leaves the gated defect population without any
/// of its own counts moving, which is exactly the kind of silent population
/// change this golden exists to surface. Without `pre` here, a probe going
/// dark (`Open(n) -> Failed`) reads as the host "no longer a genuine
/// watertightness defect" — an improvement — which is precisely the coverage
/// loss this module's header calls the worst of the three cases (#3366).
fn reclassifications(g: &HostRow, r: &HostRow) -> Vec<String> {
    let mut out = Vec::new();
    if g.rep != r.rep {
        out.push(format!("representation {} -> {}", g.rep, r.rep));
    }
    if g.far != r.far {
        let side = |f: bool| if f { "far-field" } else { "f32-safe" };
        out.push(format!("coordinate magnitude {} -> {}", side(g.far), side(r.far)));
    }
    if g.pre != r.pre {
        out.push(format!("no-void pass {} -> {}", pre_token(g.pre), pre_token(r.pre)));
    }
    out
}

/// How one matched pair moved.
#[derive(Default)]
struct Classified {
    /// A COUNT this host carries got worse. The `open` member is directional on
    /// its own: no relabelling can make more unmatched edges into good news.
    ///
    /// That is NOT true of the whole field any more. A `tris` shrink routes here
    /// or to `retessellated` by reading `rep`, `far` and `pre` on both sides,
    /// so membership is no longer independent of how the host is classified.
    /// `worse_gated` is still a separate field, but the line between them is the
    /// QUESTION each answers, not which inputs it reads.
    worse_counts: Vec<String>,
    /// The gated `is_torn_solid` predicate started holding. A REASON
    /// annotation, never a verdict of its own: it rides along on whichever of
    /// `regressed` / `changed` the pair was already routed to, so the failure
    /// text always says the gated population grew, and no branch below is
    /// decided by it.
    ///
    /// It cannot be a verdict, because it is DERIVED. `is_torn_solid` reads
    /// exactly `open`, `rep`, `far` and `pre`; `open` moving is a directional
    /// count, and `rep`/`far`/`pre` moving is a [`reclassifications`] entry
    /// since #3366. So every flip already has a more specific arm with a more
    /// actionable message, and a branch keyed on this alone would be
    /// unreachable — as one was, until #3396 removed it. Kept apart from
    /// `worse_counts` for the same reason: a pure reclassification flips it
    /// without any count moving, and calling that a geometry regression would
    /// be the same misattribution in the opposite direction.
    worse_gated: Vec<String>,
    /// The tris drop came with an open-edge drop. Routed here rather than to
    /// `worse_counts`; see [`Diff::retessellated`] for why that distinction
    /// exists and where it cannot fire.
    retessellated: Vec<String>,
    better: Vec<String>,
}

/// How to describe a FALLING edge count, tagged for EVERY reason the fall might
/// not be repair. `open_is_comparable` names three; caveating only the far-field
/// one would print an unqualified "improved" next to "geometry lost" on exactly
/// the hosts the gate just refused.
///
/// ONE function for both the signed and the strict arm, because the
/// disqualifiers are properties of the host rather than of either reading: an
/// open shell's boundary edges are structural under both rules, a failed no-void
/// pass leaves nothing to attribute either count to, and `edge_stats` skips
/// degenerate triangles, so a collapse depresses both. Two copies would let one
/// arm print "(improved)" beside the other's "geometry lost".
fn fall_note(g: &HostRow, r: &HostRow) -> &'static str {
    if !g.open_is_comparable() || !r.open_is_comparable() {
        // An open shell's boundary edges are structural, so deleting faces
        // takes them along: the count falls BECAUSE geometry was lost. A
        // failed no-void pass leaves nothing to attribute the tearing to.
        "down, but not a repair signal: see the verdict"
    } else if g.far || r.far {
        // Real evidence, just noisy. The census already acts on this count
        // in the other direction with no gate at all.
        "improved; far-field, so the count is an f32 artifact"
    } else {
        "improved"
    }
}

/// Classify one matched pair.
fn classify(g: &HostRow, r: &HostRow) -> Classified {
    let mut c = Classified::default();

    if r.open > g.open {
        c.worse_counts.push(format!("open edges {} -> {}", g.open, r.open));
    } else if r.open < g.open {
        c.better.push(format!("open edges {} -> {} ({})", g.open, r.open, fall_note(g, r)));
    }

    // The STRICT directed-pair reading, gated in its own right (#3397). A rise
    // here while `open` holds is the shape the signed balance cannot see at
    // all: a face duplicated along with its opposite-wound twin nets to zero on
    // that reading and GROWS `tris`, and a grown `tris` files under `better`, so
    // the census used to report the defect as an improvement.
    //
    // It joins `worse_counts` rather than getting a bucket of its own because
    // it answers exactly the question that field asks — a count this host
    // carries got worse, and no relabelling makes more non-manifold edges into
    // good news — and because outranking the re-tessellation verdict is the
    // point: `open` falling while `strict` rises is the duplicated-face case
    // [`HostRow::open_is_comparable`] warns a falling `open` can hide.
    if r.strict > g.strict {
        c.worse_counts.push(format!("strict directed-pair edges {} -> {}", g.strict, r.strict));
    } else if r.strict < g.strict {
        c.better.push(format!(
            "strict directed-pair edges {} -> {} ({})",
            g.strict,
            r.strict,
            fall_note(g, r)
        ));
    }

    // Triangles shrinking is the loss direction ONLY when the tearing did not
    // improve with it. An empty mesh is always a loss: it still returns `Ok` and
    // still reports `open == 0`, so nothing else here would catch it.
    //
    // And only where both open counts are COMPARABLE, because `g.open` and
    // `r.open` only read as repair if each one measures the same kind of thing.
    // `open_is_comparable` is that question. An open shell's boundary edges are
    // structural, so a fall in them is what losing faces looks like; a failed
    // no-void pass leaves nothing to attribute the tearing to; and a collapse
    // depresses the count without repairing anything. All three disqualify.
    //
    // A FAR-FIELD count does not disqualify: it is tagged in the reason instead.
    // That one was decided by measurement, and the measurement lives on
    // [`HostRow::open_is_comparable`] rather than being restated here.
    //
    // Note this is NOT `is_torn_solid` on either side. That predicate keeps
    // `far` and defines the gated defect population and the derived ceilings,
    // which is a different question. The golden side needs no explicit
    // `open > 0` either: `r.open < g.open` already forces it.
    //
    // A COLLAPSE is the fourth way the count can be unreal. It is guarded inside
    // `open_is_comparable`, which the two clauses above call, and deliberately
    // NOT inside `open_is_a_defect_count`, because that predicate
    // also defines `is_torn_solid`, which the derived totals and `worse_gated`
    // read and which has its own pinned test. `edge_stats` SKIPS degenerate
    // triangles, so every one of them removes edges from `open`, and
    // `HostRow.collapsed` is a BOOLEAN: on a host already at `coll=1`, going
    // from 10 degenerate triangles to 200 moves no axis at all, and the entire
    // open drop can be collapse rather than repair. 44 golden rows would
    // otherwise be eligible and carry `coll=1`, so folding this into
    // `open_is_comparable` takes the eligible population from 130 to 86.
    // Carrying the degenerate COUNT instead of a flag would
    // let the axis fire on an increase and is the better fix, but it changes the
    // golden's schema and so needs its own re-bless.
    if r.tris < g.tris {
        let msg = format!("triangles {} -> {}", g.tris, r.tris);
        if r.tris == 0
            || r.open >= g.open
            || !g.open_is_comparable()
            || !r.open_is_comparable()
        {
            c.worse_counts.push(format!("{msg} (geometry lost)"));
        } else {
            c.retessellated.push(format!("{msg} (fewer triangles, less torn)"));
        }
    } else if r.tris > g.tris {
        c.better.push(format!("triangles {} -> {} (improved)", g.tris, r.tris));
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
        // Counted here rather than per branch: the whole point is that it does
        // not depend on which verdict won.
        if !c.retessellated.is_empty() {
            out.shrank_while_healing += 1;
        }

        // Order matters, and it is the whole point of the issue.
        //
        // A worsened COUNT outranks everything, including a reclassification.
        // Filing a host that both changed representation type AND tore further
        // under "reclassified — review, then re-bless" would invite precisely
        // the re-bless that absorbs the tear. Worse on any count also outranks
        // an improvement on another: trading a tear for a collapse is not a
        // wash.
        //
        // Every branch carries EVERY reason list it holds, `better` included.
        // A host can shrink-and-heal while ALSO newly diverging under the
        // alternate triangulator: the divergence decides (regressed), but
        // dropping the shrink from the text makes the failure less informative
        // than it was before the retessellated split existed. A gained COLLAPSE
        // is not the example any more, because `r.collapsed` now disqualifies
        // the re-tessellation outright, so that pair cannot occur. `better` rides
        // along for the same reason and not as good
        // news: the shrink reason SAYS "less torn", and the open-edge numbers
        // are the only thing in the output that lets a reviewer check it.
        //
        // A reclassification then outranks the DERIVED `is_torn_solid` flip,
        // because a host relabelled `SurfaceModel -> CSG` joins the gated defect
        // population without a single one of its counts moving, and that is a
        // change of question, not a degradation.
        //
        // A gated flip is never the DECIDING signal, though, so no arm of this
        // chain is keyed on `worse_gated` alone — #3396 deleted the one that
        // was, and it sat right here, between the reclassification and the
        // re-tessellation. `is_torn_solid` reads exactly `open`, `rep`, `far`
        // and `pre`. Suppose it flips with `reclassifications` empty: then
        // `rep`, `far` and `pre` are equal on both sides (#3366 carries all
        // three), so the three non-count clauses read the same for `g` and `r`,
        // and only `open` can have moved — `g.open == 0` with `r.open > 0`,
        // which is `r.open > g.open`, which fires `worse_counts` and takes the
        // first branch. So every route in is claimed by one of the two branches
        // above, which is also why those two are the only ones carrying
        // `worse_gated` in their reasons: a flip cannot reach `retessellated`
        // or `improved`, so listing it there would be the same dead arm written
        // as a dead concat. Deleting the branch is therefore not a demotion of
        // the signal: it stays in the text either way, and both buckets that
        // can carry it are red and require a bless. Reordering it ABOVE the
        // reclassification would be the real change of meaning, filing a pure
        // relabel as a geometry regression — the misattribution #3366 landed to
        // stop, pinned by the reclassification tests below.
        if !c.worse_counts.is_empty() {
            out.regressed.push(delta(
                [c.worse_counts, c.worse_gated, c.retessellated, reclassified, c.better].concat(),
            ));
        } else if !reclassified.is_empty() {
            out.changed
                .push(delta([reclassified, c.worse_gated, c.retessellated, c.better].concat()));
        } else if !c.retessellated.is_empty() {
            out.retessellated.push(delta([c.retessellated, c.better].concat()));
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
# tris:  emitted triangles. A shrink is geometry loss UNLESS open fell with
#        it on a host whose open count is a real reading; see retessellated.
# coll:  1 if any triangle collapsed under the snap.
# far:   1 if |coord| is past what f32 carries mm topology at (reported, not gated).
# alt:   open edges under the alternate triangulator, or x if that pass failed.
# pre:   open edges with no voids applied; x if that pass failed, - if not taken.
# strict: undirected edges NOT used exactly once forward and once reverse. Always
#        >= open, and sees what open cannot: a doubled sheet nets to zero on the
#        signed balance. Gated as its own count; the defect population is open's.
model\tid\trep\topen\ttris\tcoll\tfar\talt\tpre\tstrict";

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
        // `strict` is appended LAST rather than beside `open`, so `cut -f1-9`
        // over this file still reproduces the pre-#3397 row byte for byte. That
        // is what made the bless diff for the commit that added it readable:
        // every existing column had to hold, and a moved one had to be visible.
        out.push_str(&format!(
            "\n{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
            r.model,
            r.id,
            r.rep,
            r.open,
            r.tris,
            u8::from(r.collapsed),
            u8::from(r.far),
            alt,
            pre_token(r.pre),
            r.strict,
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
        // Exactly 10. A pre-#3397 nine-column row is an ERROR, not a row with
        // an implied strict count: accepting it would have to invent one, and a
        // fabricated zero is a clean-looking host that was never measured. A bad
        // merge of this golden is then loud instead of silently under-gated.
        if f.len() != 10 {
            return Err(format!("line {}: expected 10 columns, got {}", n + 1, f.len()));
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
            strict: num(9)?,
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
            // The clean default: every unbalanced edge is unbalanced, and
            // nothing else is doubled. `strict >= open` always holds, so a
            // helper that set this below `open` would build a row the sweep
            // cannot produce. Tests that need a doubled sheet raise it.
            strict: open,
            tris,
            collapsed: false,
            far: false,
            alt: Some(open),
            // `NotTaken` means "watertight, so the reading was never taken",
            // and the sweep sets it if and only if `open == 0`. A torn row
            // carrying it is a state the census cannot produce, so do not build
            // one. The value is FIXED rather than derived from `open`, because
            // `pre` is the no-void reading and an opening-cut change leaves the
            // base geometry alone: two rows of the same host normally agree
            // here even when their void-applied counts differ.
            pre: if open == 0 { PreVoid::NotTaken } else { PreVoid::Open(7) },
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
    fn fewer_triangles_with_fewer_open_edges_is_retessellation_not_loss() {
        // The direction the old rule could not express: a cut that stops
        // over-extending emits a smaller mesh that is no more torn, and often
        // less. See [`Diff::retessellated`] for the measurement that motivated
        // splitting this out.
        let g = vec![row("a.ifc", 1, 40, 800)];
        let d = diff(&g, &[row("a.ifc", 1, 12, 600)], &swept(&["a.ifc"]));
        assert!(d.regressed.is_empty(), "less torn AND smaller is not a regression");
        assert_eq!(d.retessellated.len(), 1, "it is still a change the golden must absorb");
        let reasons = &d.retessellated[0].reasons;
        assert!(reasons.iter().any(|r| r.contains("less torn")), "{reasons:?}");
        // The evidence for that claim, in the bucket where "CHECK THE SHRINK
        // before blessing" matters most. Pinned per branch, as above.
        assert!(
            reasons.iter().any(|r| r.contains("open edges 40 -> 12")),
            "\"less torn\" is unverifiable without the open-edge numbers: {reasons:?}"
        );
        assert!(d.requires_bless(), "a moved ceiling still needs a bless");
    }

    #[test]
    fn a_shrinking_open_shell_is_loss_however_much_its_boundary_shrank() {
        // The input the `is_closed_solid` clause exists for. A `Tessellation` is
        // an open shell BY CONSTRUCTION, so its unmatched edges are not a defect
        // and deleting faces takes their boundary edges with them: `open` falls
        // BECAUSE geometry was lost. Reading that fall as repair would file a
        // two-thirds mesh loss as "fewer triangles, less torn".
        //
        // Not hypothetical: 46 of the 204 torn golden rows are `Tessellation` or
        // `SurfaceModel`.
        //
        // Both ends are shells here, so BOTH clauses fire and deleting either
        // one alone leaves this test green. It pins the outcome, not either
        // clause; the two tests below take one side each and are what actually
        // pin them. Said explicitly because the earlier version of this comment
        // claimed the golden side, which is not a property this test has.
        let shell = |open, tris| HostRow {
            rep: "Tessellation".to_string(),
            ..row("a.ifc", 1, open, tris)
        };
        let d = diff(&[shell(60, 4000)], &[shell(20, 1200)], &swept(&["a.ifc"]));
        assert_eq!(d.regressed.len(), 1, "an open shell losing 70% of its mesh is loss");
        assert!(d.retessellated.is_empty(), "a falling boundary is not repair here");
        let reasons = &d.regressed[0].reasons;
        assert!(
            reasons.iter().any(|r| r.contains("geometry lost")),
            "and it must be NAMED as loss: {reasons:?}"
        );
        // The open-edge line must not contradict that verdict. It read
        // `open edges 60 -> 20 (improved)` beside `(geometry lost)`, which tells
        // the reviewer the opposite of what the gate just decided.
        assert!(
            reasons.iter().any(|r| r.contains("not a repair signal")),
            "the falling boundary must be qualified, not called an improvement: {reasons:?}"
        );
        assert!(
            !reasons.iter().any(|r| r.contains("(improved)")),
            "nothing here is an unqualified improvement: {reasons:?}"
        );
    }

    #[test]
    fn an_open_shell_that_comes_back_a_smaller_solid_is_loss_not_re_tessellation() {
        // The golden-side half of the same rule. Here the RUN is a closed solid,
        // so gating on `r.rep` alone passes: the golden's 60 open edges were
        // structural, the run's 20 are a real defect, and comparing them says
        // "less torn" about two numbers that do not measure the same thing.
        // Because the relabel also routes this to `changed`, the loss would be
        // reported under a banner that opens "neither better nor worse".
        let g = HostRow { rep: "Tessellation".to_string(), ..row("a.ifc", 1, 60, 4000) };
        let r = HostRow { rep: "CSG".to_string(), ..row("a.ifc", 1, 20, 1200) };
        let d = diff(&[g], &[r], &swept(&["a.ifc"]));
        assert!(d.retessellated.is_empty(), "the golden was never a solid to repair");
        assert_eq!(d.regressed.len(), 1, "losing 70% of the mesh outranks the relabel");
        assert!(
            d.regressed[0].reasons.iter().any(|x| x.contains("geometry lost")),
            "and it must be NAMED as loss: {:?}",
            d.regressed[0].reasons
        );
    }

    #[test]
    fn a_solid_that_comes_back_an_open_shell_is_loss_not_re_tessellation() {
        // The RUN side of the same rule, and the half the two shell tests above
        // could not reach: in both of those the GOLDEN is the shell, so
        // `!g.is_torn_solid()` fires first and the run-side clause is never
        // reached. Here the golden is a real torn solid and the run is an open
        // shell, whose 12 boundary edges are structural rather than a repaired
        // 40.
        let g = HostRow { rep: "CSG".to_string(), ..row("a.ifc", 1, 40, 800) };
        let r = HostRow { rep: "Tessellation".to_string(), ..row("a.ifc", 1, 12, 600) };
        let d = diff(&[g], &[r], &swept(&["a.ifc"]));
        assert!(d.retessellated.is_empty(), "the run's open count is not a defect count");
        assert_eq!(d.regressed.len(), 1, "a solid that became a shell and shrank is loss");
        assert!(
            d.regressed[0].reasons.iter().any(|x| x.contains("geometry lost")),
            "and it must be NAMED as loss: {:?}",
            d.regressed[0].reasons
        );
    }

    #[test]
    fn a_shrink_across_a_far_field_flip_reports_the_count_as_an_artifact() {
        // `far` is TAGGED here, not gated. Gating it cost the bucket 11 of the
        // 20 mis-gated hosts on the #3219 run and reported 0 on the case it
        // exists for, while an open-edge RISE reds the build on a far host with
        // no gate at all. The count is noisy, not meaningless, so it rides in
        // with the noise named.
        //
        // The flip is also a reclassification, and that outranks the shrink, so
        // this lands in `changed` rather than `retessellated`. The reasons are
        // what carry the shrink, which is why they are asserted here.
        let r = HostRow { far: true, ..row("a.ifc", 1, 20, 1200) };
        let d = diff(&[row("a.ifc", 1, 60, 4000)], &[r], &swept(&["a.ifc"]));
        assert_eq!(d.changed.len(), 1, "the far flip is a reclassification");
        assert!(d.regressed.is_empty(), "a shrink with the tearing down is not loss");
        let reasons = &d.changed[0].reasons;
        assert!(
            reasons.iter().any(|x| x.contains("less torn")),
            "the shrink must be reported: {reasons:?}"
        );
        assert!(
            reasons.iter().any(|x| x.contains("f32 artifact")),
            "and the count's provenance with it, or a bless acts on noise: {reasons:?}"
        );
        assert_eq!(
            d.shrank_while_healing, 1,
            "and it is counted, whatever bucket won"
        );
    }

    #[test]
    fn a_cut_that_heals_the_host_completely_is_not_geometry_loss() {
        // The boundary the run side must NOT copy from `is_torn_solid`. That
        // predicate requires `open > 0`; a run whose open count fell to ZERO is
        // the ideal outcome, so reusing it wholesale on the run would file the
        // perfect repair as geometry loss.
        //
        // The verdict is RECLASSIFIED rather than the new bucket, and that is
        // forced by the data rather than chosen: taking `open` to 0 makes the
        // sweep record `pre = NotTaken` ("watertight, so the reading was never
        // taken"), while a torn golden necessarily carries a real reading. That
        // transition is a reclassification, and a reclassification outranks a
        // shrink. Codex caught the earlier version of this test asserting
        // `retessellated`, which no real pair can reach.
        //
        // What the test still discriminates is the thing that matters: gated on
        // `is_torn_solid` the run would be disqualified and read "geometry
        // lost"; gated on `open_is_comparable` it reads "less torn".
        let d = diff(&[row("a.ifc", 1, 40, 800)], &[row("a.ifc", 1, 0, 600)], &swept(&["a.ifc"]));
        assert!(d.regressed.is_empty(), "a fully healed host is not a regression");
        assert_eq!(d.changed.len(), 1, "the forced `pre` transition relabels it");
        let reasons = &d.changed[0].reasons;
        assert!(
            reasons.iter().any(|x| x.contains("less torn")),
            "and the repair must be reported, not called loss: {reasons:?}"
        );
        assert!(
            !reasons.iter().any(|x| x.contains("geometry lost")),
            "it is the perfect repair: {reasons:?}"
        );
        assert_eq!(d.shrank_while_healing, 1, "and counted, whatever bucket won");
    }

    #[test]
    fn a_shrink_and_heal_that_also_relabels_still_reports_the_shrink() {
        // The #3219 route, and the reason the `changed` assert was reworded to
        // say READ THE REASONS. A wall-cut change is exactly what flips
        // `SweptSolid <-> Clipping`, and 117 of the 126 eligible golden rows
        // are those two reps.
        //
        // The relabel outranks the shrink, so this host is filed under
        // RECLASSIFIED: it is NOT in the `retessellated` count and NOT named by
        // the RETESSELLATED print loop. The reason list is the only place the
        // shrink survives, which makes carrying it the whole promise rather
        // than a nicety.
        let g = HostRow { rep: "SweptSolid".to_string(), ..row("a.ifc", 1, 40, 800) };
        let r = HostRow { rep: "Clipping".to_string(), ..row("a.ifc", 1, 12, 600) };
        let d = diff(&[g], &[r], &swept(&["a.ifc"]));
        assert_eq!(d.changed.len(), 1, "the relabel decides the verdict");
        assert!(d.retessellated.is_empty(), "so it is NOT counted as one");
        let reasons = &d.changed[0].reasons;
        assert!(
            reasons.iter().any(|x| x.contains("less torn")),
            "the shrink must survive into the reasons, or it is reported nowhere: {reasons:?}"
        );
        assert!(
            reasons.iter().any(|x| x.contains("800 -> 600")),
            "with its numbers: {reasons:?}"
        );
        // And the open-edge line, which is what "less torn" is claiming. Pinned
        // per branch: deleting `c.better` from this concat reds this test and
        // the far-field one, which routes through `changed` too. It does NOT
        // red the other three branches' tests, which is the point.
        assert!(
            reasons.iter().any(|x| x.contains("open edges 40 -> 12")),
            "\"less torn\" is unverifiable without the open-edge numbers: {reasons:?}"
        );
    }

    #[test]
    fn a_no_void_flip_reports_the_counts_that_moved_with_it() {
        // #3366 (20a8efc81) put `pre` in `reclassifications`, so a no-void probe
        // starting or stopping to fail is a relabel and files under `changed`.
        // Before that it was the one route to `worse_gated` that was not also a
        // reclassification, which is what this test used to exercise.
        //
        // The property worth pinning survives the reroute: whatever bucket wins,
        // the counts that moved alongside the flip have to reach the reasons, or
        // the reviewer sees a relabel and no evidence of what the host did.
        let g = HostRow { pre: PreVoid::Failed, ..row("a.ifc", 1, 60, 800) };
        let r = HostRow { pre: PreVoid::Open(5), ..row("a.ifc", 1, 20, 800) };
        let d = diff(&[g], &[r], &swept(&["a.ifc"]));
        assert_eq!(d.changed.len(), 1, "a no-void flip is a reclassification");
        assert!(d.requires_bless(), "and it still has to be blessed");
        let reasons = &d.changed[0].reasons;
        assert!(
            reasons.iter().any(|x| x.contains("no-void pass")),
            "the flip itself must be named: {reasons:?}"
        );
        assert!(
            reasons.iter().any(|x| x.contains("open edges 60 -> 20")),
            "and the counts that moved with it: {reasons:?}"
        );
    }

    #[test]
    fn the_shrank_while_healing_tally_counts_hosts_the_bucket_does_not() {
        // The property the tally exists for: `retessellated` holds only the
        // hosts where nothing outranked the shrink, and both a relabel and a
        // worsening on another axis do. On a wall-cut change the relabel is the
        // likely companion, so without this the count for the class the bucket
        // is NAMED for reads 0 on the run it was built for.
        let relabelled = HostRow { rep: "Clipping".to_string(), ..row("a.ifc", 1, 12, 600) };
        // Worse on another axis, using DIVERGENCE rather than a collapse: a
        // collapse now disqualifies the re-tessellation outright, because a
        // degenerate triangle lowers `open` without repairing anything.
        let diverged = HostRow { alt: Some(999), ..row("b.ifc", 2, 12, 600) };
        let clean = row("c.ifc", 3, 12, 600);
        let golden = vec![
            HostRow { rep: "SweptSolid".to_string(), ..row("a.ifc", 1, 40, 800) },
            row("b.ifc", 2, 40, 800),
            row("c.ifc", 3, 40, 800),
        ];
        let d = diff(
            &golden,
            &[relabelled, diverged, clean],
            &swept(&["a.ifc", "b.ifc", "c.ifc"]),
        );
        assert_eq!(d.changed.len(), 1, "the relabelled host files under changed");
        assert_eq!(d.regressed.len(), 1, "the diverged one under regressed");
        assert_eq!(d.retessellated.len(), 1, "only the third reaches the bucket");
        assert_eq!(
            d.shrank_while_healing, 3,
            "but all three shrank while healing, and the tally must say so"
        );
    }

    #[test]
    fn a_shrink_whose_open_drop_could_be_collapse_is_loss_not_re_tessellation() {
        // `edge_stats` SKIPS degenerate triangles, so each one removes edges
        // from `open`: on a collapsed host a falling count can be collapse
        // rather than repair. `collapsed` is a BOOLEAN, so a host already at
        // `coll=1` going from 10 degenerate triangles to 200 moves no axis, and
        // nothing else here would notice. Folding this into
        // `open_is_comparable` took the eligible population from 158 to 126, so
        // it is a fifth of what the bucket would otherwise reach.
        let g = HostRow { collapsed: true, ..row("a.ifc", 1, 40, 800) };
        let r = HostRow { collapsed: true, ..row("a.ifc", 1, 12, 600) };
        let d = diff(&[g], &[r], &swept(&["a.ifc"]));
        assert!(d.retessellated.is_empty(), "the open drop may be collapse, not repair");
        assert_eq!(d.regressed.len(), 1, "so it stays geometry loss");
        let reasons = &d.regressed[0].reasons;
        assert!(
            reasons.iter().any(|x| x.contains("geometry lost")),
            "and it must be NAMED as loss: {reasons:?}"
        );
        // The narration has to agree with the verdict, exactly as in the
        // open-shell case. Routing was right here while the open-edge line
        // still read "(improved)" beside "(geometry lost)", because the note
        // caveated only `far` and the collapse disqualifier sat outside
        // `open_is_comparable`. Folding it in fixed both at once.
        assert!(
            !reasons.iter().any(|x| x.contains("(improved)")),
            "a collapse-depressed count is not an improvement: {reasons:?}"
        );
    }

    #[test]
    fn the_checked_in_golden_carries_exactly_the_generated_header() {
        // `HEADER` and the golden's comment block are two copies of the same
        // text, and the file is stamped "Generated, do not hand-edit", so the
        // only thing keeping them in step is remembering to edit both. This PR
        // had to, when the `tris:` legend stopped being true. Without this,
        // editing `HEADER` alone leaves the checked-in file describing the old
        // rule until someone runs the fixture-gated sweep, which is the only
        // other reader of that file.
        let golden = include_str!("../manifests/watertightness_census.tsv");
        assert!(
            golden.starts_with(HEADER),
            "the golden's header has drifted from HEADER; re-bless, or make the \
             two agree. Golden begins:\n{}",
            &golden[..HEADER.len().min(golden.len())]
        );
    }

    #[test]
    fn the_checked_in_golden_carries_a_strict_column_that_is_not_a_copy_of_open() {
        // The one property no synthetic row can carry: that the sweep actually
        // FEEDS `strict` the directed-pair reading. `strict: stats.open` in
        // `triangulation_invariance.rs` would leave every other test in this
        // module green, and it would leave the CENSUS green too — the golden is
        // a per-host CEILING, so a column that only ever falls files under
        // `improved` and requires no bless. What it cannot survive is a
        // re-bless: the dark column lands in this file, and this test reads it.
        //
        // Bounds rather than exact counts, so a real geometry fix never has to
        // edit this test. Zero on either tally is the failure: it means the
        // column has gone dark or is echoing `open`.
        let rows = parse(include_str!("../manifests/watertightness_census.tsv"))
            .expect("the checked-in golden must parse");
        assert!(rows.len() > 1000, "golden is under-populated: {} rows", rows.len());
        for r in &rows {
            assert!(
                r.strict >= r.open,
                "{} #{}: strict {} < open {} — `f != r` implies `(f, r) != (1, 1)`, so \
                 the walk cannot produce this row",
                r.model,
                r.id,
                r.strict,
                r.open
            );
        }
        assert!(
            rows.iter().any(|r| r.strict > r.open),
            "no golden row disagrees with the signed count, so the strict column is \
             either dark or a copy of `open`"
        );
        assert!(
            rows.iter().any(|r| r.open == 0 && r.strict > 0),
            "no golden row is watertight by the SIGNED balance and torn by the STRICT \
             rule — the population #3397 exists to measure has left the golden"
        );
    }

    #[test]
    fn a_torn_host_whose_mesh_vanishes_is_loss_however_much_the_tearing_improved() {
        // The input the `r.tris == 0` clause exists for, and the only one that
        // requires it: a TORN host whose mesh disappears. Open edges fall to
        // zero with it, so the shrink-and-heal discriminator would otherwise
        // route total loss into the friendly bucket and describe it as "fewer
        // triangles, less torn". Deleting that clause leaves every other test
        // in this module green EXCEPT the exhaustive sweep, which catches it on
        // the `detected` count rather than on the routing. This is the only test
        // that names the case, so without it the clause has no direct pin.
        let g = vec![row("a.ifc", 1, 40, 800)];
        let d = diff(&g, &[row("a.ifc", 1, 0, 0)], &swept(&["a.ifc"]));
        assert_eq!(d.regressed.len(), 1, "a vanished mesh is loss, not a healed cut");
        assert!(d.regressed[0].reasons.iter().any(|r| r.contains("geometry lost")));
        assert!(d.retessellated.is_empty());
    }

    #[test]
    fn fewer_triangles_without_less_tearing_is_still_geometry_lost() {
        // The guard on the guard. Triangles down while tearing holds or worsens
        // is the original defect and must keep its old verdict, otherwise the
        // new bucket becomes a laundering route for real loss.
        let g = vec![row("a.ifc", 1, 40, 800)];
        let same = diff(&g, &[row("a.ifc", 1, 40, 600)], &swept(&["a.ifc"]));
        assert_eq!(same.regressed.len(), 1, "open unchanged: still a loss");
        assert!(same.regressed[0].reasons[0].contains("geometry lost"));
        assert!(same.retessellated.is_empty());

        let worse = diff(&g, &[row("a.ifc", 1, 55, 600)], &swept(&["a.ifc"]));
        assert_eq!(worse.regressed.len(), 1, "open worse: still a loss");
        assert!(worse.retessellated.is_empty());
    }

    #[test]
    fn a_doubled_sheet_regresses_even_though_open_holds_and_triangles_grow() {
        // #3397 verbatim, and the reason the strict column is GATED rather than
        // merely reported. A face duplicated along with its opposite-wound twin
        // leaves the signed balance at 0 — one extra forward use and one extra
        // reverse use cancel — and GROWS `tris`, and a grown `tris` files under
        // `better`. So before this column the census filed the defect as an
        // improvement, `requires_bless()` read false, and the lane stayed green.
        let mut g = row("a.ifc", 1, 0, 12);
        g.strict = 0;
        let mut r = row("a.ifc", 1, 0, 14);
        r.strict = 3;

        let d = diff(std::slice::from_ref(&g), std::slice::from_ref(&r), &swept(&["a.ifc"]));
        assert_eq!(d.regressed.len(), 1, "a doubled coincident sheet must regress");
        assert!(d.improved.is_empty(), "and must not be filed as a triangle-count gain");
        let reasons = d.regressed[0].reasons.join("; ");
        assert!(reasons.contains("strict directed-pair edges 0 -> 3"), "{reasons}");
        // The triangle growth still has to be REPORTED, or the failure text
        // omits the evidence that the extra edges arrived with extra geometry.
        assert!(reasons.contains("triangles 12 -> 14"), "{reasons}");
        assert!(d.requires_bless());

        // Removing the duplicate is the mirror image, and must not read as a
        // regression. Held at the SAME triangle count as the golden so it is the
        // strict column deciding and not the `tris` shrink that accompanies a
        // real de-duplication.
        let mut fixed = row("a.ifc", 1, 0, 14);
        fixed.strict = 0;
        let back = diff(std::slice::from_ref(&r), &[fixed], &swept(&["a.ifc"]));
        assert!(back.regressed.is_empty(), "fewer strict violations is not a regression");
        assert_eq!(back.improved.len(), 1);
        assert!(back.improved[0].reasons.join("; ").contains("strict directed-pair edges 3 -> 0"));
    }

    #[test]
    fn a_shrink_that_heals_the_signed_count_while_doubling_a_sheet_is_a_regression() {
        // The interaction that decides where the strict arm belongs. This host
        // shrank AND its signed count fell, which is the re-tessellation shape
        // and would be filed under the friendly bucket — but its strict count
        // ROSE, so some of that repair is a duplicated sheet rather than a
        // closed tear. `open_is_comparable` documents that hazard as the reason
        // a falling `open` cannot be trusted on its own; putting the strict rise
        // in `worse_counts` is what makes the hazard gated, because a worsened
        // count outranks `retessellated` in the verdict chain.
        let mut g = row("a.ifc", 1, 40, 800);
        g.strict = 40;
        let mut r = row("a.ifc", 1, 12, 600);
        r.strict = 44;

        let d = diff(&[g], &[r], &swept(&["a.ifc"]));
        assert!(d.retessellated.is_empty(), "a doubled sheet is not a re-tessellation");
        assert_eq!(d.regressed.len(), 1, "the strict rise outranks the friendly reading");
        let reasons = d.regressed[0].reasons.join("; ");
        assert!(reasons.contains("strict directed-pair edges 40 -> 44"), "{reasons}");
        // The signed fall still rides along, because it is what a reviewer would
        // otherwise have called a repair, and the two numbers together are the
        // whole argument for carrying both columns.
        assert!(reasons.contains("open edges 40 -> 12"), "{reasons}");
    }

    #[test]
    fn a_falling_strict_count_is_qualified_wherever_a_falling_open_count_is() {
        // Both arms read `fall_note`, so a strict fall on a host the gate just
        // called geometry loss must not print an unqualified "(improved)" next
        // to "(geometry lost)". Splitting the note into two copies is exactly
        // how that contradiction reappears, and the open-shell test above would
        // stay green while it did, because it only ever inspects `open`.
        let shell = |open, strict, tris| HostRow {
            rep: "Tessellation".to_string(),
            strict,
            ..row("a.ifc", 1, open, tris)
        };
        let d = diff(&[shell(60, 66, 4000)], &[shell(20, 22, 1200)], &swept(&["a.ifc"]));
        assert_eq!(d.regressed.len(), 1);
        let reasons = &d.regressed[0].reasons;
        assert!(
            reasons.iter().any(|x| x.contains("strict directed-pair edges 66 -> 22")),
            "the strict fall must be reported: {reasons:?}"
        );
        assert!(
            !reasons.iter().any(|x| x.contains("(improved)")),
            "and qualified like the signed one, not called an improvement: {reasons:?}"
        );
    }

    #[test]
    fn retessellation_never_masks_a_worse_verdict_on_another_axis() {
        // A host can shrink, get less torn, AND newly diverge under the
        // alternate triangulator. The worse axis has to win, or the new bucket
        // would quietly absorb regressions that arrive alongside an improvement.
        //
        // DIVERGENCE rather than a collapse, because `r.collapsed` now
        // disqualifies the re-tessellation outright: a collapsed host would test
        // that clause over again instead of the masking this test is named for.
        let g = vec![row("a.ifc", 1, 40, 800)];
        let r = HostRow { alt: Some(999), ..row("a.ifc", 1, 12, 600) };
        let d = diff(&g, &[r], &swept(&["a.ifc"]));
        assert_eq!(d.regressed.len(), 1, "a new divergence outranks the shrink");
        assert!(d.retessellated.is_empty());
        // And the shrink must still be REPORTED. Asserting only the verdict left
        // this blind to the reason silently vanishing from the failure text.
        let reasons = &d.regressed[0].reasons;
        assert!(
            reasons.iter().any(|r| r.contains("800 -> 600")),
            "the shrink must survive into the reasons: {reasons:?}"
        );
        // And the numbers behind it. The shrink reason SAYS "less torn"; the
        // open-edge line is the only thing in the output that lets a reviewer
        // check that claim, so carrying `better` into the failing branches is
        // load-bearing rather than decorative.
        assert!(
            reasons.iter().any(|r| r.contains("open edges 40 -> 12")),
            "\"less torn\" is unverifiable without the open-edge numbers: {reasons:?}"
        );
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
    fn a_no_void_pass_flipping_either_way_is_a_reclassification() {
        // #3366: the other input to `is_torn_solid` that moves on its own. With
        // `pre` Failed the host is excluded from the genuine-defect count; once
        // that pass succeeds it joins, and `open`, `tris`, `collapsed` and `alt`
        // are all unmoved. `pre` is carried in `reclassifications` for the same
        // reason `rep` and `far` are: this is a change of question, not a
        // measured degradation or improvement, so it must require a bless
        // either way rather than silently filing one direction as green.
        let mut g = row("a.ifc", 1, 4, 100);
        g.rep = "CSG".to_string();
        g.pre = PreVoid::Failed;
        assert!(!g.is_torn_solid());
        let mut r = g.clone();
        r.pre = PreVoid::Open(0);
        assert!(r.is_torn_solid());

        let d = diff(&[g.clone()], &[r.clone()], &swept(&["a.ifc"]));
        assert!(d.regressed.is_empty(), "a pure no-void relabel is not a geometry regression");
        assert!(d.improved.is_empty());
        assert_eq!(d.changed.len(), 1, "joining the gated defect set by relabel must be acknowledged");
        let reasons = d.changed[0].reasons.join("; ");
        assert!(reasons.contains("no-void pass x -> 0"), "{reasons}");
        assert!(reasons.contains("genuine watertightness defect"), "{reasons}");
        assert!(d.requires_bless());

        // And the reverse direction — a probe going DARK — must also require a
        // bless, not read as an improvement. This is the shape #3366 reports:
        // before the fix this arm filed under `improved` with `requires_bless()
        // == false`, so the lane stayed green while a host silently left the
        // genuine-defect count.
        let back = diff(&[r], &[g], &swept(&["a.ifc"]));
        assert!(back.regressed.is_empty());
        assert!(back.improved.is_empty(), "a probe going dark must not read as an improvement");
        assert_eq!(back.changed.len(), 1);
        assert!(back.requires_bless(), "a probe going dark must not leave the lane green");
    }

    #[test]
    fn a_probe_that_starts_failing_is_a_reclassification_not_an_improvement() {
        // #3366: `process_no_voids` going dark for a host flips `pre`
        // `Open(n) -> Failed` while `open`, `tris`, `collapsed` and `alt` all
        // hold. `is_torn_solid` reads `pre`, so the host leaves the gated
        // defect population with nothing else having moved. Filing that as
        // `improved` costs the census the one thing `pre` exists to provide:
        // telling "arrived torn" apart from "the boolean tore it". It must
        // require a bless like every other population change, not read green.
        let mut g = row("a.ifc", 1, 4, 100);
        g.rep = "CSG".to_string();
        g.pre = PreVoid::Open(0);
        assert!(g.is_torn_solid());
        let mut r = g.clone();
        r.pre = PreVoid::Failed;
        assert!(!r.is_torn_solid());

        let d = diff(&[g], &[r], &swept(&["a.ifc"]));
        assert!(d.improved.is_empty(), "a dark no-void probe must not read as an improvement");
        assert!(d.requires_bless(), "a probe going dark must not leave the lane green");

        // Break the symmetry: the OTHER direction (probe starts running) must
        // also require a bless, so the fix cannot special-case one arm.
        let mut g2 = row("a.ifc", 1, 4, 100);
        g2.rep = "CSG".to_string();
        g2.pre = PreVoid::Failed;
        assert!(!g2.is_torn_solid());
        let mut r2 = g2.clone();
        r2.pre = PreVoid::Open(0);
        assert!(r2.is_torn_solid());
        let d2 = diff(&[g2], &[r2], &swept(&["a.ifc"]));
        assert!(d2.requires_bless(), "a probe starting to run must also require a bless");
    }

    /// Every `HostRow` shape that matters, for the exhaustive invariant below.
    fn variants() -> Vec<HostRow> {
        let mut out = Vec::new();
        for rep in ["CSG", "SurfaceModel"] {
            for open in [0usize, 3] {
                // `open` itself (nothing doubled) and one value ABOVE it (a
                // doubled sheet). Never below: `strict >= open` by
                // construction, so a lower value is a row no sweep can emit.
                // Two values are enough — the cross product pairs them both
                // ways, so it already builds a rise with `open` unmoved, which
                // is the #3397 shape, and its mirror.
                for strict in [open, open + 2] {
                    for tris in [0usize, 3, 5] {
                        for collapsed in [false, true] {
                            for far in [false, true] {
                                for alt in [None, Some(0usize), Some(3), Some(9)] {
                                    for pre in [
                                        PreVoid::NotTaken,
                                        PreVoid::Failed,
                                        PreVoid::Open(0),
                                        PreVoid::Open(2),
                                    ] {
                                        out.push(HostRow {
                                            model: "a.ifc".to_string(),
                                            id: 1,
                                            rep: rep.to_string(),
                                            open,
                                            strict,
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
        //
        // `tris` carries three values so the sweep can build a shrink at all:
        // with `[0, 5]` the only one available is `5 -> 0`, which the
        // `r.tris == 0` clause always routes back to `worse_counts`.
        //
        // `strict` carries two values per `open` — the count itself and one
        // above it — so the sweep can build the #3397 shape: a doubled sheet is
        // `strict` rising while `open` holds. Never below `open`, which is a row
        // the walk cannot emit.
        //
        // Two different counts, because saying "re-tessellation pairs" without
        // saying which one is how this got misread: over the 1536 x 1536 sweep,
        // 2304 pairs are DETECTED as a re-tessellation and 312 of those LAND in
        // the bucket. The gap is the population `shrank_while_healing` exists to
        // surface, and it is most of the class.
        //
        // Both are ASSERTED below rather than left in prose, which has paid for
        // itself five times now. The pair was 576/351 until a collapse
        // disqualified the bucket, 288/234 until `far` stopped being gated,
        // 1152/468 until #3366 made a no-void flip a reclassification,
        // 1152/156 until `collapsed` moved into `open_is_comparable` and so
        // began disqualifying the GOLDEN side too, and 576/78 until #3397
        // doubled the variant set. Every drift was caught by the assertion on
        // the commit that caused it, not by a reader later.
        //
        // BOTH scaled by exactly 4 at #3397, which is a property worth naming
        // rather than a coincidence. `shrank_while_healing` never reads
        // `strict`, so every old pair replicates into four. And a LANDING pair
        // needs `r.open < g.open`, which over `open` in `[0, 3]` forces
        // `g.open = 3, r.open = 0`; every strict combination that follows is a
        // FALL, so the new arm cannot evict a landing. `checked` is the count
        // that did not scale: 11232 x 4 would be 44928, and the 7488 missing
        // pairs are the equal-`open` ones whose `strict` rose, which now need a
        // bless. That is the arm doing its job inside this very sweep.
        //
        // Be precise about what that buys HERE. The DERIVED-TOTAL invariant
        // below never sees these pairs: they all hit the `requires_bless` skip,
        // and `totals()` never reads `tris` anyway, so the routing is pinned by
        // the named unit tests rather than by that invariant.
        //
        // The exact counts asserted at the end of this test are a different
        // matter and DO pin it. Reverting to `[0, 5]` reds this test on the
        // swept-pair count, and deleting the `retessellated` routing branch reds
        // it on `detected`. An earlier version of this comment said both left
        // the test green, which was true when it was written and stopped being
        // true a few lines later in the same commit.
        //
        // What it adds to the CHECKED population is NOT what the obvious reading
        // suggests: growth pairs already existed at `[0, 5]` via `0 -> 5`, and
        // no shrink is ever checked, because every shrink requires a bless. The
        // additions are further growth pairs and equal-`tris` pairs. The exact
        // count is asserted below rather than described here.
        let vs = variants();
        let all = swept(&["a.ifc"]);
        let mut checked = 0usize;
        let (mut detected, mut landed) = (0usize, 0usize);
        for g in &vs {
            for r in &vs {
                let d = diff(std::slice::from_ref(g), std::slice::from_ref(r), &all);
                // Tallied ABOVE the skip, or the two figures quoted in the
                // comment would be unobservable from the one test able to
                // compute them, and could go false with nothing failing.
                detected += d.shrank_while_healing;
                landed += d.retessellated.len();
                if d.requires_bless() {
                    continue;
                }
                checked += 1;
                let (want, got) = (totals([g]), totals([r]));
                assert!(got.open_edges <= want.open_edges, "open edges: {g:?} -> {r:?}");
                assert!(got.strict_edges <= want.strict_edges, "strict edges: {g:?} -> {r:?}");
                assert!(got.torn <= want.torn, "torn: {g:?} -> {r:?}");
                assert!(got.collapsed <= want.collapsed, "collapsed: {g:?} -> {r:?}");
                assert!(got.torn_solid <= want.torn_solid, "torn solid: {g:?} -> {r:?}");
                assert!(got.non_invariant <= want.non_invariant, "non-invariant: {g:?} -> {r:?}");
                assert_eq!(got.hosts, want.hosts);
            }
        }
        // Guard against the loop vacuously skipping everything.
        assert!(checked > vs.len(), "only {checked} clean pairs of {}", vs.len() * vs.len());
        assert_eq!(checked, 37440, "clean pairs swept");
        // The two counts the comment above quotes, asserted rather than
        // recorded. The gap between them is the whole reason
        // `shrank_while_healing` exists, so it must not drift unnoticed.
        assert_eq!(detected, 2304, "pairs DETECTED as a re-tessellation");
        assert_eq!(landed, 312, "pairs that LAND in the retessellated bucket");
    }

    #[test]
    fn the_gated_flip_is_never_the_deciding_signal_and_is_always_reported() {
        // #3396. `is_torn_solid` is DERIVED: it reads exactly `open`, `rep`,
        // `far` and `pre`. `open` moving is a directional count and the other
        // three are `reclassifications` entries (#3366), so a host entering the
        // gated defect population ALWAYS carries a more specific signal than
        // the flip itself. That is the theorem that made the old
        // `worse_gated`-only branch of the diff chain unreachable, and this
        // test is what keeps it true.
        //
        // If you add an input to `is_torn_solid`, this test reds unless that
        // input is also carried by a directional count or by
        // `reclassifications`. That is the point, not an accident: an input
        // carried by neither can flip the gated population with the chain
        // routing the pair to `improved` — green — which is the coverage-loss
        // failure this module's header calls the worst of the three cases.
        let vs = variants();
        let all = swept(&["a.ifc"]);
        let (mut worsened, mut improved_flips) = (0usize, 0usize);
        for g in &vs {
            for r in &vs {
                if r.is_torn_solid() == g.is_torn_solid() {
                    continue;
                }
                let c = classify(g, r);
                let reclassified = reclassifications(g, r);
                let d = diff(std::slice::from_ref(g), std::slice::from_ref(r), &all);
                if r.is_torn_solid() {
                    worsened += 1;
                    assert!(
                        !c.worse_counts.is_empty() || !reclassified.is_empty(),
                        "joining the gated defect set with no worsened count and no \
                         reclassification: {g:?} -> {r:?}"
                    );
                    // So it is routed by one of those, never by the flip, and
                    // both of those buckets are red.
                    assert_eq!(
                        d.regressed.len() + d.changed.len(),
                        1,
                        "a gated flip must file as regressed or changed: {g:?} -> {r:?}"
                    );
                    // Neither of the two arms below the reclassification, in
                    // particular: a flip that reached `retessellated` would be
                    // described as "fewer triangles, less torn" on a host that
                    // just entered the defect population.
                    assert!(d.retessellated.is_empty(), "{g:?} -> {r:?}");
                    assert!(d.improved.is_empty(), "{g:?} -> {r:?}");
                    assert!(d.requires_bless(), "{g:?} -> {r:?}");
                    // And the flip is still SAID, wherever it was routed. Asked
                    // per REASON, not against the concatenation, so the needle
                    // has to sit inside one reason rather than being spliced
                    // out of two.
                    let reasons: Vec<&String> =
                        d.regressed.iter().chain(&d.changed).flat_map(|x| &x.reasons).collect();
                    assert!(
                        reasons.iter().any(|x| x.contains("genuine watertightness defect")),
                        "gated flip not reported: {g:?} -> {r:?}: {reasons:?}"
                    );
                } else {
                    improved_flips += 1;
                    // The mirror: LEAVING the gated set silently is only allowed
                    // when the open count genuinely fell. Anything else is a
                    // reclassification, which is red (#3366).
                    assert!(
                        r.open < g.open || !reclassified.is_empty(),
                        "leaving the gated defect set with no count improvement and no \
                         reclassification: {g:?} -> {r:?}"
                    );
                }
            }
        }
        // Guard against a vacuous sweep: both directions must actually occur.
        assert!(worsened > 0 && improved_flips > 0, "{worsened} / {improved_flips} flips");
    }

    #[test]
    fn every_arm_of_the_diff_chain_is_reachable() {
        // This chain carried a dead arm — `worse_gated` alone, unreachable
        // since #3366, removed by #3396 — and nothing noticed, because a
        // verdict no input happens to produce looks exactly like one that
        // cannot be produced. This is the check that tells them apart.
        //
        // It asserts the routing arm-by-arm as well as tallying the buckets, so
        // "the bucket was reached" means "that arm was taken" and a reordering
        // of the chain reds here rather than quietly re-labelling verdicts.
        //
        // The clause order below is the CHAIN's order, not a convenient one:
        // `retessellated` sits between the reclassification and the improvement
        // because that is where `diff` tests it, and swapping the two here would
        // make the test agree with a chain that routes a shrink-and-heal to
        // `improved`.
        let vs = variants();
        let all = swept(&["a.ifc"]);
        let (mut regressed, mut changed, mut retessellated, mut improved, mut unchanged) =
            (0usize, 0, 0, 0, 0);
        for g in &vs {
            for r in &vs {
                let c = classify(g, r);
                let reclassified = reclassifications(g, r);
                let d = diff(std::slice::from_ref(g), std::slice::from_ref(r), &all);
                let got =
                    (d.regressed.len(), d.changed.len(), d.retessellated.len(), d.improved.len());
                assert!(d.added.is_empty() && d.missing.is_empty(), "{g:?} -> {r:?}");
                if !c.worse_counts.is_empty() {
                    assert_eq!(got, (1, 0, 0, 0), "a worsened count must regress: {g:?} -> {r:?}");
                    regressed += 1;
                } else if !reclassified.is_empty() {
                    assert_eq!(got, (0, 1, 0, 0), "a reclassification must change: {g:?} -> {r:?}");
                    changed += 1;
                } else if !c.retessellated.is_empty() {
                    assert_eq!(
                        got,
                        (0, 0, 1, 0),
                        "a shrink that healed must re-tessellate: {g:?} -> {r:?}"
                    );
                    retessellated += 1;
                } else if !c.better.is_empty() {
                    assert_eq!(got, (0, 0, 0, 1), "an improvement must improve: {g:?} -> {r:?}");
                    improved += 1;
                } else {
                    // Deleting the gated arm made this `else` a SILENT DROP for
                    // one shape the chain can no longer name: a pair whose only
                    // non-empty list is `worse_gated` matches no arm, so it
                    // lands in no bucket, `requires_bless` sees an empty diff,
                    // and the host vanishes from the census with the lane green.
                    // The comment on the chain proves that shape is unreachable
                    // today. This asserts it, so the proof is enforced rather
                    // than merely written down.
                    //
                    // It reds for a NARROWER class than the sibling test above,
                    // because this arm is only reached once every other list is
                    // empty too: a fifth input to `is_torn_solid` trips it only
                    // when it is carried by NEITHER a directional count NOR
                    // `reclassifications`. Dropping the `pre` clause from
                    // `reclassifications`, i.e. reverting #3366, is that case,
                    // and it reds here. Adding `&& !self.collapsed` to the
                    // predicate is not: `collapsed` is already carried as a
                    // directional count by `classify`, so such a pair routes to
                    // `worse_counts` or `better` and only the sibling test
                    // reds. Both directions measured.
                    assert!(
                        c.worse_gated.is_empty(),
                        "a gated flip with nothing else moving would land in NO bucket: {g:?} -> {r:?}"
                    );
                    assert_eq!(got, (0, 0, 0, 0), "an identical pair moves nothing: {g:?} -> {r:?}");
                    unchanged += 1;
                }
            }
        }
        assert!(regressed > 0, "no pair reaches the regressed arm");
        assert!(changed > 0, "no pair reaches the changed arm");
        assert!(retessellated > 0, "no pair reaches the retessellated arm");
        assert!(improved > 0, "no pair reaches the improved arm");
        assert!(unchanged > 0, "no pair leaves the chain without a delta");

        // The two remaining arms are keyed on key PRESENCE, not on movement, so
        // the same-key cross-product above cannot reach them. One pair does.
        let d = diff(&[row("a.ifc", 1, 0, 10)], &[row("a.ifc", 2, 0, 10)], &all);
        assert_eq!(d.added.len(), 1, "no pair reaches the added arm");
        assert_eq!(d.missing.len(), 1, "no pair reaches the missing arm");
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
                strict: 9,
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
                // Watertight by the signed balance and torn by the strict rule:
                // the row shape #3397 exists to make representable, so the
                // serializer is pinned on it rather than only on `strict ==
                // open`.
                strict: 4,
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
        let header = "model\tid\trep\topen\ttris\tcoll\tfar\talt\tpre\tstrict\n";
        let err = parse(&format!("{header}a.ifc\t1\tCSG\t0\t0\t0\t0\n"))
            .expect_err("a 7-column row must not parse");
        assert!(err.contains("expected 10 columns"), "{err}");

        // And a COMPLETE pre-#3397 row is a truncation too, not a row with an
        // implied strict count. Defaulting it would fabricate a clean-looking
        // host for every line of a stale golden, which is the one way this
        // column could go dark across the whole corpus at once.
        let old = parse(&format!("{header}a.ifc\t1\tCSG\t0\t12\t0\t0\t0\t-\n"))
            .expect_err("a 9-column pre-#3397 row must not parse");
        assert!(old.contains("expected 10 columns"), "{old}");
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
