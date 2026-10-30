// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! C4-0 (#7782): the native/browser parity gate.
//!
//! The same committed IFC bytes go through the native `process` pass and the
//! browser once-path (`buildPrePassOnce` + `processGeometryBatch`, executed
//! natively through the `batch_host` seam: geometry, caches and diagnostic
//! draining never depend on the host). Every difference the comparators in
//! `batch_parity_compare_tests.rs` find is keyed `(fixture, axis, element)`,
//! and that set must equal [`EXPECTED_DIFF`] EXACTLY: a new difference fails
//! the gate, and so does a row nothing produces any more (the slice that
//! removes a difference deletes its row in the same change).
//!
//! `EXPECTED_DIFF` has no wildcard. Each row names its fixture, axis and
//! element, why the pipelines differ there, and the charter item that
//! removes it.
//!
//! CI (`rust-tests`) runs this under `cargo nextest`, then once more with its
//! report published to the job summary (`IFC_LITE_C4_0_PARITY_REPORT`).
//!
//! Scope, deliberately: the `buildPrePassOnce` wire only (not the streaming
//! or sharded pre-pass discovery, which is where load-time disabled types
//! and deferred style replacement live), unarmed batches (the once path
//! installs no don't-bake plan), and no browser wall time, memory or real
//! WASM execution.

#[path = "batch_parity_compare_tests.rs"]
mod compare;
#[path = "batch_parity_evidence_tests.rs"]
mod evidence;
#[path = "batch_parity_observe_tests.rs"]
mod observe;
#[path = "batch_parity_plan_tests.rs"]
mod plan;

#[allow(dead_code)]// Shared entry-point helper also serves processing sink tests.
#[path = "../../../../processing/tests/common/entry_trace.rs"]
mod entry_trace;

use compare::{Axis, Drift};
use std::collections::{BTreeMap, BTreeSet};

// A test-only tap at the actual pre-mesh job boundary; no duplicate planner.
// The native scanner schedules one job per orphan map, whereas the browser
// wire schedules one type product and expands it here. Compare expanded units.
type PlannedJob = (u32, Option<u32>, u8);
thread_local! {
    static JOB_TRACE: std::cell::RefCell<Option<Vec<PlannedJob>>> = const { std::cell::RefCell::new(None) };
}

pub(in crate::api::gpu_meshes) fn record_job(id: u32, kind: &ifc_lite_processing::element::ElementJobKind) {
    JOB_TRACE.with_borrow_mut(|slot| {
        if let Some(jobs) = slot {
            match kind {
                ifc_lite_processing::element::ElementJobKind::Product => jobs.push((id, None, 0)),
                ifc_lite_processing::element::ElementJobKind::TypeProduct { rep_maps } => {
                    jobs.extend(rep_maps.iter().map(|&(map, class)| (id, Some(map), class)))
                }
            }
        }
    });
}

fn browser_job_units(browser: &observe::BrowserLoad) -> BTreeMap<u32, usize> {
    let mut units = BTreeMap::new();
    for &(id, _, _) in browser.batches.iter().flat_map(|b| &b.planned_jobs) {
        *units.entry(id).or_default() += 1;
    }
    units
}

/// One committed fixture, with an element native must draw, so a fixture
/// cannot pass by producing nothing on either side.
struct Fixture {
    path: &'static str,
    anchor: u32,
}

const MULTICOLOR: &str = "../processing/tests/fixtures/issue_6601_multicolor_element.ifc";
const TYPE_MODES: &str = "../processing/tests/fixtures/c4_type_geometry_modes_7782.ifc";
const LAYERS: &str = "../processing/tests/fixtures/c4_native_unsliced_layers_7782.ifc";
const BARE_TYPE_MAP: &str = "../processing/tests/fixtures/c4_bare_type_map_7782.ifc";
const TEXTURES: &str = "../processing/tests/fixtures/issue_1781_image_textures.ifc";
const REFUSALS: &str = "../processing/tests/fixtures/c4_0_refusal_parity_7782.ifc";

const FIXTURES: &[Fixture] = &[
    // The six the C4 boundary audit named first.
    Fixture {
        path: MULTICOLOR,
        anchor: 23,
    },
    Fixture {
        path: "../processing/tests/fixtures/issue_2019_wall_two_overlapping_openings.ifc",
        anchor: 30,
    },
    Fixture {
        path: "../processing/tests/fixtures/issue_3641_voiding_trap.ifc",
        anchor: 72209,
    },
    Fixture {
        path: "../geometry/tests/fixtures/issue_1910_building_shell_geometry.ifc",
        anchor: 40,
    },
    Fixture {
        path: "../geometry/tests/fixtures/issue_4560_wall_roof_polygonal_cutters.ifc",
        anchor: 1216,
    },
    Fixture {
        path: "../geometry/tests/fixtures/mapped_instances_synthetic.ifc",
        anchor: 31,
    },
    // Indexed colour, with and without an authored second palette member.
    Fixture {
        path: "../geometry/tests/fixtures/mapped_instances_indexed_colour.ifc",
        anchor: 56,
    },
    Fixture {
        path: "../geometry/tests/fixtures/mapped_instances_indexed_colour_uniform.ifc",
        anchor: 56,
    },
    // Site-placed models: the native site tier against the browser's world axes.
    Fixture {
        path: "../geometry/tests/fixtures/mapped_instances_site_translated.ifc",
        anchor: 33,
    },
    Fixture {
        path: "../geometry/tests/fixtures/mapped_instances_site_rotated.ifc",
        anchor: 33,
    },
    // Orphan (class 1) and instantiated (class 2) type maps, listed maps.
    Fixture {
        path: TYPE_MODES,
        anchor: 31,
    },
    // A bare (unlisted) RepresentationMaps reference on an orphan type.
    Fixture {
        path: BARE_TYPE_MAP,
        anchor: 43,
    },
    // A sliceable three-layer wall.
    Fixture {
        path: LAYERS,
        anchor: 100,
    },
    // Image textures and UV maps.
    Fixture {
        path: TEXTURES,
        anchor: 10,
    },
    // Two products sharing one strict-real-refused extrusion, a valid neighbour.
    Fixture {
        path: REFUSALS,
        anchor: 300,
    },
];

// Every exception binds the complete measured payloads and requires a reason.
// Removing drift makes its row stale; changing it fails even at the same key.
const EXPECTED_DIFF: &str = include_str!("batch_parity_expected.json");

#[path = "batch_parity_controls_tests.rs"]
mod controls;
#[path = "batch_parity_gate_tests.rs"]
mod gate;

fn short(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// Element ids the wire submits as type-product jobs.
fn type_jobs(prepass: &super::super::prepass_once::PrepassOnceData) -> BTreeSet<u32> {
    prepass
        .simple_jobs
        .iter()
        .chain(&prepass.complex_jobs)
        .filter(|job| job.3.is_subtype_of(ifc_lite_core::IfcType::IfcTypeProduct))
        .map(|job| job.0)
        .collect()
}

/// Every axis over one fixture.
fn observe_fixture(
    fixture: &Fixture,
    frames: &mut BTreeMap<&'static str, String>,
    observations: &mut BTreeMap<&'static str, serde_json::Value>,
) -> Vec<Drift> {
    let name = short(fixture.path);
    let content = observe::fixture(fixture.path);
    let native = observe::native(&content);
    let planned_native = ifc_lite_processing::parity_test_support::take_jobs();
    let browser = observe::browser_cold(&content);

    // Only the native side is asserted: an anchor the browser misses (in
    // discovery or in meshing) is an `ElementSet` difference, which the gate
    // then requires a row for.
    assert!(
        native
            .meshes
            .iter()
            .any(|m| m.express_id == fixture.anchor && !m.indices.is_empty()),
        "{name}: native does not draw #{}",
        fixture.anchor
    );

    let mut drifts = Vec::new();
    plan::compare(
        name,
        &planned_native,
        &browser
            .batches
            .iter()
            .flat_map(|b| b.planned_jobs.iter().copied())
            .collect::<Vec<_>>(),
        &mut drifts,
    );
    plan::units(
        name,
        native.metadata.length_unit_refused,
        &browser.prepass.meta,
        &mut drifts,
    );
    let native_frame = native.frame;
    let browser_frame = browser.prepass.meta.frame;
    frames.insert(
        name,
        format!("native {native_frame:?} / browser {browser_frame:?}"),
    );
    let normalized = compare::frame_rule(name, native_frame, browser_frame, &mut drifts)
        .then_some((native_frame, browser_frame));

    let native_meshes: Vec<_> = native.meshes.iter().collect();
    let native_jobs = observe::native_jobs(&content, &native, &browser.prepass);
    let browser_jobs = browser_job_units(&browser);
    compare::type_coverage(
        name,
        &native_meshes,
        &browser.meshes().collect::<Vec<_>>(),
        &native_jobs,
        &browser_jobs,
        &mut drifts,
    );
    let browser_meshes = compare::apply_type_geometry_rule(
        name,
        browser.meshes().collect(),
        &native_meshes,
        &type_jobs(&browser.prepass),
        &mut drifts,
    );
    compare::compare_meshes(
        name,
        &native_meshes,
        &browser_meshes,
        normalized,
        &mut drifts,
    );
    compare::compare_diagnostics(
        name,
        native.stats.geometry_diagnostics.as_ref(),
        &browser
            .batches
            .first()
            .map(|b| b.diagnostics.clone())
            .unwrap_or_default(),
        &mut drifts,
    );
    compare::compare_refusals(
        name,
        (
            native.stats.refused_input_elements,
            native.stats.refused_prepass_records,
        ),
        browser.pipeline.as_ref(),
        &mut drifts,
    );

    if fixture.path == REFUSALS {
        assert_refusal_fixture(&content, &native, &browser);
    }
    observations.insert(name, serde_json::json!({
        "bindings": drifts.iter().map(|d| evidence::binding(&native_meshes, &browser.meshes().collect::<Vec<_>>(), d)).collect::<Vec<_>>(),
    }));
    drifts
}

/// #7782/C40-R5: each of two attempted jobs reaches the same refused leaf.
/// Native prepass totals are a per-load union, unchanged by selection, NEVER
/// the sum of the two full-prepass probes. Browser counters, currently absent,
/// are left absent and reported as drift; geometry cannot manufacture them.
fn assert_refusal_fixture(
    content: &[u8],
    native: &ifc_lite_processing::ProcessingResult,
    cold: &observe::BrowserLoad,
) {
    assert_eq!(
        native.stats.refused_input_elements, 2,
        "two refused attempts, one shared bad leaf"
    );
    for id in [100, 200] {
        let selected = observe::native_selected(content, id);
        assert_eq!(selected.metadata.geometry_entity_count, 1);
        assert_eq!(selected.stats.refused_input_elements, 1);
        assert_eq!(
            selected.stats.refused_prepass_records, native.stats.refused_prepass_records,
            "selection does not repeat distinct prepass records"
        );
        assert!(selected.meshes.is_empty());
    }
    for (leg, repetitions) in [(cold, 1)] {
        for id in [100, 200, 300] {
            assert_eq!(
                leg.batches
                    .iter()
                    .flat_map(|b| &b.jobs)
                    .filter(|&&j| j == id)
                    .count(),
                repetitions
            );
        }
        assert!(leg
            .meshes()
            .any(|m| m.express_id == 300 && !m.indices.is_empty()));
        assert!(!leg
            .meshes()
            .any(|m| [100, 200].contains(&m.express_id) && !m.indices.is_empty()));
    }
}

#[test]
fn c4_0_native_browser_parity() {
    let mut frames = BTreeMap::new();
    let mut observations = BTreeMap::new();
    let mut observed: Vec<Drift> = FIXTURES
        .iter()
        .flat_map(|f| observe_fixture(f, &mut frames, &mut observations))
        .collect();
    observed.sort();
    let bindings: Vec<_> = observations
        .values()
        .flat_map(|o| o["bindings"].as_array().unwrap().iter().cloned())
        .collect();
    let expected: Vec<serde_json::Value> = serde_json::from_str(EXPECTED_DIFF).unwrap();
    let failures = gate::reconcile(&bindings, &expected);
    let report = serde_json::json!({ "fixtures": frames.len(), "frames": frames,
        "observedDifferences": bindings, "expectedDifferences": expected,
        "failures": failures });
    if let Ok(path) = std::env::var("IFC_LITE_C4_0_BINDINGS_REPORT") {
        std::fs::write(path, serde_json::to_string_pretty(&bindings).unwrap()).unwrap();
    }
    if let Ok(path) = std::env::var("IFC_LITE_C4_0_PARITY_REPORT") {
        std::fs::write(
            path,
            format!(
                "# C4-0 parity (#7782)\n\n```json\n{}\n```\n",
                serde_json::to_string_pretty(&report).unwrap()
            ),
        )
        .unwrap();
    }
    for (fixture, observation) in &observations {
        eprintln!(
            "C4-0 {fixture}: {} differences, full payloads compared",
            observation["bindings"].as_array().unwrap().len()
        );
    }
    eprintln!(
        "C4-0 bindings: {}",
        serde_json::to_string(&bindings).unwrap()
    );
    assert!(failures.is_empty(), "C4-0 full payload gate: {failures:#?}");
}

#[test]
fn every_expected_row_names_a_gated_fixture_and_reason_7782() {
    let gated: BTreeSet<&str> = FIXTURES.iter().map(|f| short(f.path)).collect();
    let expected: Vec<serde_json::Value> = serde_json::from_str(EXPECTED_DIFF).unwrap();
    for row in expected {
        assert!(gated.contains(row["evidence"]["fixture"].as_str().unwrap()));
        for key in ["owner", "reason", "resolution"] {
            assert!(!row[key].as_str().unwrap().trim().is_empty());
        }
    }
}

#[test]
fn deleting_instantiated_browser_job_or_output_fails_coverage_7782() {
    let content = observe::fixture(TYPE_MODES);
    let native = observe::native(&content);
    let browser = observe::browser_cold(&content);
    let native_jobs = observe::native_jobs(&content, &native, &browser.prepass);
    let browser_jobs: BTreeMap<_, _> = browser
        .prepass
        .simple_jobs
        .iter()
        .chain(&browser.prepass.complex_jobs)
        .map(|j| (j.0, 1usize))
        .collect();
    let native_meshes: Vec<_> = native.meshes.iter().collect();
    let browser_meshes: Vec<_> = browser.meshes().collect();
    let check = |jobs: &BTreeMap<u32, usize>, meshes: &[&ifc_lite_processing::MeshData]| {
        let mut drifts = Vec::new();
        compare::type_coverage(
            short(TYPE_MODES),
            &native_meshes,
            meshes,
            &native_jobs,
            jobs,
            &mut drifts,
        );
        drifts
    };
    assert!(check(&browser_jobs, &browser_meshes).is_empty());
    let missing_output: Vec<_> = browser_meshes
        .iter()
        .copied()
        .filter(|m| m.express_id != 101)
        .collect();
    let mut missing_job = browser_jobs.clone();
    assert!(missing_job.remove(&101).is_some());
    for drifts in [
        check(&browser_jobs, &missing_output),
        check(&missing_job, &browser_meshes),
        check(&missing_job, &missing_output),
    ] {
        assert!(drifts
            .iter()
            .any(|d| d.axis == Axis::TypeGeometry && d.element == Some(101)));
    }
}

#[test]
fn c4_d66_opt_in_layer_payloads_match_browser_7782() {
    let content = observe::fixture(LAYERS);
    let browser = observe::browser_cold(&content);
    let native = ifc_lite_processing::process(
        &content,
        &ifc_lite_processing::ProcessingRequest::full_pass().layer_slicing(true),
        &mut (),
    );
    let expected: Vec<_> = browser.meshes().collect();
    let actual: Vec<_> = native.meshes.iter().collect();
    assert_eq!(expected.iter().filter(|m| m.express_id == 100).count(), 3);
    // Use the C4-0 geometry/appearance contract: the browser obtains element
    // names, GlobalIds and properties from its parser worker, not this batch.
    // Keep per-element submesh order and every geometry/appearance axis intact.
    let mut drifts = Vec::new();
    let normalized = compare::frame_rule(
        short(LAYERS), native.frame, browser.prepass.meta.frame, &mut drifts,
    ).then_some((native.frame, browser.prepass.meta.frame));
    compare::compare_meshes(short(LAYERS), &actual, &expected, normalized, &mut drifts);
    assert!(drifts.is_empty(), "D66 opt-in geometry/appearance drift: {drifts:#?}");
}
