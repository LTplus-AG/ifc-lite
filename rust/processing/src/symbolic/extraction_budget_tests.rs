// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Pins issue #2937: `extract_symbolic_data`'s revisit budget bounds the
//! WHOLE extraction, not one top-level item at a time -- and when the shared
//! budget is exhausted by an earlier item, a later item's truncation is
//! still reported (issue #2938's signal), not silently dropped.
//!
//! Before this fix, every top-level item in the scan loop
//! (`extract_symbolic_data`'s `for item in items` loop) built a fresh
//! `ItemWalk` with its own `MAX_ITEM_REVISITS`, so a file with N top-level
//! items sharing one crafted fan-out got N independent budgets. Measured on
//! the real constant: 300 annotations sharing a 24-level mapped-item DAG
//! (the same shape as `an_acyclic_dag_is_bounded_by_total_work_not_by_depth`
//! in `items_cycle_tests.rs`) cost 2.73 GB RSS from a 59 KB upload -- see
//! `rust/processing/examples/repro_2937.rs`.

use super::{extract_symbolic_data_with_revisit_budget, MAX_ITEM_REVISITS};
use std::sync::{Arc, Mutex};
use tracing::field::{Field, Visit};
use tracing::span::{Attributes, Id, Record};
use tracing::{Event, Level, Metadata, Subscriber};

fn wrap(body: &str) -> String {
    format!("ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n{body}ENDSEC;\nEND-ISO-10303-21;\n")
}

/// One top-level annotation whose top-level item is an `IfcGeometricCurveSet`
/// holding `repeats` references to the SAME mapped item id -- the first is a
/// free first visit, every following occurrence of that id is a charged
/// revisit. The mapped item resolves through its OWN representation map to a
/// leaf polyline, distinct from the set doing the repeating, so this is a
/// fan-in (shared geometry reused `repeats` times), not a cycle.
fn annotation_with_repeated_mapped_item(ann_id: u32, repeats: usize) -> String {
    let set = ann_id * 100 + 1;
    let item = ann_id * 100 + 2;
    let map = ann_id * 100 + 3;
    let repr = ann_id * 100 + 4;
    let poly = ann_id * 100 + 5;
    let p0 = ann_id * 100 + 6;
    let p1 = ann_id * 100 + 7;
    let pds = ann_id * 100 + 8;
    let shape_rep = ann_id * 100 + 9;

    let mut refs = String::new();
    for i in 0..repeats {
        if i > 0 {
            refs.push(',');
        }
        refs.push_str(&format!("#{item}"));
    }

    format!(
        "#{set}=IFCGEOMETRICCURVESET(({refs}));\n\
         #{item}=IFCMAPPEDITEM(#{map},$);\n\
         #{map}=IFCREPRESENTATIONMAP($,#{repr});\n\
         #{repr}=IFCSHAPEREPRESENTATION($,$,$,(#{poly}));\n\
         #{poly}=IFCPOLYLINE((#{p0},#{p1}));\n\
         #{p0}=IFCCARTESIANPOINT((0.,0.));\n\
         #{p1}=IFCCARTESIANPOINT((1.,1.));\n\
         #{shape_rep}=IFCSHAPEREPRESENTATION($,'Annotation',$,(#{set}));\n\
         #{pds}=IFCPRODUCTDEFINITIONSHAPE($,$,(#{shape_rep}));\n\
         #{ann_id}=IFCANNOTATION($,$,$,$,$,$,#{pds});\n"
    )
}

/// Minimal `tracing::Subscriber` that records every WARN event's `reason`
/// field, so a test can assert a specific item's truncation was logged
/// without pulling in a subscriber crate.
struct CaptureWarnings {
    reasons: Arc<Mutex<Vec<String>>>,
}

#[derive(Default)]
struct ReasonVisitor {
    reason: Option<String>,
}

impl Visit for ReasonVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "reason" {
            self.reason = Some(format!("{value:?}"));
        }
    }
}

impl Subscriber for CaptureWarnings {
    fn enabled(&self, _metadata: &Metadata<'_>) -> bool {
        true
    }
    fn new_span(&self, _span: &Attributes<'_>) -> Id {
        Id::from_u64(1)
    }
    fn record(&self, _span: &Id, _values: &Record<'_>) {}
    fn record_follows_from(&self, _span: &Id, _follows: &Id) {}
    fn event(&self, event: &Event<'_>) {
        if *event.metadata().level() != Level::WARN {
            return;
        }
        let mut visitor = ReasonVisitor::default();
        event.record(&mut visitor);
        if let Some(reason) = visitor.reason {
            self.reasons.lock().unwrap().push(reason);
        }
    }
    fn enter(&self, _span: &Id) {}
    fn exit(&self, _span: &Id) {}
}

/// RED (pre-#2937-fix) behavior this pins the absence of, and ALSO the
/// absence of a subtler wrong fix: "the budget is threaded through the
/// call, but re-freshed per top-level item" (e.g. each item getting its own
/// copy of whatever value the caller passed in, instead of one counter that
/// crosses the item boundary). A loose `polylines.len()` RANGE cannot tell
/// those apart -- see below -- so this pins an exact count instead, chosen
/// so the two designs can never land on the same number.
///
/// Each reference past the first to the SAME mapped item id charges TWO
/// revisits, not one: the mapped item id itself, and the polyline id its
/// representation map resolves to (also re-entered on every repeat, since
/// both ids were already marked `seen` by the first reference). So an item
/// with 7 references (1 free + 6 repeats) costs 12 to complete, not 6. A
/// budget of 10 is short of that by construction: item A alone, run to
/// completion of what it CAN afford, always ends by spending the budget
/// down to EXACTLY 0 -- the cost per repeat is charged in an all-or-nothing
/// pair (the mapped-item charge only proceeds to the polyline charge if
/// budget remains, and the mapped-item charge itself is refused outright at
/// 0), so there is no partial remainder to leave behind. That leaves item A
/// at 6 polylines (1 free + 5 completed repeats, verified empirically:
/// budget 10 and budget 11 both stop at 6, both spending down to 0).
///
/// Under a budget HOISTED across items, item B therefore starts at 0 and
/// can only emit its own free first visit: total = 6 + 1 = 7 (ODD).
///
/// Under a PER-ITEM budget -- whether it re-freshes the real
/// `MAX_ITEM_REVISITS` (the faithful pre-fix mutation, giving 7 + 7 = 14)
/// or re-freshes this test's own parameter, 10 (a weaker mutation that
/// still threads a budget, just not across the item boundary, giving
/// 6 + 6 = 12) -- item B gets the SAME allowance item A started with,
/// independent of what item A actually spent. Both items then run the
/// identical computation on identical input and so emit the identical
/// count: the total is ALWAYS 2x one item's count, i.e. EVEN, for every
/// possible per-item budget size. An odd total is therefore unreachable by
/// ANY per-item design, while the hoisted design lands on 7 exactly. That
/// is what makes this assertion distinguish "budget crosses the item
/// boundary" from "budget is merely threaded through the call" -- the
/// previous `< 14` / `>= 7` range let a per-item budget of 10 land inside
/// it (12 is in `[7, 14)`) purely by coincidence.
#[test]
fn a_shared_budget_carries_a_deficit_from_one_top_level_item_into_the_next() {
    let mut content = String::new();
    content.push_str(&annotation_with_repeated_mapped_item(10, 7));
    content.push_str(&annotation_with_repeated_mapped_item(20, 7));
    let file = wrap(&content);

    let out = extract_symbolic_data_with_revisit_budget(&file, 10);

    assert_eq!(
        out.polylines.len(),
        7,
        "a budget of 10 shared across two items that each cost 12 to \
         complete must leave item A at 6 (draining the shared budget to \
         exactly 0) and item B at its single free first visit (1). Any \
         PER-ITEM budget instead gives both items the identical fresh \
         allowance, which always emits an EVEN total (2x one item's own \
         count) and can never land on this odd total -- got {}",
        out.polylines.len()
    );
}

/// Pins #2938's signal at the `extract_symbolic_data` call site (the
/// `tracing::warn!` in `mod.rs`'s scan loop), independent of #2937's hoist.
/// `item_walk_truncation_tests.rs` already pins the `Option<TruncationReason>`
/// return value at the `extract_symbolic_item` layer directly; this is the
/// one place that pins the scan loop actually turning a `Some(reason)` into
/// a logged event instead of dropping it. A single top-level item is enough
/// to exhaust its own (non-shared) budget, so this needs none of the
/// two-item machinery above -- deleting the test above and keeping only this
/// one would still catch a per-item-vs-hoisted regression via the exact
/// count there; deleting this one and keeping only that one would lose
/// coverage of the WARN translation itself (e.g. a fix that hoists the
/// budget correctly but never wires the reason through to `tracing::warn!`).
#[test]
fn a_single_items_budget_exhaustion_is_still_reported() {
    let mut content = String::new();
    content.push_str(&annotation_with_repeated_mapped_item(10, 5));
    let file = wrap(&content);

    let reasons = Arc::new(Mutex::new(Vec::new()));
    let subscriber = CaptureWarnings { reasons: reasons.clone() };
    let out = tracing::subscriber::with_default(subscriber, || {
        extract_symbolic_data_with_revisit_budget(&file, 2)
    });

    // 5 references cost 8 to complete (1 free + 4 repeats x 2); a budget of
    // 2 affords only the first repeat, so this item must be cut short.
    assert!(
        out.polylines.len() < 5,
        "a budget of 2 must truncate a 5-reference item, got {}",
        out.polylines.len()
    );

    let captured = reasons.lock().unwrap();
    assert!(
        !captured.is_empty(),
        "a truncated top-level item must log a warning; got no WARN events at all"
    );
    assert!(
        captured.iter().any(|r| r.contains("RevisitBudgetExhausted")),
        "expected a RevisitBudgetExhausted warning, got {captured:?}"
    );
}

/// A well-formed file whose top-level items don't come close to the shared
/// budget must be completely unaffected -- the hoist only changes behavior
/// once the budget is actually exhausted.
#[test]
fn a_shared_budget_leaves_unrelated_items_untouched_below_the_cap() {
    let mut content = String::new();
    content.push_str(&annotation_with_repeated_mapped_item(10, 3));
    content.push_str(&annotation_with_repeated_mapped_item(20, 3));
    let file = wrap(&content);

    let reasons = Arc::new(Mutex::new(Vec::new()));
    let subscriber = CaptureWarnings { reasons: reasons.clone() };
    let out = tracing::subscriber::with_default(subscriber, || {
        extract_symbolic_data_with_revisit_budget(&file, MAX_ITEM_REVISITS)
    });

    assert_eq!(
        out.polylines.len(),
        6,
        "3 + 3 references, all well under the real budget, must all emit"
    );
    assert!(
        reasons.lock().unwrap().is_empty(),
        "nothing should be reported when nothing was truncated"
    );
}
