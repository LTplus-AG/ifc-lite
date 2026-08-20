// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Pins issue #2938: a bound firing in the symbolic walk must be
//! DISTINGUISHABLE from success. `extract_symbolic_item` used to return `()`
//! unconditionally -- a truncated walk and a complete one were
//! byte-identical from the caller's side. It now returns
//! `Option<TruncationReason>`, mirroring the sibling bound in
//! `router/processing.rs:338`, which already raises an `Err` at the same
//! `IfcMappedItem` nesting bound.
//!
//! `SymbolicData` itself is untouched -- no field, no shape change, nothing
//! on the wire. This only makes the walk's own return value tell the truth.

use super::item_walk::{
    extract_symbolic_item, extract_symbolic_item_with_revisit_budget, TruncationReason,
    MAX_ITEM_DEPTH, MAX_ITEM_REVISITS,
};
use super::primitives::SymbolicData;
use super::transform::Transform2D;
use ifc_lite_core::{build_entity_index, EntityDecoder};
use std::collections::HashMap;

fn wrap(body: &str) -> String {
    format!("ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n{body}ENDSEC;\nEND-ISO-10303-21;\n")
}

fn run(step: &str, start_id: u32) -> (SymbolicData, Option<TruncationReason>) {
    let content = step.as_bytes();
    let index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, index);
    let item = decoder.decode_by_id(start_id).expect("fixture entity decodes");
    let styled: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut out = SymbolicData::default();
    let mut budget = MAX_ITEM_REVISITS;
    let truncated = extract_symbolic_item(
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
        &mut budget,
    );
    (out, truncated)
}

fn run_with_budget(step: &str, start_id: u32, budget: u32) -> (SymbolicData, Option<TruncationReason>) {
    let content = step.as_bytes();
    let index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, index);
    let item = decoder.decode_by_id(start_id).expect("fixture entity decodes");
    let styled: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut out = SymbolicData::default();
    let truncated = extract_symbolic_item_with_revisit_budget(
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
    (out, truncated)
}

/// RED (pre-fix) behavior this pins the absence of: a well-formed, acyclic
/// file whose first-visit count alone exceeds the revisit budget used to
/// return `()` no matter what happened inside -- a caller had no way to tell
/// this apart from a file that legitimately had fewer curves. Budget=0 forces
/// the very first revisit (the second mapped item onto the shared
/// representation) to exhaust it immediately.
#[test]
fn revisit_budget_exhaustion_is_reported() {
    let body = "#10=IFCGEOMETRICCURVESET((#20,#21));\n\
        #20=IFCMAPPEDITEM(#30,$);\n\
        #21=IFCMAPPEDITEM(#31,$);\n\
        #30=IFCREPRESENTATIONMAP($,#40);\n\
        #31=IFCREPRESENTATIONMAP($,#40);\n\
        #40=IFCSHAPEREPRESENTATION($,$,$,(#50));\n\
        #50=IFCPOLYLINE((#60,#61));\n\
        #60=IFCCARTESIANPOINT((0.,0.));\n\
        #61=IFCCARTESIANPOINT((1.,1.));\n";
    let (out, truncated) = run_with_budget(&wrap(body), 10, 0);
    // The first mapped item's polyline is a first visit -- never charged --
    // so it still emits. Geometry is unchanged by this fix.
    assert_eq!(out.polylines.len(), 1, "the first visit must still emit (unchanged behavior)");
    assert_eq!(
        truncated,
        Some(TruncationReason::RevisitBudgetExhausted),
        "GREEN: the second insert's revisit must now be reported, not silently dropped"
    );
}

/// A well-formed extraction that never touches a bound must report nothing.
#[test]
fn a_complete_extraction_reports_no_truncation() {
    let body = "#10=IFCPOLYLINE((#60,#61));\n\
        #60=IFCCARTESIANPOINT((0.,0.));\n\
        #61=IFCCARTESIANPOINT((1.,1.));\n";
    let (out, truncated) = run(&wrap(body), 10);
    assert_eq!(out.polylines.len(), 1);
    assert_eq!(truncated, None, "nothing fired, so nothing should be reported");
}

/// The depth bound must be reported too, not just the revisit budget --
/// `router/processing.rs:338` raises `Err` for both nesting depth AND a
/// cyclic reference, and this walk's two bounds (plus its path-cycle guard)
/// are the same policy.
#[test]
fn depth_cap_exhaustion_is_reported() {
    let hops = (MAX_ITEM_DEPTH as usize) + 5;
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
    let (out, truncated) = run(&wrap(&lines), 100);
    assert!(out.polylines.is_empty(), "the chain is cut off before reaching its leaf (unchanged behavior)");
    assert_eq!(
        truncated,
        Some(TruncationReason::MaxDepth),
        "GREEN: a depth-cap cutoff must now be reported"
    );
}

/// A genuine cycle must also be reported (not just the two budgets).
#[test]
fn a_cycle_is_reported() {
    let (out, truncated) = run(&wrap("#10=IFCGEOMETRICCURVESET((#10));\n"), 10);
    assert!(out.polylines.is_empty());
    assert_eq!(
        truncated,
        Some(TruncationReason::Cycle),
        "GREEN: a self-referential set must be reported, not just silently emit nothing"
    );
}
