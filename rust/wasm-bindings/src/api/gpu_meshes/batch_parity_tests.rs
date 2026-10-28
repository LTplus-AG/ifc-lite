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

use compare::{Axis, Drift};
use std::collections::{BTreeMap, BTreeSet};

// A test-only tap at the actual pre-mesh job boundary; no duplicate planner.
// The native scanner schedules one job per orphan map, whereas the browser
// wire schedules one type product and expands it here. Compare expanded units.
type PlannedJob = (u32, Option<u32>, u8);
thread_local! {
    static JOB_TRACE: std::cell::RefCell<Option<Vec<PlannedJob>>> = const { std::cell::RefCell::new(None) };
}

pub(super) fn record_job(id: u32, kind: &ifc_lite_processing::element::ElementJobKind) {
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

/// A difference the gate expects, and must keep seeing until `removed_by`
/// lands and deletes this row.
struct Expected {
    fixture: &'static str,
    axis: Axis,
    element: Option<u32>,
    reason: &'static str,
    removed_by: &'static str,
}

// C40-R1: measured at 61e56d289f (15 fixtures / 28 differences), after
// merging main f5d871ffc1 without changing any producer/fixture/comparator.
// Only proven defects with an approved removal item are bound. The other
// 11 keys remain UNEXPECTED: map-vs-type job multiplicity (3), material
// names lost by the RGBA wire (2), rotated-site local bounds (4), and layers
// (MeshHash + Color). These need contract/ownership review, not blanket rows.
// D66 preserves native-unsliced output by default: C4-10a's dead-build
// removal does not remove that layer drift. C4-9's strict zero-Color gate
// remains blocked even though all four layer RGBA8 values are identical.
const EXPECTED_DIFF: &[Expected] = &[
    Expected {
        fixture: "c4_0_refusal_parity_7782.ifc", axis: Axis::RefusalCounters, element: None,
        reason: "PipelineDiagnostics has neither refusal field; absent is not zero (pipeline_diagnostics.rs, compare_refusals)",
        removed_by: "C4-10a: report attempted input refusals and distinct prepass refusals in the browser schema",
    },
    Expected {
        fixture: "c4_bare_type_map_7782.ifc", axis: Axis::RefusalCounters, element: None,
        reason: "Bare #44 is undiscovered, so there is no browser batch/accumulator; even after discovery is fixed the schema lacks both refusal fields",
        removed_by: "C4-10a refusal schema/accounting after C4-7a restores the #43 batch; missing stays distinct from zero",
    },
    Expected {
        fixture: "c4_native_unsliced_layers_7782.ifc", axis: Axis::RefusalCounters, element: None,
        reason: "PipelineDiagnostics has neither refusal field; absent is not zero (pipeline_diagnostics.rs, compare_refusals)",
        removed_by: "C4-10a: report attempted input refusals and distinct prepass refusals in the browser schema",
    },
    Expected {
        fixture: "c4_type_geometry_modes_7782.ifc", axis: Axis::RefusalCounters, element: None,
        reason: "PipelineDiagnostics has neither refusal field; absent is not zero (pipeline_diagnostics.rs, compare_refusals)",
        removed_by: "C4-10a: report attempted input refusals and distinct prepass refusals in the browser schema",
    },
    Expected {
        fixture: "issue_1781_image_textures.ifc", axis: Axis::RefusalCounters, element: None,
        reason: "PipelineDiagnostics has neither refusal field; absent is not zero (pipeline_diagnostics.rs, compare_refusals)",
        removed_by: "C4-10a: report attempted input refusals and distinct prepass refusals in the browser schema",
    },
    Expected {
        fixture: "issue_1910_building_shell_geometry.ifc", axis: Axis::RefusalCounters, element: None,
        reason: "PipelineDiagnostics has neither refusal field; absent is not zero (pipeline_diagnostics.rs, compare_refusals)",
        removed_by: "C4-10a: report attempted input refusals and distinct prepass refusals in the browser schema",
    },
    Expected {
        fixture: "issue_2019_wall_two_overlapping_openings.ifc", axis: Axis::RefusalCounters, element: None,
        reason: "PipelineDiagnostics has neither refusal field; absent is not zero (pipeline_diagnostics.rs, compare_refusals)",
        removed_by: "C4-10a: report attempted input refusals and distinct prepass refusals in the browser schema",
    },
    Expected {
        fixture: "issue_3641_voiding_trap.ifc", axis: Axis::RefusalCounters, element: None,
        reason: "PipelineDiagnostics has neither refusal field; absent is not zero (pipeline_diagnostics.rs, compare_refusals)",
        removed_by: "C4-10a: report attempted input refusals and distinct prepass refusals in the browser schema",
    },
    Expected {
        fixture: "issue_4560_wall_roof_polygonal_cutters.ifc", axis: Axis::RefusalCounters, element: None,
        reason: "PipelineDiagnostics has neither refusal field; absent is not zero (pipeline_diagnostics.rs, compare_refusals)",
        removed_by: "C4-10a: report attempted input refusals and distinct prepass refusals in the browser schema",
    },
    Expected {
        fixture: "issue_6601_multicolor_element.ifc", axis: Axis::RefusalCounters, element: None,
        reason: "PipelineDiagnostics has neither refusal field; absent is not zero (pipeline_diagnostics.rs, compare_refusals)",
        removed_by: "C4-10a: report attempted input refusals and distinct prepass refusals in the browser schema",
    },
    Expected {
        fixture: "mapped_instances_indexed_colour.ifc", axis: Axis::RefusalCounters, element: None,
        reason: "PipelineDiagnostics has neither refusal field; absent is not zero (pipeline_diagnostics.rs, compare_refusals)",
        removed_by: "C4-10a: report attempted input refusals and distinct prepass refusals in the browser schema",
    },
    Expected {
        fixture: "mapped_instances_indexed_colour_uniform.ifc", axis: Axis::RefusalCounters, element: None,
        reason: "PipelineDiagnostics has neither refusal field; absent is not zero (pipeline_diagnostics.rs, compare_refusals)",
        removed_by: "C4-10a: report attempted input refusals and distinct prepass refusals in the browser schema",
    },
    Expected {
        fixture: "mapped_instances_site_rotated.ifc", axis: Axis::RefusalCounters, element: None,
        reason: "PipelineDiagnostics has neither refusal field; absent is not zero (pipeline_diagnostics.rs, compare_refusals)",
        removed_by: "C4-10a: report attempted input refusals and distinct prepass refusals in the browser schema",
    },
    Expected {
        fixture: "mapped_instances_site_translated.ifc", axis: Axis::RefusalCounters, element: None,
        reason: "PipelineDiagnostics has neither refusal field; absent is not zero (pipeline_diagnostics.rs, compare_refusals)",
        removed_by: "C4-10a: report attempted input refusals and distinct prepass refusals in the browser schema",
    },
    Expected {
        fixture: "mapped_instances_synthetic.ifc", axis: Axis::RefusalCounters, element: None,
        reason: "PipelineDiagnostics has neither refusal field; absent is not zero (pipeline_diagnostics.rs, compare_refusals)",
        removed_by: "C4-10a: report attempted input refusals and distinct prepass refusals in the browser schema",
    },
    Expected {
        fixture: "c4_bare_type_map_7782.ifc", axis: Axis::ElementSet, element: Some(43),
        reason: "Native record_refs_at accepts bare #44; browser type discovery/batch as_list rejects it, so #43 is neither scheduled nor drawn",
        removed_by: "C4-7a: shared bare-or-list RepresentationMaps reader; delete this measured row when fixed",
    },
    Expected {
        fixture: "c4_bare_type_map_7782.ifc", axis: Axis::JobSet, element: Some(43),
        reason: "Native record_refs_at accepts bare #44; browser type discovery/batch as_list rejects it, so #43 is neither scheduled nor drawn",
        removed_by: "C4-7a: shared bare-or-list RepresentationMaps reader; delete this measured row when fixed",
    },
];

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

    let warm = observe::browser_warm(&content);
    let split = observe::browser_split(&content);
    let preload = observe::fixture(if fixture.path == TYPE_MODES {
        MULTICOLOR
    } else {
        TYPE_MODES
    });
    let (previous, reload) = observe::browser_reloaded(&preload, &content);
    let previous_cold = observe::browser_cold(&preload);
    compare::compare_lifecycle(
        name,
        Axis::ReloadDiagnostics,
        &previous_cold,
        &previous,
        &mut drifts,
    );
    let cold = compare::payload(&browser.outputs);
    for (axis, diag_axis, leg) in [
        (Axis::Warm, Axis::WarmDiagnostics, &warm),
        (Axis::Split, Axis::SplitDiagnostics, &split),
        (Axis::Reload, Axis::ReloadDiagnostics, &reload),
    ] {
        if let Some(detail) = compare::payload_divergence(&cold, &compare::payload(&leg.outputs)) {
            drifts.push(Drift {
                fixture: name,
                axis,
                element: None,
                detail,
            });
        }
        compare::compare_lifecycle(name, diag_axis, &browser, leg, &mut drifts);
    }
    if fixture.path == REFUSALS {
        assert_refusal_fixture(&content, &native, &browser, &warm, &split, &reload);
    }
    observations.insert(name, serde_json::json!({
        "bindings": drifts.iter().map(|d| evidence::binding(&native_meshes, &browser_meshes, d)).collect::<Vec<_>>(),
        "selectedMeshEvidence": evidence::selected(&native_meshes, &browser_meshes, &drifts),
        "nativeJobs": native_jobs, "browserJobs": browser_jobs,
        "nativeClasses": native.meshes.iter().map(|m| (m.express_id, m.geometry_class)).collect::<Vec<_>>(),
        "browserDiscoveryTypes": browser.prepass.simple_jobs.iter().chain(&browser.prepass.complex_jobs)
            .map(|j| (j.0, format!("{:?}", j.3))).collect::<Vec<_>>(),
        "nativeRefusedInputElements": native.stats.refused_input_elements,
        "nativeRefusedPrepassRecords": native.stats.refused_prepass_records,
        "cold": load_evidence(&browser), "warm": load_evidence(&warm),
        "split": load_evidence(&split), "previous": load_evidence(&previous), "reload": load_evidence(&reload),
    }));
    compare::compare_adapters(
        name,
        observe::adapter_ids(&content),
        browser.meshes().count(),
        &mut drifts,
    );
    drifts
}

/// Evidence includes every batch drain/snapshot and operational counters;
/// comparison exclusions never make those observations disappear.
fn load_evidence(load: &observe::BrowserLoad) -> serde_json::Value {
    serde_json::json!({
        "classes": load.meshes().map(|m| (m.express_id, m.geometry_class)).collect::<Vec<_>>(),
        "pipeline": load.pipeline, "coldPrefixPipelines": load.cold_prefix_pipelines,
        "batches": load.batches.iter().map(|b| serde_json::json!({
            "jobs": b.jobs, "plannedJobs": b.planned_jobs, "outputCounts": b.output_counts, "diagnostics": b.diagnostics, "pipeline": b.pipeline,
        })).collect::<Vec<_>>(),
    })
}

/// #7782/C40-R5: each of two attempted jobs reaches the same refused leaf.
/// Native prepass totals are a per-load union, unchanged by selection, NEVER
/// the sum of the two full-prepass probes. Browser counters, currently absent,
/// are left absent and reported as drift; geometry cannot manufacture them.
fn assert_refusal_fixture(
    content: &[u8],
    native: &ifc_lite_processing::ProcessingResult,
    cold: &observe::BrowserLoad,
    warm: &observe::BrowserLoad,
    split: &observe::BrowserLoad,
    reload: &observe::BrowserLoad,
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
    for (leg, repetitions) in [(cold, 1), (warm, 2), (split, 1), (reload, 1)] {
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

type Key = (&'static str, Axis, Option<u32>);

/// `(unexpected, stale)`: observed keys with no row, rows nothing observed.
fn reconcile(observed: &[Drift], expected: &[Expected]) -> (Vec<Key>, Vec<Key>) {
    let seen: BTreeSet<Key> = observed.iter().map(Drift::key).collect();
    let rows: BTreeSet<Key> = expected
        .iter()
        .map(|e| (e.fixture, e.axis, e.element))
        .collect();
    assert_eq!(
        rows.len(),
        expected.len(),
        "EXPECTED_DIFF lists a key twice"
    );
    (
        seen.difference(&rows).copied().collect(),
        rows.difference(&seen).copied().collect(),
    )
}

fn report(
    frames: &BTreeMap<&'static str, String>,
    observed: &[Drift],
    unexpected: &[Key],
    stale: &[Key],
) -> String {
    use std::fmt::Write;
    let mut out = String::new();
    let verdict = if unexpected.is_empty() && stale.is_empty() {
        "PASS"
    } else {
        "FAIL"
    };
    let _ = writeln!(out, "## C4-0 native/browser parity (#7782): {verdict}\n");
    let _ = writeln!(
        out,
        "{} fixtures, {} observed difference(s), {} expected row(s), {} unexpected, {} stale.\n",
        frames.len(),
        observed.len(),
        EXPECTED_DIFF.len(),
        unexpected.len(),
        stale.len()
    );
    let _ = writeln!(
        out,
        "| fixture | axis | element | status | reason / evidence | removed by |"
    );
    let _ = writeln!(out, "|---|---|---|---|---|---|");
    let row_for = |key: &Key| {
        EXPECTED_DIFF
            .iter()
            .find(|e| (e.fixture, e.axis, e.element) == *key)
    };
    for d in observed {
        let (status, reason, removed_by) = match row_for(&d.key()) {
            Some(e) => (
                "expected",
                format!("{} ({})", e.reason, d.detail),
                e.removed_by,
            ),
            None => ("UNEXPECTED", d.detail.clone(), "-"),
        };
        let element = d.element.map_or("-".to_string(), |id| format!("#{id}"));
        let reason = reason.replace('|', "\\|");
        let _ = writeln!(
            out,
            "| {} | {:?} | {element} | {status} | {reason} | {removed_by} |",
            d.fixture, d.axis
        );
    }
    for key in stale {
        let e = row_for(key).expect("a stale key is a row");
        let element = e.element.map_or("-".to_string(), |id| format!("#{id}"));
        let _ = writeln!(
            out,
            "| {} | {:?} | {element} | STALE (no longer observed: delete the row) | {} | {} |",
            e.fixture, e.axis, e.reason, e.removed_by
        );
    }
    let _ = writeln!(out, "\n### Frames\n");
    for (fixture, frame) in frames {
        let _ = writeln!(out, "- {fixture}: {frame}");
    }
    out
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
    let (unexpected, stale) = reconcile(&observed, EXPECTED_DIFF);
    let bindings: Vec<_> = observations
        .values()
        .flat_map(|o| o["bindings"].as_array().unwrap().iter().cloned())
        .collect();
    if let Ok(path) = std::env::var("IFC_LITE_C4_0_BINDINGS_REPORT") {
        std::fs::write(path, serde_json::to_string_pretty(&bindings).unwrap()).unwrap();
    }
    let expected: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("batch_parity_expected.json")).unwrap();
    let expected_values: Vec<_> = expected.iter().map(|row| row["evidence"].clone()).collect();

    let mut text = report(&frames, &observed, &unexpected, &stale);
    text.push_str("\n### Complete observations (including operational counters)\n\n```json\n");
    text.push_str(&serde_json::to_string_pretty(&observations).unwrap());
    text.push_str("\n```\n");
    eprintln!("{text}");
    if let Some(path) = std::env::var_os("IFC_LITE_C4_0_PARITY_REPORT") {
        std::fs::write(&path, &text).unwrap_or_else(|err| panic!("write the parity report: {err}"));
    }
    assert_eq!(
        bindings, expected_values,
        "C4-0 full payload binding changed; new, changed and stale exceptions all fail"
    );
    assert!(
        unexpected.is_empty() && stale.is_empty(),
        "native/browser parity drifted from EXPECTED_DIFF: unexpected {unexpected:?}, stale {stale:?} (full report above)"
    );
}

#[test]
fn every_expected_row_names_a_gated_fixture_and_its_removal() {
    let gated: BTreeSet<&str> = FIXTURES.iter().map(|f| short(f.path)).collect();
    for e in EXPECTED_DIFF {
        assert!(
            gated.contains(e.fixture),
            "row for ungated fixture {}",
            e.fixture
        );
        assert!(
            !e.reason.trim().is_empty() && !e.removed_by.trim().is_empty(),
            "{:?} row needs a reason and a removal",
            e.axis
        );
    }
}

#[test]
fn reconciliation_fails_on_new_and_on_stale_rows() {
    let drift = |fixture, element| Drift {
        fixture,
        axis: Axis::MeshHash,
        element,
        detail: String::new(),
    };
    let row = |fixture, element| Expected {
        fixture,
        axis: Axis::MeshHash,
        element,
        reason: "r",
        removed_by: "x",
    };
    let (unexpected, stale) = reconcile(
        &[drift("a", Some(1)), drift("b", None)],
        &[row("a", Some(1)), row("c", Some(2))],
    );
    assert_eq!(
        unexpected,
        [("b", Axis::MeshHash, None)],
        "a new difference is not covered"
    );
    assert_eq!(
        stale,
        [("c", Axis::MeshHash, Some(2))],
        "a row nothing produces is stale"
    );
}

#[test]
#[should_panic(expected = "EXPECTED_DIFF lists a key twice")]
fn reconciliation_rejects_duplicate_rows_7782() {
    let row = || Expected {
        fixture: "a",
        axis: Axis::MeshHash,
        element: None,
        reason: "r",
        removed_by: "C4-0",
    };
    reconcile(&[], &[row(), row()]);
}

#[test]
fn zero_job_load_has_no_batch_or_diagnostic_across_lifecycles_7782() {
    // A real IFC with project metadata but no geometric products.
    let content = b"ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;ENDSEC;END-ISO-10303-21;";
    let previous = observe::fixture(TYPE_MODES);
    for load in [
        observe::browser_cold(content),
        observe::browser_warm(content),
        observe::browser_split(content),
        observe::browser_reloaded(&previous, content).1,
    ] {
        assert_eq!(load.prepass.total_jobs(), 0);
        assert!(load.outputs.is_empty() && load.batches.is_empty() && load.pipeline.is_none());
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
fn diagnostic_only_loss_fails_lifecycle_with_identical_geometry_7782() {
    let content = observe::fixture(
        "../processing/tests/fixtures/issue_2019_wall_two_overlapping_openings.ifc",
    );
    let cold = observe::browser_cold(&content);
    let mut warm = observe::browser_warm(&content);
    assert!(
        compare::lifecycle_differences(&cold, &warm, true).is_empty(),
        "unmutated lifecycle control"
    );
    let before = compare::payload(&warm.outputs);
    assert!(
        warm.batches[1].diagnostics.hosts_with_openings > 0,
        "real diagnostic anchor"
    );
    warm.batches[1].diagnostics.hosts_with_openings = 0;
    assert_eq!(before, compare::payload(&warm.outputs));
    assert!(!compare::lifecycle_differences(&cold, &warm, true).is_empty());
    // Accumulator-only loss is independently visible, even if all drains are intact.
    let mut reload = observe::browser_reloaded(&observe::fixture(TYPE_MODES), &content).1;
    assert!(
        compare::lifecycle_differences(&cold, &reload, false).is_empty(),
        "unmutated reload control"
    );
    let before = compare::payload(&reload.outputs);
    reload
        .pipeline
        .as_mut()
        .unwrap()
        .as_object_mut()
        .unwrap()
        .remove("totalCsgFailures");
    assert_eq!(before, compare::payload(&reload.outputs));
    assert!(!compare::lifecycle_differences(&cold, &reload, false).is_empty());
}

#[test]
fn first_warm_complete_drain_mutations_fail_without_mesh_changes_7782_r5() {
    let content = observe::fixture(
        "../processing/tests/fixtures/issue_2019_wall_two_overlapping_openings.ifc",
    );
    let cold = observe::browser_cold(&content);
    let mut warm = observe::browser_warm(&content);
    assert!(
        compare::lifecycle_differences(&cold, &warm, true).is_empty(),
        "unmutated lifecycle control"
    );
    let payload = compare::payload(&warm.outputs);
    let original = warm.batches[0].diagnostics.clone();
    let mut mutations = Vec::new();
    let mut classification = serde_json::to_value(&original).unwrap();
    let total = classification["classification"]["total"].as_u64().unwrap();
    classification["classification"]["total"] = (total + 1).into();
    mutations.push(classification);
    for (key, detail) in [
        (
            "unsupportedItemsByType",
            serde_json::json!({"reason": "IfcTextLiteral", "count": 1}),
        ),
        (
            "failuresByReason",
            serde_json::json!({"reason": "empty-result", "count": 1}),
        ),
        (
            "worstHosts",
            serde_json::json!({"productId": 42, "ifcType": "IfcWall",
            "openings": 1, "csgFailures": 1, "firstFailureLabel": "empty-result", "triangleCount": 12}),
        ),
    ] {
        let mut changed = serde_json::to_value(&original).unwrap();
        changed[key].as_array_mut().unwrap().push(detail);
        mutations.push(changed);
    }
    for changed in mutations {
        warm.batches[0].diagnostics = serde_json::from_value(changed).unwrap();
        assert_eq!(payload, compare::payload(&warm.outputs));
        let differences = compare::lifecycle_differences(&cold, &warm, true);
        assert!(
            differences
                .iter()
                .any(|d| d.contains("warm attempt 0 drain")),
            "{differences:?}"
        );
    }
    warm.batches[0].diagnostics = original;
    assert!(compare::lifecycle_differences(&cold, &warm, true).is_empty());
}

#[test]
fn every_intermediate_pipeline_field_is_required_7782_r5() {
    let content = observe::fixture(TYPE_MODES);
    let cold = observe::browser_cold(&content);
    for (warm, mut leg) in [
        (true, observe::browser_warm(&content)),
        (false, observe::browser_split(&content)),
    ] {
        assert!(
            leg.batches.len() > 1,
            "control must include intermediate snapshots"
        );
        assert!(
            compare::lifecycle_differences(&cold, &leg, warm).is_empty(),
            "unmutated lifecycle control"
        );
        let payload = compare::payload(&leg.outputs);
        for i in 0..leg.batches.len() - 1 {
            let original = leg.batches[i].pipeline.clone().unwrap();
            // Covers backstopCount and every other non-five-key field, even
            // when zero; retained operational fields must also be present.
            for key in original.as_object().unwrap().keys() {
                let mut missing = original.clone();
                missing.as_object_mut().unwrap().remove(key);
                leg.batches[i].pipeline = Some(missing);
                assert_eq!(payload, compare::payload(&leg.outputs));
                assert!(
                    !compare::lifecycle_differences(&cold, &leg, warm).is_empty(),
                    "missing {key} in batch {i}"
                );
            }
            for key in [
                "backstopCount",
                "elementCount",
                "meshCount",
                "triangleCount",
            ] {
                let mut changed = original.clone();
                changed[key] = (changed[key].as_u64().unwrap() + 1).into();
                leg.batches[i].pipeline = Some(changed);
                assert_eq!(payload, compare::payload(&leg.outputs));
                assert!(
                    !compare::lifecycle_differences(&cold, &leg, warm).is_empty(),
                    "changed {key} in batch {i}"
                );
            }
            let mut missing_nested = original.clone();
            missing_nested["rectFast"]
                .as_object_mut()
                .unwrap()
                .remove("deferHostNotBox");
            leg.batches[i].pipeline = Some(missing_nested);
            assert!(!compare::lifecycle_differences(&cold, &leg, warm).is_empty());
            leg.batches[i].pipeline = Some(original);
        }
        assert!(compare::lifecycle_differences(&cold, &leg, warm).is_empty());
    }
}
