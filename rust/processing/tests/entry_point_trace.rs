// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! C4-0 (#7782): the front door of the native pipeline, pinned before it is
//! reshaped.
//!
//! The pipeline has eleven public entry points. They were meant to be thin
//! wrappers around one body, and this test holds them to that: on a fixture
//! set, every variant that asks for the same work returns a byte-identical
//! [`ProcessingResult`] (digest in `common::entry_trace`), and every variant
//! that emits events obeys one ordering contract:
//!
//! * the quick-metadata bootstrap fires at most once, before the first batch;
//! * the baked basis is published once, before the first batch, even when the
//!   file has no geometry jobs at all;
//! * deferred colour updates replay after the first batch, never before it;
//! * `processed` never goes backwards and never passes `total`.
//!
//! C4-1 puts `process(content, &ProcessingRequest, &mut sink)` behind all of
//! them; the last tests here drive it directly and pin the request builder
//! and the sink events against the same contract. The browser
//! leg of C4-0 (native `process` against `IfcAPI::produce_batch`) is not here:
//! `produce_batch` reads `js_sys::Date::now` and the pre-pass hands its jobs to
//! JS, so neither runs natively until C4-10b/11b make them callable.

mod common;

use common::entry_trace::{assert_ordering_contract, result_digest, Event, Recorder};
use ifc_lite_processing::{
    native_to_baked, process, process_geometry, Batching, Features, ProcessingRequest, process_geometry_filtered,
    process_geometry_filtered_with_quality, process_geometry_filtered_with_quality_and_ids,
    process_geometry_streaming, process_geometry_streaming_filtered,
    process_geometry_streaming_filtered_with_baked_basis,
    process_geometry_streaming_filtered_with_options, process_geometry_streaming_with_options,
    process_geometry_streaming_with_options_and_bootstrap, process_geometry_with_index,
    OpeningFilterMode, ProcessingResult, StreamingOptions, TessellationQuality,
};
use std::cell::RefCell;
use std::collections::HashSet;
use std::sync::{Arc, OnceLock};

/// Committed fixtures, so the gate runs without the downloaded model corpus:
/// a styled multi-colour element, voided walls, a spatial hierarchy with
/// building-level geometry, and polygonal cutters.
const FIXTURES: &[&str] = &[
    "tests/fixtures/issue_6601_multicolor_element.ifc",
    "tests/fixtures/issue_2019_wall_two_overlapping_openings.ifc",
    "tests/fixtures/issue_3641_voiding_trap.ifc",
    "../geometry/tests/fixtures/issue_1910_building_shell_geometry.ifc",
    "../geometry/tests/fixtures/issue_4560_wall_roof_polygonal_cutters.ifc",
    "../geometry/tests/fixtures/mapped_instances_synthetic.ifc",
];

const EMPTY_MODEL: &str = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n\
FILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
#1=IFCPROJECT('0PrOjEcTpRoJeCtPrOjEc',$,'P',$,$,$,$,$,$);\nENDSEC;\nEND-ISO-10303-21;\n";

fn load(rel: &str) -> Vec<u8> {
    let path = format!("{}/{rel}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"))
}

fn all_inputs() -> Vec<(String, Vec<u8>)> {
    let mut v: Vec<(String, Vec<u8>)> = FIXTURES.iter().map(|f| (f.to_string(), load(f))).collect();
    v.push(("empty model".into(), EMPTY_MODEL.as_bytes().to_vec()));
    v
}

/// Every variant that asks for "the default pass over the whole file" returns
/// one result. Batch size is a delivery property, not an input to the result.
#[test]
fn default_pass_variants_return_one_result() {
    for (name, content) in all_inputs() {
        let reference = result_digest(&process_geometry(&content));
        let index = Arc::new(ifc_lite_core::build_entity_index(&content));
        let variants: Vec<(&str, ProcessingResult)> = vec![
            ("filtered", process_geometry_filtered(&content, OpeningFilterMode::Default)),
            ("with_index", process_geometry_with_index(&content, index)),
            (
                "filtered_with_quality",
                process_geometry_filtered_with_quality(
                    &content,
                    OpeningFilterMode::Default,
                    TessellationQuality::default(),
                ),
            ),
            ("streaming", process_geometry_streaming(&content, 50, |_, _, _| {})),
            (
                "streaming_with_options",
                process_geometry_streaming_with_options(
                    &content,
                    StreamingOptions::default(),
                    |_, _, _| {},
                    |_| {},
                ),
            ),
            (
                "streaming_with_options_and_bootstrap",
                process_geometry_streaming_with_options_and_bootstrap(
                    &content,
                    StreamingOptions::default(),
                    |_, _, _| {},
                    |_| {},
                    |_| {},
                ),
            ),
            (
                "streaming_filtered",
                process_geometry_streaming_filtered(
                    &content,
                    OpeningFilterMode::Default,
                    3,
                    |_, _, _| {},
                    |_| {},
                ),
            ),
            (
                "streaming_filtered_with_options",
                process_geometry_streaming_filtered_with_options(
                    &content,
                    OpeningFilterMode::Default,
                    StreamingOptions::default(),
                    |_, _, _| {},
                    |_| {},
                    |_| {},
                ),
            ),
            (
                "streaming_filtered_with_baked_basis",
                process_geometry_streaming_filtered_with_baked_basis(
                    &content,
                    OpeningFilterMode::Default,
                    StreamingOptions::default(),
                    &OnceLock::new(),
                    |_, _, _| {},
                    |_| {},
                    |_| {},
                ),
            ),
        ];
        for (variant, result) in variants {
            assert_eq!(result_digest(&result), reference, "{name}: {variant} diverged from process_geometry");
        }
    }
}

/// The filter and quality arguments reach the pass, and the id allow-list keeps
/// the `None` / `Some(empty)` distinction.
#[test]
fn filter_quality_and_ids_reach_the_pass() {
    for (name, content) in all_inputs() {
        let base = process_geometry(&content);
        for mode in [OpeningFilterMode::IgnoreAll, OpeningFilterMode::IgnoreOpaque] {
            let a = process_geometry_filtered(&content, mode);
            let b = process_geometry_streaming_filtered(&content, mode, 5, |_, _, _| {}, |_| {});
            assert_eq!(result_digest(&a), result_digest(&b), "{name}: {mode:?}");
        }
        let q = |quality| {
            result_digest(&process_geometry_filtered_with_quality(&content, OpeningFilterMode::Default, quality))
        };
        let low = q(TessellationQuality::Low);
        let via_options = process_geometry_streaming_filtered_with_options(
            &content,
            OpeningFilterMode::Default,
            StreamingOptions { tessellation_quality: TessellationQuality::Low, ..StreamingOptions::default() },
            |_, _, _| {},
            |_| {},
            |_| {},
        );
        assert_eq!(result_digest(&via_options), low, "{name}: quality via options == via argument");

        let none = process_geometry_filtered_with_quality_and_ids(
            &content, OpeningFilterMode::Default, TessellationQuality::default(), None,
        );
        assert_eq!(result_digest(&none), result_digest(&base), "{name}: None is the unfiltered pass");
        let empty = HashSet::new();
        let nothing = process_geometry_filtered_with_quality_and_ids(
            &content, OpeningFilterMode::Default, TessellationQuality::default(), Some(&empty),
        );
        assert!(nothing.meshes.is_empty(), "{name}: Some(empty) is an active filter that meshes nothing");
        let picked: HashSet<u32> = base.meshes.iter().map(|m| m.express_id).step_by(2).collect();
        let subset = process_geometry_filtered_with_quality_and_ids(
            &content, OpeningFilterMode::Default, TessellationQuality::default(), Some(&picked),
        );
        assert!(
            subset.meshes.iter().all(|m| picked.contains(&m.express_id)),
            "{name}: only allow-listed ids reach the output"
        );
        assert_eq!(subset.meshes.len(), base.meshes.iter().filter(|m| picked.contains(&m.express_id)).count());
    }
}

/// Run the all-features streaming variant and record what its sink saw.
fn traced(content: &[u8], options: StreamingOptions, filter: OpeningFilterMode) -> (ProcessingResult, Vec<Event>, OnceLock<[f64; 16]>) {
    let events = RefCell::new(Vec::new());
    let basis = OnceLock::new();
    let result = process_geometry_streaming_filtered_with_baked_basis(
        content,
        filter,
        options,
        &basis,
        |meshes, processed, total| {
            assert!(basis.get().is_some(), "the baked basis must be published before the first batch");
            events.borrow_mut().push(Event::Batch {
                ids: meshes.iter().map(|m| m.express_id).collect(),
                processed,
                total,
            });
        },
        |updates| events.borrow_mut().push(Event::ColorUpdate(updates.to_vec())),
        |bootstrap| events.borrow_mut().push(Event::bootstrap(bootstrap)),
    );
    (result, events.into_inner(), basis)
}

/// Batch boundaries follow the requested sizes and the event order holds for
/// every configuration the callers use, including the deferred-style one.
#[test]
fn events_follow_the_ordering_contract() {
    let configs: Vec<(&str, StreamingOptions, OpeningFilterMode)> = vec![
        ("default", StreamingOptions::default(), OpeningFilterMode::Default),
        (
            "bootstrap + small batches",
            StreamingOptions {
                initial_batch_size: 1,
                throughput_batch_size: 2,
                emit_quick_metadata_bootstrap: true,
                ..StreamingOptions::default()
            },
            OpeningFilterMode::Default,
        ),
        (
            "deferred styles",
            StreamingOptions {
                fast_first_batch: true,
                include_presentation_layers: false,
                initial_batch_size: 1,
                throughput_batch_size: 1,
                ..StreamingOptions::default()
            },
            OpeningFilterMode::Default,
        ),
        (
            "instancing, not retained",
            StreamingOptions { enable_instancing: true, retain_emitted_meshes: false, ..StreamingOptions::default() },
            OpeningFilterMode::IgnoreOpaque,
        ),
    ];
    let mut saw_bootstrap = false;
    let mut saw_deferred_update = false;
    for (name, content) in all_inputs() {
        for (config, options, filter) in &configs {
            let what = format!("{name} / {config}");
            let (result, events, basis) = traced(&content, options.clone(), *filter);
            assert_ordering_contract(&events, &what);
            saw_bootstrap |= events.iter().any(|e| matches!(e, Event::Bootstrap { .. }));
            saw_deferred_update |= events.iter().any(|e| matches!(e, Event::ColorUpdate(_)));

            // The basis is the frame the result reports, published even for a
            // file with no jobs (the empty model).
            let (x, y, z) = result.frame.rtc_offset();
            let expected = native_to_baked(result.mesh_coordinate_space, result.site_transform.as_deref(), [x, y, z]);
            assert_eq!(basis.get(), Some(&expected), "{what}: baked basis");

            // The emitted chunks are the retained meshes, in order.
            let emitted: Vec<u32> = events
                .iter()
                .filter_map(|e| if let Event::Batch { ids, .. } = e { Some(ids.clone()) } else { None })
                .flatten()
                .collect();
            if options.retain_emitted_meshes {
                let kept: Vec<u32> = result.meshes.iter().map(|m| m.express_id).collect();
                assert_eq!(emitted, kept, "{what}: emitted chunks == retained meshes");
            } else {
                assert!(result.meshes.is_empty(), "{what}: nothing retained");
            }
        }
    }
    assert!(saw_bootstrap, "fixture rot: no configuration produced a bootstrap");
    assert!(saw_deferred_update, "fixture rot: no fixture exercised the deferred-colour replay");
}

/// Events never change the result: the same options with and without a
/// listening sink give one digest (the closures are observers, not inputs).
#[test]
fn observing_events_does_not_change_the_result() {
    for (name, content) in all_inputs() {
        let options = StreamingOptions { emit_quick_metadata_bootstrap: true, ..StreamingOptions::default() };
        let silent = process_geometry_streaming_filtered_with_options(
            &content, OpeningFilterMode::Default, options.clone(), |_, _, _| {}, |_| {}, |_| {},
        );
        let (observed, _, _) = traced(&content, options, OpeningFilterMode::Default);
        assert_eq!(result_digest(&silent), result_digest(&observed), "{name}");
    }
}

/// The builder and the old option struct describe the same request, field for
/// field: a delegate that went through `from_streaming` and a caller that
/// spells the builder cannot disagree.
#[test]
fn builder_and_streaming_options_build_the_same_request() {
    let options = StreamingOptions {
        initial_batch_size: 3,
        throughput_batch_size: 9,
        fast_first_batch: true,
        include_properties: false,
        include_presentation_layers: false,
        emit_quick_metadata_bootstrap: true,
        retain_emitted_meshes: false,
        tessellation_quality: TessellationQuality::High,
        enable_instancing: true,
        ..StreamingOptions::default()
    };
    let from_options = ProcessingRequest::from_streaming(OpeningFilterMode::IgnoreAll, options);
    let from_builder = ProcessingRequest::default()
        .opening_filter(OpeningFilterMode::IgnoreAll)
        .quality(TessellationQuality::High)
        .batching(Batching::new(3, 9).fast_first(true))
        .features(Features::default().properties(false).presentation_layers(false).quick_metadata_bootstrap(true))
        .retain_meshes(false)
        .instancing(true);
    assert_eq!(format!("{from_options:?}"), format!("{from_builder:?}"));

    // The two named shapes differ in chunking and nothing else.
    let full = ProcessingRequest::full_pass();
    assert_eq!(full.batching, Batching::new(usize::MAX, usize::MAX));
    assert_eq!(
        format!("{:?}", full.clone().batching(ProcessingRequest::default().batching)),
        format!("{:?}", ProcessingRequest::default()),
    );
}

/// `process` with a recording sink: the whole contract, the frame event's
/// payload, and the same result as the closure-based entry point.
#[test]
fn process_raises_its_events_in_contract_order() {
    for (name, content) in all_inputs() {
        let request = ProcessingRequest::default()
            .batching(Batching::new(1, 2).fast_first(true))
            .features(Features::default().quick_metadata_bootstrap(true).presentation_layers(false));
        let mut rec = Recorder::default();
        let result = process(&content, &request, &mut rec);
        assert_ordering_contract(&rec.events, &name);

        let frame = rec.frame.unwrap_or_else(|| panic!("{name}: on_frame must fire, also with zero jobs"));
        assert_eq!(frame.frame, result.frame, "{name}: the event carries the result's frame");
        let (x, y, z) = result.frame.rtc_offset();
        assert_eq!(
            frame.baked_basis,
            native_to_baked(result.mesh_coordinate_space, result.site_transform.as_deref(), [x, y, z]),
            "{name}: baked basis"
        );
        assert!(
            rec.events.iter().any(|e| matches!(e, Event::Bootstrap { .. })),
            "{name}: the bootstrap was requested"
        );

        // Same request through the deprecated entry point: same result.
        let legacy = process_geometry_streaming_filtered_with_options(
            &content,
            OpeningFilterMode::Default,
            StreamingOptions {
                initial_batch_size: 1,
                throughput_batch_size: 2,
                fast_first_batch: true,
                include_presentation_layers: false,
                emit_quick_metadata_bootstrap: true,
                ..StreamingOptions::default()
            },
            |_, _, _| {},
            |_| {},
            |_| {},
        );
        assert_eq!(result_digest(&result), result_digest(&legacy), "{name}");

        // A sink that listens to nothing changes nothing.
        let silent = process(&content, &request, &mut ());
        assert_eq!(result_digest(&silent), result_digest(&result), "{name}: () sink");
    }
}

/// A cancel flag raised before the pass starts stops it between chunks: no
/// batch is emitted, the frame still arrives once, and the result is partial.
#[test]
fn a_raised_cancel_flag_emits_no_batches() {
    for (name, content) in all_inputs() {
        let cancel = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let request = ProcessingRequest::full_pass().cancel(cancel);
        let mut rec = Recorder::default();
        let result = process(&content, &request, &mut rec);
        assert!(result.meshes.is_empty(), "{name}: partial result holds no meshes");
        assert!(!rec.events.iter().any(|e| matches!(e, Event::Batch { .. })), "{name}: no batch");
        assert!(rec.frame.is_some(), "{name}: the frame is chosen before the first chunk check");
    }
}

/// The set of `process_geometry*` entry points is closed. A new pass input is a
/// `ProcessingRequest` field and a new output stream a `ProcessingSink` event;
/// a twelfth variant is the shape this refactor removed (C4, #7782).
#[test]
fn no_new_process_geometry_variant() {
    const ALLOWED: &[&str] = &[
        "process_geometry",
        "process_geometry_filtered",
        "process_geometry_filtered_with_quality",
        "process_geometry_filtered_with_quality_and_ids",
        "process_geometry_streaming",
        "process_geometry_streaming_filtered",
        "process_geometry_streaming_filtered_with_baked_basis",
        "process_geometry_streaming_filtered_with_options",
        "process_geometry_streaming_with_options",
        "process_geometry_streaming_with_options_and_bootstrap",
        "process_geometry_with_index",
    ];
    let mut found = Vec::new();
    let mut stack = vec![std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src")];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).expect("read src") {
            let path = entry.expect("dir entry").path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|e| e == "rs") {
                let text = std::fs::read_to_string(&path).expect("read source");
                for line in text.lines() {
                    if let Some(rest) = line.trim_start().strip_prefix("pub fn process_geometry") {
                        let tail: String =
                            rest.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
                        found.push(format!("process_geometry{tail}"));
                    }
                }
            }
        }
    }
    found.sort();
    found.dedup();
    let unexpected: Vec<&String> = found.iter().filter(|f| !ALLOWED.contains(&f.as_str())).collect();
    assert!(
        unexpected.is_empty(),
        "new public entry point(s) {unexpected:?}: add a `ProcessingRequest` field or a \
         `ProcessingSink` event and call `process`, instead of another `process_geometry_*`"
    );
    assert_eq!(found.len(), ALLOWED.len(), "fixture rot: an allowed entry point is gone or this scan missed it");
}
