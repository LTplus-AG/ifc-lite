// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Cycle and fan-out guards for `extract_symbolic_item` (issue #2866).
//!
//! This walk is reachable from `extract_symbolic_data` on raw uploaded bytes
//! (`apps/server/src/services/streaming.rs`), and every id it follows comes
//! from the file. Unbounded, each of the three cycle edges below aborts the
//! process with a stack overflow — an abort, not a catchable panic.
//!
//! Every test asserts the SAFE RESULT rather than "does not crash": a stack
//! overflow takes the whole test binary down as SIGABRT, which reads as broken
//! infrastructure instead of a failed assertion.

use super::item_walk::{
    extract_symbolic_item, extract_symbolic_item_with_revisit_budget, MAX_ITEM_DEPTH,
    MAX_ITEM_REVISITS,
};
use super::primitives::SymbolicData;
use super::transform::Transform2D;
use ifc_lite_core::{build_entity_index, EntityDecoder};
use std::collections::HashMap;

fn run(step: &str, start_id: u32) -> SymbolicData {
    let content = step.as_bytes();
    let index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, index);
    let item = decoder.decode_by_id(start_id).expect("fixture entity decodes");
    let styled: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut out = SymbolicData::default();
    extract_symbolic_item(
        &item,
        &mut decoder,
        1,
        "IfcAnnotation",
        "Annotation",
        1.0,
        &Transform2D::identity(),
        0.0,
        0.0,
        &styled,
        &mut out,
    );
    out
}

fn run_with_budget(step: &str, start_id: u32, budget: u32) -> SymbolicData {
    let content = step.as_bytes();
    let index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, index);
    let item = decoder.decode_by_id(start_id).expect("fixture entity decodes");
    let styled: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut out = SymbolicData::default();
    extract_symbolic_item_with_revisit_budget(
        &item,
        &mut decoder,
        1,
        "IfcAnnotation",
        "Annotation",
        1.0,
        &Transform2D::identity(),
        0.0,
        0.0,
        &styled,
        &mut out,
        budget,
    );
    out
}

/// Run the walk in a worker thread with a timeout, so a regressed guard is
/// observed as a TIMEOUT rather than hanging the suite. Necessary because the
/// breadth budget's failure mode is a hang, not an abort: a stack overflow
/// takes the process down whatever thread it is on, but an unbounded fan-out
/// just spins, and an elapsed-time assertion inside the call can never fire
/// because the call never returns. Same harness as
/// `geometry/src/processors/boolean/chain_cycle_tests.rs`.
fn run_with_timeout(step: String, start_id: u32, secs: u64) -> SymbolicData {
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = std::thread::spawn(move || {
        let _ = tx.send(run(&step, start_id));
    });
    let outcome = rx.recv_timeout(std::time::Duration::from_secs(secs));
    assert!(
        outcome.is_ok(),
        "extract_symbolic_item did not terminate within {secs}s -- the breadth bound \
         (MAX_ITEM_REVISITS) is gone; a depth cap and a path guard alone allow k! paths"
    );
    let _ = handle.join();
    outcome.unwrap()
}

fn wrap(body: &str) -> String {
    format!("ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n{body}ENDSEC;\nEND-ISO-10303-21;\n")
}

/// Cycle edge 1: IfcGeometricCurveSet.Elements pointing back at itself.
#[test]
fn cyclic_geometric_curve_set_terminates() {
    let out = run(&wrap("#10=IFCGEOMETRICCURVESET((#10));\n"), 10);
    assert!(out.polylines.is_empty(), "a self-referential set must emit nothing, not recurse forever");
}

/// Cycle edge 2: the IfcMappedItem chain (same shape as #2863).
#[test]
fn cyclic_mapped_item_terminates() {
    let out = run(
        &wrap("#30=IFCMAPPEDITEM(#40,$);\n#40=IFCREPRESENTATIONMAP($,#50);\n#50=IFCSHAPEREPRESENTATION($,$,$,(#30));\n"),
        30,
    );
    assert!(out.polylines.is_empty(), "a cyclic representation map must emit nothing");
}

/// Cycle edge 3: IfcCompositeCurve.Segments -> ParentCurve back to the curve.
#[test]
fn cyclic_composite_curve_terminates() {
    let out = run(
        &wrap("#60=IFCCOMPOSITECURVE((#61),.F.);\n#61=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#60);\n"),
        60,
    );
    assert!(out.polylines.is_empty(), "a self-referential composite curve must emit nothing");
}

/// A depth cap bounds a path's LENGTH, not its BREADTH. `k` items that each
/// lead back into the cycle cost O(k^depth) with a cap alone — measured at
/// 7.21s for k=3 on the sibling resolver in #2864 before its guard landed.
/// This must stay flat in `k`, not exponential.
#[test]
fn fanout_cycle_does_not_blow_up() {
    for k in [1usize, 2, 4, 8, 16] {
        let mut lines = String::new();
        let mut items = String::new();
        for i in 0..k {
            let id = 100 + i;
            if i > 0 {
                items.push(',');
            }
            items.push_str(&format!("#{id}"));
            lines.push_str(&format!("#{id}=IFCMAPPEDITEM(#40,$);\n"));
        }
        lines.push_str("#40=IFCREPRESENTATIONMAP($,#50);\n");
        lines.push_str(&format!("#50=IFCSHAPEREPRESENTATION($,$,$,({items}));\n"));

        let out = run_with_timeout(wrap(&lines), 100, 20);
        assert!(out.polylines.is_empty(), "k={k}: a fan-out cycle must emit nothing");
    }
}

/// The path guard must NOT be global. This walk accumulates output and
/// composes a transform per path, so the same polyline reached through two
/// different mapped items is two real pieces of geometry at two positions.
/// A global visited set would emit only the first — missing geometry.
#[test]
fn the_same_polyline_under_two_mapped_items_is_emitted_twice() {
    let body = "#10=IFCGEOMETRICCURVESET((#20,#21));\n\
        #20=IFCMAPPEDITEM(#30,$);\n\
        #21=IFCMAPPEDITEM(#31,$);\n\
        #30=IFCREPRESENTATIONMAP($,#40);\n\
        #31=IFCREPRESENTATIONMAP($,#40);\n\
        #40=IFCSHAPEREPRESENTATION($,$,$,(#50));\n\
        #50=IFCPOLYLINE((#60,#61));\n\
        #60=IFCCARTESIANPOINT((0.,0.));\n\
        #61=IFCCARTESIANPOINT((1.,1.));\n";
    let out = run(&wrap(body), 10);
    assert_eq!(
        out.polylines.len(),
        2,
        "a shared polyline reached through two mapped items must be emitted twice; \
         a GLOBAL visited set would drop the second and silently lose geometry"
    );
}

/// The depth cap must actually bound a long non-cyclic chain.
#[test]
fn depth_cap_stops_a_chain_longer_than_the_cap() {
    let hops = 60usize;
    let mut lines = String::new();
    for i in 0..hops {
        let item = 100 + i * 3;
        let map = item + 1;
        let repr = item + 2;
        let next = if i + 1 < hops { 100 + (i + 1) * 3 } else { 9000 };
        lines.push_str(&format!("#{item}=IFCMAPPEDITEM(#{map},$);\n"));
        lines.push_str(&format!("#{map}=IFCREPRESENTATIONMAP($,#{repr});\n"));
        lines.push_str(&format!("#{repr}=IFCSHAPEREPRESENTATION($,$,$,(#{next}));\n"));
    }
    lines.push_str("#9000=IFCPOLYLINE((#9001,#9002));\n#9001=IFCCARTESIANPOINT((0.,0.));\n#9002=IFCCARTESIANPOINT((1.,1.));\n");
    let out = run(&wrap(&lines), 100);
    assert!(
        out.polylines.is_empty(),
        "a 60-hop chain must be cut off by MAX_ITEM_DEPTH=32 before reaching its leaf"
    );
}

/// Geometry emitted TWICE: two mapped items sharing one representation, so the
/// polyline inside it is reached once on a first visit and once on a REVISIT.
/// Both starvation tests assert on the revisit, because only revisits are
/// charged -- an assertion on a first visit cannot be starved and pins nothing.
const SHARED_TWICE: &str = "#70=IFCMAPPEDITEM(#72,$);\n\
     #71=IFCMAPPEDITEM(#72,$);\n\
     #72=IFCREPRESENTATIONMAP($,#73);\n\
     #73=IFCSHAPEREPRESENTATION($,$,$,(#50));\n\
     #50=IFCPOLYLINE((#60,#61));\n\
     #60=IFCCARTESIANPOINT((0.,0.));\n\
     #61=IFCCARTESIANPOINT((1.,1.));\n";

/// The path guard is not redundant with the depth cap, and this is the damage
/// it prevents rather than the mechanism it uses.
///
/// The cap alone terminates a cycle, so every test above still passes without
/// the guard. But a cycle re-entered under the cap burns `MAX_ITEM_REVISITS`
/// before it stops, and the budget is shared by the whole extraction — so the
/// legitimate geometry that follows the cycle in the same representation is
/// silently dropped. Cheap termination is the point: the guard returns on the
/// second visit instead of spending the budget getting there.
#[test]
fn a_cycle_must_not_starve_the_geometry_that_follows_it() {
    // The geometry after the cycle must be reached by a REVISIT, because only
    // revisits are charged. An earlier version of this test asserted on a
    // polyline reached by a FIRST visit, which is never charged -- so it
    // passed even with the budget set to zero and pinned nothing.
    //
    // #70 and #71 are two mapped items sharing one representation, so the
    // polyline inside it is emitted twice: once on the first visit, once on a
    // revisit. The 8-way self-referential cycle in #20 must not consume the
    // budget that second emission needs.
    let cycle = "#20=IFCMAPPEDITEM(#30,$);\n        #30=IFCREPRESENTATIONMAP($,#40);\n        #40=IFCSHAPEREPRESENTATION($,$,$,(#21,#22,#23,#24,#25,#26,#27,#28));\n        #21=IFCMAPPEDITEM(#30,$);\n#22=IFCMAPPEDITEM(#30,$);\n        #23=IFCMAPPEDITEM(#30,$);\n#24=IFCMAPPEDITEM(#30,$);\n        #25=IFCMAPPEDITEM(#30,$);\n#26=IFCMAPPEDITEM(#30,$);\n        #27=IFCMAPPEDITEM(#30,$);\n#28=IFCMAPPEDITEM(#30,$);\n";

    // Control: the same shared geometry with NO cycle ahead of it emits twice.
    let control = format!("#10=IFCGEOMETRICCURVESET((#70,#71));\n{SHARED_TWICE}");
    let baseline = run(&wrap(&control), 10);
    assert_eq!(
        baseline.polylines.len(),
        2,
        "control: a representation shared by two mapped items emits twice"
    );

    // Same file with the cycle in front of it must still emit twice.
    let with_cycle = format!("#10=IFCGEOMETRICCURVESET((#20,#70,#71));\n{cycle}{SHARED_TWICE}");
    let out = run_with_timeout(wrap(&with_cycle), 10, 60);
    assert_eq!(
        out.polylines.len(),
        2,
        "a cycle must not consume the budget that legitimate shared geometry \
         after it needs; got {} polylines instead of 2",
        out.polylines.len()
    );
}

/// The same starvation, on the route the REPRESENTATION guard does not cover.
///
/// `IfcGeometricCurveSet.Elements` closes its cycle through items alone, with
/// no mapped item and no representation, so only the item path guard can cut
/// it. Without that guard the 8-way self-reference is merely bounded by the
/// depth cap and pays a revisit charge at every level, draining the budget the
/// shared geometry after it needs. This is the test whose absence let the item
/// path guard be deleted with the whole file still green.
#[test]
fn a_set_cycle_must_not_starve_the_geometry_that_follows_it() {
    let cycle = "#20=IFCGEOMETRICCURVESET((#21,#22,#23,#24,#25,#26,#27,#28));\n        #21=IFCGEOMETRICCURVESET((#20));\n#22=IFCGEOMETRICCURVESET((#20));\n        #23=IFCGEOMETRICCURVESET((#20));\n#24=IFCGEOMETRICCURVESET((#20));\n        #25=IFCGEOMETRICCURVESET((#20));\n#26=IFCGEOMETRICCURVESET((#20));\n        #27=IFCGEOMETRICCURVESET((#20));\n#28=IFCGEOMETRICCURVESET((#20));\n";

    let body = format!("#10=IFCGEOMETRICCURVESET((#20,#70,#71));\n{cycle}{SHARED_TWICE}");
    let out = run_with_timeout(wrap(&body), 10, 60);
    assert_eq!(
        out.polylines.len(),
        2,
        "a set cycle must not consume the budget the shared geometry after it \
         needs; got {} polylines instead of 2",
        out.polylines.len()
    );
}

/// A long ACYCLIC chain: every id distinct, so a visited set never fires.
/// This is the input a set alone cannot stop — one stack frame per
/// file-supplied entity. Only a chain-length bound catches it.
#[test]
fn a_long_acyclic_chain_does_not_abort() {
    let hops = 200_000usize;
    let mut lines = String::with_capacity(hops * 40);
    for i in 0..hops {
        let item = 100 + i * 3;
        let map = item + 1;
        let repr = item + 2;
        let next = if i + 1 < hops { 100 + (i + 1) * 3 } else { 90_000_000 };
        lines.push_str(&format!("#{item}=IFCMAPPEDITEM(#{map},$);\n"));
        lines.push_str(&format!("#{map}=IFCREPRESENTATIONMAP($,#{repr});\n"));
        lines.push_str(&format!("#{repr}=IFCSHAPEREPRESENTATION($,$,$,(#{next}));\n"));
    }
    lines.push_str("#90000000=IFCPOLYLINE((#90000001,#90000002));\n#90000001=IFCCARTESIANPOINT((0.,0.));\n#90000002=IFCCARTESIANPOINT((1.,1.));\n");
    let out = run_with_timeout(wrap(&lines), 100, 60);
    assert!(
        out.polylines.is_empty(),
        "a 200k-hop acyclic chain must be cut off by MAX_ITEM_DEPTH, not walked"
    );
}

/// The P2 interaction Codex found on the colour resolvers: a GLOBAL visited
/// set combined with a depth cap can lose a legitimate result. An item first
/// reached NEAR the cap is marked visited and yields nothing; a later, SHORTER
/// branch to the same item is then skipped even though it would have resolved.
///
/// This walk uses a PATH-scoped set, so the id is released on the way out and
/// the shallow branch re-explores it freely. Pinned here rather than assumed,
/// because the failure is a silently missing polyline, not a crash.
#[test]
fn a_shared_item_reached_deep_then_shallow_is_still_emitted() {
    // Branch A: a 30-link chain ending at the shared representation (#7000),
    // deep enough that anything recorded globally would be at/near the cap.
    // Branch B: reaches #7000 directly. The polyline under it must be emitted
    // via B even after A has walked through it.
    let mut lines = String::new();
    let hops = 30usize;
    for i in 0..hops {
        let item = 100 + i * 3;
        let map = item + 1;
        let repr = item + 2;
        let next = if i + 1 < hops { 100 + (i + 1) * 3 } else { 7000 };
        lines.push_str(&format!("#{item}=IFCMAPPEDITEM(#{map},$);\n"));
        lines.push_str(&format!("#{map}=IFCREPRESENTATIONMAP($,#{repr});\n"));
        lines.push_str(&format!("#{repr}=IFCSHAPEREPRESENTATION($,$,$,(#{next}));\n"));
    }
    lines.push_str("#7000=IFCMAPPEDITEM(#7001,$);\n");
    lines.push_str("#7001=IFCREPRESENTATIONMAP($,#7002);\n");
    lines.push_str("#7002=IFCSHAPEREPRESENTATION($,$,$,(#7010));\n");
    lines.push_str("#7010=IFCPOLYLINE((#7011,#7012));\n");
    lines.push_str("#7011=IFCCARTESIANPOINT((0.,0.));\n#7012=IFCCARTESIANPOINT((1.,1.));\n");
    // Root holds the deep branch FIRST, then the direct one.
    lines.push_str("#10=IFCGEOMETRICCURVESET((#100,#7000));\n");

    let out = run(&wrap(&lines), 10);
    assert!(
        !out.polylines.is_empty(),
        "the shared item reached by a SHORT branch must still emit after a deep branch \
         walked through it; a global visited set would mark it explored and drop this"
    );
}

/// The input that defeats a cap AND a path-scoped set: an ACYCLIC DAG where
/// every branch SUCCEEDS. Nothing errors, so nothing propagates; no id repeats
/// on any single path, so the path guard never fires; and each level's fan-out
/// multiplies, so the cap bounds one path's length while the NUMBER of paths
/// doubles per level. Codex found this defeating a cap-plus-set guard on the
/// curve resolver (#2876) at 2^levels.
///
/// Only a total-work bound stops it. Here that is `MAX_ITEM_REVISITS`.
#[test]
fn an_acyclic_dag_is_bounded_by_total_work_not_by_depth() {
    // Level i's representation holds TWO mapped items, both pointing at level
    // i+1. 24 levels is 2^24 paths if nothing bounds total work.
    let levels = 24usize;
    let mut lines = String::new();
    for i in 0..levels {
        let map = 1000 + i * 10;
        let repr = map + 1;
        let a = map + 2;
        let b = map + 3;
        let next_map = if i + 1 < levels { 1000 + (i + 1) * 10 } else { 90_000 };
        lines.push_str(&format!("#{map}=IFCREPRESENTATIONMAP($,#{repr});\n"));
        lines.push_str(&format!("#{repr}=IFCSHAPEREPRESENTATION($,$,$,(#{a},#{b}));\n"));
        lines.push_str(&format!("#{a}=IFCMAPPEDITEM(#{next_map},$);\n"));
        lines.push_str(&format!("#{b}=IFCMAPPEDITEM(#{next_map},$);\n"));
    }
    lines.push_str("#90000=IFCREPRESENTATIONMAP($,#90001);\n");
    lines.push_str("#90001=IFCSHAPEREPRESENTATION($,$,$,(#90010));\n");
    lines.push_str("#90010=IFCPOLYLINE((#90011,#90012));\n");
    lines.push_str("#90011=IFCCARTESIANPOINT((0.,0.));\n#90012=IFCCARTESIANPOINT((1.,1.));\n");
    lines.push_str("#5=IFCMAPPEDITEM(#1000,$);\n");

    let out = run_with_timeout(wrap(&lines), 5, 30);
    // The point is that it TERMINATES within the budget rather than realising
    // 2^24 paths. Emitting some polylines is correct; emitting 2^24 is not.
    // Derived from the constant rather than restated: every emission past the
    // first reaches the leaf through a REVISIT, so the budget is the ceiling.
    // A raised budget moves this bound with it instead of leaving a literal
    // that quietly stops binding.
    // Two assertions, because the derived one alone cannot fail. The ceiling
    // follows the constant so a raised budget does not silently un-pin it; the
    // absolute bound pins the CONSEQUENCE, since the walk actually emits
    // 66,675 here and a tripling would still sit under the 200,000 ceiling
    // while the derived assertion reported success.
    let emitted = out.polylines.len();
    assert!(
        emitted <= MAX_ITEM_REVISITS as usize,
        "an acyclic DAG must be bounded by MAX_ITEM_REVISITS ({MAX_ITEM_REVISITS}), \
         got {emitted} polylines"
    );
    assert!(
        emitted < 100_000,
        "2^24 paths must collapse to the measured ~66,675, not merely to something \
         under the budget; got {emitted}"
    );
}

/// A WELL-FORMED flat set larger than the revisit bound must not be truncated.
/// `IfcGeometricSet` recurses per element, so an earlier version that charged
/// every visit dropped 51 curves from a valid 200,050-element set with no
/// error. Plan hatching, survey drawings and imported DWG geometry reach this
/// size legitimately. First visits are bounded by the file, so they are free.
#[test]
fn a_large_flat_set_is_not_truncated() {
    // A flat set LARGER than the revisit budget must still emit every element.
    // `IfcGeometricSet` recurses per element, so an earlier version that
    // charged every visit rather than only revisits silently truncated a
    // well-formed file: 200,050 curves emitted 199,999 and dropped 51, with no
    // error. Plan hatching, a survey drawing or an imported DWG reaches that
    // size legitimately.
    //
    // Pinned against an injected budget of 50 rather than the real 200,000.
    // The mechanism is identical -- first visits are not charged, so the set
    // may exceed the budget -- and the full-size fixture cost 4.24s of the
    // crate's 4.79s lib suite to build and walk 23.8 MB of STEP.
    const BUDGET: u32 = 50;
    let n = BUDGET as usize + 10;
    let mut lines = String::new();
    let mut items = String::new();
    for i in 0..n {
        let pl = 1000 + i * 3;
        if i > 0 {
            items.push(',');
        }
        items.push_str(&format!("#{pl}"));
        lines.push_str(&format!("#{pl}=IFCPOLYLINE((#{},#{}));\n", pl + 1, pl + 2));
        lines.push_str(&format!("#{}=IFCCARTESIANPOINT((0.,0.));\n", pl + 1));
        lines.push_str(&format!("#{}=IFCCARTESIANPOINT((1.,1.));\n", pl + 2));
    }
    lines.push_str(&format!("#10=IFCGEOMETRICCURVESET(({items}));\n"));
    let out = run_with_budget(&wrap(&lines), 10, BUDGET);
    assert_eq!(
        out.polylines.len(),
        n,
        "a well-formed flat set must emit every element; charging first visits truncates it"
    );
}

/// Pins the depth cap to the mapped-item family's VALUE (`element.rs`,
/// `router/processing.rs`, `wasm-bindings/.../color.rs` all use 32), so moving
/// the family fails here instead of leaving this site silently behind.
///
/// It pins the number and nothing more, deliberately: this cap does NOT count
/// the same thing the family counts. The others charge one level per
/// mapped-item hop; this walk also charges `depth + 1` for `IfcGeometricSet`
/// elements (`items.rs:56`) and `IfcCompositeCurve` segments (`items.rs:311`).
/// So a mapped chain whose levels each pass through a set or a composite curve
/// exhausts this cap in roughly half as many hops as the router's, and the
/// asymmetry is one-directional: this walk is never more permissive, so the
/// failure is a dropped symbolic annotation on geometry that still renders,
/// never the reverse. Equalising the numbers does not equalise the semantics,
/// and no assertion here can catch that -- it is recorded rather than tested.
#[test]
fn depth_cap_matches_the_mapped_item_family_value() {
    assert_eq!(
        MAX_ITEM_DEPTH,
        ifc_lite_core::MAX_MAPPED_ITEM_DEPTH,
        "must equal MAX_MAPPED_ITEM_DEPTH in element.rs, router/processing.rs and color.rs; \
         note this cap charges set elements and curve segments too, so equal values do not \
         mean equal reach"
    );
}
