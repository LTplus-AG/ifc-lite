// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The extraction-level output cap and its diagnostics (#2937, #2938).
//!
//! `item_walk.rs` bounds ONE top-level representation item.
//! `extract_symbolic_data` calls that walk once per item of every
//! Plan/Annotation/FootPrint/Axis representation of every product and
//! accumulates into a single `SymbolicData`, so before this the file-level
//! total was `items x per-item bound` and nothing bounded the extraction:
//! 20,002,500 polylines and 2.74 GB RSS from a 1.13 MB upload, on a path the
//! HTTP server calls with raw uploaded bytes.
//!
//! EVERY test below was verified to FAIL against the production behaviour it
//! names, by running the mutation rather than reasoning about it. That check
//! found two tests that could not fail:
//!
//!   - the "every variable-length field is charged" test used a 2-byte content
//!     with a 4 KB alignment, so dropping the CONTENT charge changed nothing
//!     and it stayed green while claiming to pin both;
//!   - the "does not abandon the file" test asserted `len() > 1`, which passes
//!     even when a per-item bound wrongly sets exhaustion and abandons every
//!     later product.
//!
//! Both are now built to discriminate. This is the fourth and fifth time in
//! this change that a fixture written to prove a fix shared the fix's
//! assumption, so the mutation run is not optional here.
//!
//! RESIDUAL, measured and not fixed here: the bounds are on OUTPUT, so they
//! bound work only insofar as work produces output. A fan-out whose leaf is an
//! item type the extractor does not handle traverses fully and emits nothing,
//! so neither bound ever fires:
//!
//!   179 KB -> 426 ms, 0 emitted      739 KB -> 1661 ms, 0 emitted
//!   3.0 MB -> 7216 ms, 0 emitted
//!
//! Linear at ~2.4 ms/KB. Not a regression -- `main` behaves identically, and
//! it is #2937's original per-item-budget complaint in the shape where output
//! capping cannot reach it. Closing it means hoisting the revisit budget from
//! per-item to per-extraction, which is now safe BECAUSE truncation is
//! reported, but changes truncation behaviour for legitimate multi-product
//! files and wants its own change.
//!
//! The two issues pulled in opposite directions -- bounding total work made
//! the silent truncation fire sooner, on smaller legitimate drawings -- so
//! they are fixed by one instrument: a cap on the OUTPUT, plus a diagnostics
//! field that says the cap was hit. Both halves are pinned here.
//!
use super::output_cap::{SymbolicAccumulator, SymbolicTruncationReason};
use super::primitives::SymbolicData;

/// N annotations, each carrying one 24-level fan-out DAG. No cycle, so no path
/// guard fires; the leaf is reachable down 2^24 paths and only a work bound
/// stops it. This is the shape that measured 2.73 GB.
fn hostile_dag(annotations: usize) -> String {
    hostile_dag_with_leaf(annotations, 2)
}

/// Same shape, with a caller-chosen number of points in the single leaf
/// polyline. That leaf is re-emitted up to the cap, so its size multiplies.
fn hostile_dag_with_leaf(annotations: usize, leaf_points: usize) -> String {
    let mut s = String::from("ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n");
    let mut id = 1000u32;
    let mut tops = Vec::new();
    for _ in 0..annotations {
        let mut next = 0u32;
        for level in 0..24 {
            let rm = id;
            id += 1;
            let r = id;
            id += 1;
            if level == 0 {
                let pl = id;
                id += 1;
                let p1 = id;
                id += 1;
                let p2 = id;
                id += 1;
                s.push_str(&format!("#{r}=IFCSHAPEREPRESENTATION($,$,$,(#{pl}));\n"));
                let pts: Vec<u32> = (0..leaf_points.max(2))
                    .map(|_| {
                        let q = id;
                        id += 1;
                        q
                    })
                    .collect();
                let refs = pts.iter().map(|q| format!("#{q}")).collect::<Vec<_>>().join(",");
                s.push_str(&format!("#{pl}=IFCPOLYLINE(({refs}));\n"));
                for (k, q) in pts.iter().enumerate() {
                    s.push_str(&format!("#{q}=IFCCARTESIANPOINT(({k}.,{k}.));\n"));
                }
                let _ = (p1, p2);
            } else {
                let a = id;
                id += 1;
                let b = id;
                id += 1;
                s.push_str(&format!("#{r}=IFCSHAPEREPRESENTATION($,$,$,(#{a},#{b}));\n"));
                s.push_str(&format!("#{a}=IFCMAPPEDITEM(#{next},$);\n"));
                s.push_str(&format!("#{b}=IFCMAPPEDITEM(#{next},$);\n"));
            }
            s.push_str(&format!("#{rm}=IFCREPRESENTATIONMAP($,#{r});\n"));
            next = rm;
        }
        let top = id;
        id += 1;
        s.push_str(&format!("#{top}=IFCMAPPEDITEM(#{next},$);\n"));
        tops.push(top);
    }
    let list = tops.iter().map(|t| format!("#{t}")).collect::<Vec<_>>().join(",");
    let prod = id;
    let shp = id + 1;
    let rep = id + 2;
    s.push_str(&format!(
        "#{prod}=IFCANNOTATION('x',$,$,$,$,$,#{shp});\n\
         #{shp}=IFCPRODUCTDEFINITIONSHAPE($,$,(#{rep}));\n\
         #{rep}=IFCSHAPEREPRESENTATION($,'Annotation','Annotation',({list}));\n"
    ));
    s.push_str("ENDSEC;\nEND-ISO-10303-21;\n");
    s
}

#[test]
fn a_hostile_file_is_bounded_and_says_so() {
    // Cap injected at 500 rather than 2,000,000: the mechanism is identical and
    // the fixture stays small. One annotation of this shape emits ~66,675
    // primitives uncapped, so 500 is comfortably exceeded.
    let mut out = SymbolicAccumulator::with_limit(500);
    super::extract_symbolic_data_into(&hostile_dag(2).into_bytes(), &mut out);
    let out = out.into_data();

    assert_eq!(
        out.len(),
        500,
        "the cap must bound the TOTAL across every collection, not each one"
    );
    let truncation = out
        .truncated
        .as_ref()
        .expect("a truncated extraction must say so: silence here is #2938 verbatim");
    assert_eq!(truncation.limit, Some(500));
    assert_eq!(
        truncation.reason,
        SymbolicTruncationReason::ElementCount,
        "the diagnostic must name WHICH bound fired, not merely that one did"
    );
    assert_eq!(
        truncation.emitted, 500,
        "`emitted` must be the count at the moment extraction stopped"
    );
}

#[test]
fn a_file_that_fits_is_not_marked_truncated() {
    // The control. Without it the assertions above pass on an implementation
    // that marks EVERY extraction truncated, which would make the diagnostic
    // worthless in the direction that matters -- a consumer would show
    // "results incomplete" on every drawing and learn to ignore it.
    let mut out = SymbolicAccumulator::with_limit(500);
    super::extract_symbolic_data_into(&hostile_dag(0).into_bytes(), &mut out);
    let out = out.into_data();
    assert!(
        out.truncated.is_none(),
        "an extraction that never reached the cap must not report truncation"
    );
    assert!(out.truncated.is_none());
}

#[test]
fn truncation_survives_the_wire_and_absence_still_deserializes() {
    // `apps/server/src/routes/parse/cache_keys.rs` reads cached JSON written
    // before this field existed, so absence must deserialize; and an
    // untruncated response must serialize exactly as it did before, or every
    // cache key in flight changes.
    let mut acc = SymbolicAccumulator::with_limit(1);
    super::extract_symbolic_data_into(&hostile_dag(1).into_bytes(), &mut acc);
    let truncated = acc.into_data();
    assert!(truncated.truncated.is_some(), "fixture must actually truncate");

    let json = serde_json::to_string(&truncated).expect("serializes");
    let back: SymbolicData = serde_json::from_str(&json).expect("round-trips");
    assert_eq!(back.truncated, truncated.truncated);

    let clean = SymbolicData::default();
    let clean_json = serde_json::to_string(&clean).expect("serializes");
    assert!(
        !clean_json.contains("truncated"),
        "an untruncated result must not gain a field on the wire: {clean_json}"
    );
    let old_shape: SymbolicData =
        serde_json::from_str(r#"{"grid_axes":[],"polylines":[],"circles":[],"texts":[],"fills":[]}"#)
            .expect("JSON cached before this field existed must still deserialize");
    assert!(old_shape.truncated.is_none());
}

#[test]
fn a_few_enormous_primitives_are_bounded_too() {
    // The attack a COUNT-only cap misses, and the reason this bound is in
    // bytes. Per-primitive size is attacker-controlled -- neither
    // `SymbolicPolyline.points` nor `SymbolicText.content` has a length limit
    // anywhere in the extractor -- and the fan-out re-emits ONE leaf up to the
    // cap, cloning its point vector every time. So the leaf is paid for once
    // in the file and N times in RAM.
    //
    // Measured against a count-only cap of 2,000,000, leaf size the only knob:
    //
    //   leaf pts   fixture     emitted     peak RSS
    //          2   0.15 MB   2,000,000       278 MB
    //        512   1.07 MB   2,000,000      8.47 GB
    //       1024   2.03 MB   2,000,000     16.70 GB
    //
    // Six times worse than the 2.74 GB the count cap was written to fix. A
    // count cap tuned on a 2-point fixture measures the fixture, not the bound.
    //
    // Injected budgets keep this fast: 4 KiB of output with a 400-point leaf,
    // so the COUNT bound (500) is nowhere near and only the BYTE bound can stop
    // it. If the byte charge is ever removed, this test is what fails.
    let mut acc = SymbolicAccumulator::with_limits(500, 4096);
    super::extract_symbolic_data_into(&hostile_dag_with_leaf(2, 400).into_bytes(), &mut acc);
    let out = acc.into_data();

    assert!(
        out.truncated.is_some(),
        "a file of few but enormous primitives must still be bounded"
    );
    assert!(
        out.len() < 500,
        "the BYTE bound must bite before the count bound: emitted {} of a 500 count cap, \
         so this stopped for the wrong reason and the byte charge is not working",
        out.len()
    );
    let emitted_payload: usize = out.polylines.iter().map(|p| p.points.len()).sum();
    assert!(
        emitted_payload * 8 <= 4096 + 400 * 8,
        "total emitted payload must respect the byte budget; got {emitted_payload} coords"
    );
}

/// A fan-out whose leaf is a TEXT literal with a large `BoxAlignment`.
///
/// `alignment` is read from the file with no length bound and cloned on every
/// emission. Charging only `content` made the byte bound a 13.5x under-count:
/// 800,100 texts charged 54.9 MB while the process held 3.45 GB and
/// `truncated` stayed None.
fn hostile_text_dag(content_len: usize, alignment_len: usize) -> String {
    let pad = "A".repeat(alignment_len);
    let body = "B".repeat(content_len.max(2));
    let mut s = String::from("ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n");
    let mut id = 1000u32;
    let mut next = 0u32;
    for level in 0..12 {
        let rm = id;
        id += 1;
        let r = id;
        id += 1;
        if level == 0 {
            let tl = id;
            id += 1;
            let pt = id;
            id += 1;
            s.push_str(&format!("#{r}=IFCSHAPEREPRESENTATION($,$,$,(#{tl}));\n"));
            s.push_str(&format!(
                "#{tl}=IFCTEXTLITERALWITHEXTENT('{body}',#{pt},.RIGHT.,$,'{pad}');\n"
            ));
            s.push_str(&format!("#{pt}=IFCAXIS2PLACEMENT2D(#{},$);\n", pt + 1));
            s.push_str(&format!("#{}=IFCCARTESIANPOINT((0.,0.));\n", pt + 1));
            id += 2;
        } else {
            let a = id;
            id += 1;
            let b = id;
            id += 1;
            s.push_str(&format!("#{r}=IFCSHAPEREPRESENTATION($,$,$,(#{a},#{b}));\n"));
            s.push_str(&format!("#{a}=IFCMAPPEDITEM(#{next},$);\n"));
            s.push_str(&format!("#{b}=IFCMAPPEDITEM(#{next},$);\n"));
        }
        s.push_str(&format!("#{rm}=IFCREPRESENTATIONMAP($,#{r});\n"));
        next = rm;
    }
    let top = id;
    id += 1;
    s.push_str(&format!("#{top}=IFCMAPPEDITEM(#{next},$);\n"));
    let prod = id;
    let shp = id + 1;
    let rep = id + 2;
    s.push_str(&format!(
        "#{prod}=IFCANNOTATION('x',$,$,$,$,$,#{shp});\n\
         #{shp}=IFCPRODUCTDEFINITIONSHAPE($,$,(#{rep}));\n\
         #{rep}=IFCSHAPEREPRESENTATION($,'Annotation','Annotation',(#{top}));\n"
    ));
    s.push_str("ENDSEC;\nEND-ISO-10303-21;\n");
    s
}

#[test]
fn every_variable_length_field_is_charged_not_just_the_obvious_one() {
    // The blind spot that shipped past one review. The previous cap charged
    // `points` for polylines and the test that "proved" the byte bound used a
    // POLYLINE leaf -- so the oracle shared the fix's assumption, and a TEXT
    // leaf with a huge `alignment` walked straight through a bound that
    // reported itself as holding.
    //
    // Byte budget deliberately tiny and count budget huge, so ONLY the byte
    // charge can stop this. If `alignment` stops being charged, the run blows
    // past the byte budget and this fails.
    // BOTH directions, because charging only one field still passes a fixture
    // that only makes the other one large. An earlier version used a 2-byte
    // content with a 4 KB alignment, so dropping the `content` charge changed
    // nothing and the test stayed green while claiming to pin "every"
    // variable-length field.
    for (content_len, alignment_len, which) in
        [(2usize, 4096usize, "alignment"), (4096, 2, "content")]
    {
        let mut acc = SymbolicAccumulator::with_limits(100_000, 8192);
        super::extract_symbolic_data_into(
            &hostile_text_dag(content_len, alignment_len).into_bytes(),
            &mut acc,
        );
        let out = acc.into_data();

        let truncation = out
            .truncated
            .as_ref()
            .unwrap_or_else(|| panic!("a {which}-heavy fan-out must be bounded and reported"));
        assert_eq!(
            truncation.reason,
            SymbolicTruncationReason::OutputBytes,
            "the BYTE bound must fire for a {which}-heavy file; ElementCount here \
             means {which} bytes are going uncharged"
        );
        let charged: usize =
            out.texts.iter().map(|t| t.content.len() + t.alignment.len()).sum();
        assert!(
            charged * 8 <= 8192 + 4096 * 8,
            "{which}-heavy payload must respect the byte budget; got {charged}"
        );
    }
}

#[test]
fn a_per_item_bound_reports_its_own_reason_and_does_not_abandon_the_file() {
    // #2938's LEAD case in miniature: content lost to a PER-ITEM bound while
    // the file-level totals sit far below the extraction bounds. Reporting
    // only the extraction bounds would say nothing here, which is exactly the
    // silence the issue is about.
    //
    // Also pins the separation that a first attempt got wrong: a per-item
    // bound marks the result truncated but must NOT set exhaustion, or one
    // deep item abandons every remaining product in the file.
    let mut acc = SymbolicAccumulator::with_limits(10_000_000, 64 * 1024 * 1024);
    super::extract_symbolic_data_into(&hostile_dag(2).into_bytes(), &mut acc);
    let out = acc.into_data();

    let truncation = out
        .truncated
        .as_ref()
        .expect("a per-item bound drops content and must say so");
    assert_eq!(truncation.reason, SymbolicTruncationReason::ItemRevisits);
    assert_eq!(
        truncation.limit, None,
        "a per-item bound has no file-level limit to compare `emitted` against"
    );
    // One product of this fixture emits exactly 66,675 primitives (measured),
    // so exceeding that is what proves the SECOND product was reached. The
    // previous assertion was `> 1`, which passes even when a per-item bound
    // wrongly sets exhaustion and abandons everything after the first item --
    // it could not fail in the direction it was pointed.
    assert!(
        out.len() > 66_675,
        "the rest of the file must still be extracted: a per-item bound is not \
         exhaustion, and treating it as such abandons every later product. \
         Got {} primitives, which is one product's worth or less",
        out.len()
    );
}

#[test]
fn the_early_exits_stop_the_walk_and_not_only_the_appends() {
    // The gap an earlier version of this file RECORDED as unpinnable, wrongly.
    // The early exits bound WORK, and work is invisible in the output -- a
    // refused append leaves the result byte-identical -- so the claim was that
    // only timing could observe them, and timing would be flaky.
    //
    // It is observable, deterministically, one level in: refused appends. With
    // the exits, the walk stops as soon as the accumulator is full and refusals
    // stay small. Without them it keeps traversing and every would-be append is
    // refused, so the count explodes. The accumulator was already
    // test-injectable; the observable was there all along.
    let mut acc = SymbolicAccumulator::with_limits(500, 64 * 1024 * 1024);
    super::extract_symbolic_data_into(&hostile_dag(2).into_bytes(), &mut acc);
    let refusals = acc.refusals();

    assert!(acc.is_exhausted(), "fixture must reach the cap");
    assert!(
        refusals < 5_000,
        "the walk must STOP once the accumulator is full, not keep traversing \
         and discarding: {refusals} refused appends means the early exits are \
         gone and the work is unbounded again"
    );
}

/// A mapped-item chain deeper than `MAX_ITEM_DEPTH`, emitting almost nothing.
/// Cheap way to make a per-item bound fire FIRST in scan order.
fn deep_chain_then(rest: &str, start: u32) -> String {
    let mut s = String::new();
    let mut id = start;
    let mut next = 0u32;
    for level in 0..40 {
        let rm = id;
        id += 1;
        let r = id;
        id += 1;
        if level == 0 {
            let pl = id;
            id += 1;
            s.push_str(&format!("#{r}=IFCSHAPEREPRESENTATION($,$,$,(#{pl}));\n"));
            s.push_str(&format!("#{pl}=IFCPOLYLINE((#{},#{}));\n", pl + 1, pl + 2));
            s.push_str(&format!("#{}=IFCCARTESIANPOINT((0.,0.));\n", pl + 1));
            s.push_str(&format!("#{}=IFCCARTESIANPOINT((1.,1.));\n", pl + 2));
            id += 2;
        } else {
            let a = id;
            id += 1;
            s.push_str(&format!("#{r}=IFCSHAPEREPRESENTATION($,$,$,(#{a}));\n"));
            s.push_str(&format!("#{a}=IFCMAPPEDITEM(#{next},$);\n"));
        }
        s.push_str(&format!("#{rm}=IFCREPRESENTATIONMAP($,#{r});\n"));
        next = rm;
    }
    let top = id;
    id += 1;
    s.push_str(&format!("#{top}=IFCMAPPEDITEM(#{next},$);\n"));
    let prod = id;
    s.push_str(&format!(
        "#{prod}=IFCANNOTATION('deep',$,$,$,$,$,#{});\n\
         #{}=IFCPRODUCTDEFINITIONSHAPE($,$,(#{}));\n\
         #{}=IFCSHAPEREPRESENTATION($,'Annotation','Annotation',(#{top}));\n",
        prod + 1, prod + 1, prod + 2, prod + 2
    ));
    format!("{s}{rest}")
}

#[test]
fn an_extraction_bound_outranks_a_per_item_one_whatever_the_scan_order() {
    // The collision the sibling test is scoped to avoid, and which first-wins
    // got wrong. A per-item bound fires on an early product; the whole-output
    // cap fires later. Scan order is attacker-controlled, so first-wins let a
    // file that blew the DoS-scale ceiling report the mild `item-revisits`
    // with its numeric limit dropped.
    //
    // Bounds chosen so BOTH fire: the fan-out exhausts a per-item revisit
    // budget early, and 200 elements is low enough that the extraction cap
    // follows.
    // The deep chain (per-item ItemDepth) is scanned BEFORE the fan-out that
    // blows the element cap, so first-wins records the milder reason.
    let dag = hostile_dag(2);
    let body = dag
        .strip_prefix("ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n")
        .expect("fixture prefix");
    let file = format!(
        "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n{}",
        deep_chain_then(body, 500_000)
    );
    let mut acc = SymbolicAccumulator::with_limits(200, 64 * 1024 * 1024);
    super::extract_symbolic_data_into(&file.into_bytes(), &mut acc);
    let out = acc.into_data();

    let truncation = out.truncated.as_ref().expect("must be truncated");
    assert_eq!(
        truncation.reason,
        SymbolicTruncationReason::ElementCount,
        "the whole-output cap must outrank a per-item bound that happened to \
         fire earlier in scan order; reporting the milder reason understates \
         the most severe truncation there is"
    );
    assert_eq!(
        truncation.limit,
        Some(200),
        "and its numeric limit must survive: a per-item reason carries None, \
         so mislabelling also silently drops the number"
    );
}
