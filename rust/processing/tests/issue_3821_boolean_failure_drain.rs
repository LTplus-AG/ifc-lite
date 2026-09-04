// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #3821: `BooleanClippingProcessor`'s failure log reaches `GeometryDiagnostics`.
//!
//! `take_failures` was called from tests ONLY. Every record the boolean
//! processor made — an unsupported operand, an `EmptyOperand` cutter, an
//! unknown operator — went into a `RefCell` no production caller read, so a
//! model whose booleans had all degraded reported a clean load. The base-operand
//! arm was worse still: it returned an empty mesh and recorded nothing at all.
//!
//! Both native entry points funnel into
//! `process_geometry_streaming_filtered_with_options`, differing only in batch
//! size, so the parity assertions below pin that a per-batch drain cannot start
//! reporting a different total from a single-batch one.

use ifc_lite_processing::{process_geometry, process_geometry_streaming};

/// A wall with one ordinary extruded solid AND one `IfcBooleanResult` whose
/// FIRST operand is `IFCSECTIONEDSPINE` — a representation-item type the
/// boolean operand dispatch has no branch for. The base solid meshes empty, so
/// the whole boolean item contributes nothing; the wall still renders from its
/// other item, which is exactly why the loss is invisible without a diagnostic.
const UNSUPPORTED_BASE_OPERAND_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-3821 unsupported base operand'),'2;1');
FILE_NAME('b3821.ifc','2026-09-04T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6e',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);

#10=IFCWALL('1BoolUnsupportedBase01',$,'Wall',$,$,#11,#12,$,$);
#11=IFCLOCALPLACEMENT($,#5);
#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));
#13=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#14,#30));
#14=IFCEXTRUDEDAREASOLID(#15,#5,#16,3.0);
#15=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,4.0,0.3);
#16=IFCDIRECTION((0.,0.,1.));

#30=IFCBOOLEANRESULT(.DIFFERENCE.,#31,#33);
#31=IFCSECTIONEDSPINE(#32,(#15),(#5));
#32=IFCCOMPOSITECURVE((),$);
#33=IFCEXTRUDEDAREASOLID(#34,#5,#16,1.0);
#34=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,1.0,0.2);
ENDSEC;
END-ISO-10303-21;
"#;

/// The same wall WITHOUT the boolean item. The control for every assertion
/// below: a clean model must stay clean, or "diagnostics appeared" would only
/// mean "this pipeline emits diagnostics for everything".
const CLEAN_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-3821 control'),'2;1');
FILE_NAME('c3821.ifc','2026-09-04T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6e',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);

#10=IFCWALL('1BoolCleanControl0001',$,'Wall',$,$,#11,#12,$,$);
#11=IFCLOCALPLACEMENT($,#5);
#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));
#13=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#14));
#14=IFCEXTRUDEDAREASOLID(#15,#5,#16,3.0);
#15=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,4.0,0.3);
#16=IFCDIRECTION((0.,0.,1.));
ENDSEC;
END-ISO-10303-21;
"#;

fn unsupported_operand_count(diag: &ifc_lite_geometry::GeometryDiagnostics) -> u64 {
    diag.failures_by_reason
        .iter()
        .find(|r| r.reason == "UnsupportedOperand")
        .map_or(0, |r| r.count)
}

#[test]
fn unsupported_first_operand_reaches_both_entry_points_with_the_same_count() {
    // Non-streaming: one batch of everything.
    let native = process_geometry(UNSUPPORTED_BASE_OPERAND_IFC);
    // Streaming: batch size 1, so each element is finalized on its own.
    let streaming =
        process_geometry_streaming(UNSUPPORTED_BASE_OPERAND_IFC.as_bytes(), 1, |_, _, _| {});

    // The element still renders (the loss is one item, not the whole wall) —
    // which is precisely why nothing but a diagnostic can reveal it.
    assert!(!native.meshes.is_empty(), "the wall's other item must still mesh");
    assert_eq!(native.meshes.len(), streaming.meshes.len());

    let native_diag = native
        .stats
        .geometry_diagnostics
        .as_ref()
        .expect("a dropped boolean operand must attach geometry_diagnostics");
    let streaming_diag = streaming
        .stats
        .geometry_diagnostics
        .as_ref()
        .expect("the streaming entry point must attach the same diagnostics");

    assert_eq!(
        unsupported_operand_count(native_diag),
        1,
        "the unsupported base operand must be recorded exactly once: {:?}",
        native_diag.failures_by_reason
    );
    assert_eq!(
        native_diag.total_csg_failures, 1,
        "one drop, one failure: {native_diag:?}"
    );
    assert_eq!(
        native_diag.total_csg_failures, streaming_diag.total_csg_failures,
        "streaming and non-streaming must report the SAME count for the same file"
    );
    assert_eq!(
        unsupported_operand_count(streaming_diag),
        unsupported_operand_count(native_diag),
        "…and the same per-reason breakdown"
    );
    // The legacy scalar the server has always exposed agrees with the contract.
    assert_eq!(native.stats.total_csg_failures, 1);
    assert_eq!(streaming.stats.total_csg_failures, 1);
}

#[test]
fn a_clean_model_records_no_boolean_failures_on_either_entry_point() {
    for (label, result) in [
        ("non-streaming", process_geometry(CLEAN_IFC)),
        (
            "streaming",
            process_geometry_streaming(CLEAN_IFC.as_bytes(), 1, |_, _, _| {}),
        ),
    ] {
        assert!(!result.meshes.is_empty(), "{label}: control wall must mesh");
        assert_eq!(
            result.stats.total_csg_failures, 0,
            "{label}: a model with no booleans must record no boolean failures"
        );
        let unsupported = result
            .stats
            .geometry_diagnostics
            .as_ref()
            .map_or(0, unsupported_operand_count);
        assert_eq!(unsupported, 0, "{label}: no spurious UnsupportedOperand");
    }
}

/// Parse `IFC_LITE_REQUIRE_FIXTURES` the way `rust/export/src/test_support.rs`
/// documents it — that module is the canonical home, but it is private to the
/// export crate and unreachable from here.
///
/// Unset, empty or `"0"` = off (skip a missing fixture, the local default).
/// `"1"` = on (a missing fixture is a hard failure; CI sets this for
/// `cargo test --workspace`). Anything else PANICS rather than falling through
/// to "off": treating a typo like `true` as off would recreate the silent pass
/// the variable exists to close.
fn require_fixtures() -> bool {
    match std::env::var("IFC_LITE_REQUIRE_FIXTURES") {
        Err(std::env::VarError::NotPresent) => false,
        Ok(v) if v.is_empty() || v == "0" => false,
        Ok(v) if v == "1" => true,
        other => panic!(
            "IFC_LITE_REQUIRE_FIXTURES must be unset, \"\", \"0\" or \"1\"; got {other:?}"
        ),
    }
}

/// Streaming-vs-native parity on a real model, not just the synthetic fixture:
/// the batch size must not change what the pass reports.
///
/// NOT load-bearing on its own. The fixture is not committed, so without it
/// this returns early and passes having asserted nothing — it stayed green
/// under every mutation of the code it covers. The two synthetic tests above
/// are what actually pin the behaviour; this one adds breadth over real
/// geometry when the fixture is present. `IFC_LITE_REQUIRE_FIXTURES=1` (which
/// CI sets) turns the silent skip into a hard failure, so fixture drift shows
/// up as a failure rather than as a quietly smaller suite.
#[test]
fn streaming_and_native_report_identical_diagnostics_on_a_real_fixture() {
    const FIXTURE: &str = "tests/models/ara3d/AC20-FZK-Haus.ifc";
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join(FIXTURE);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) => {
            assert!(
                !require_fixtures(),
                "IFC_LITE_REQUIRE_FIXTURES=1 but {FIXTURE} is missing ({e}) — \
                 run `pnpm fixtures` (sha256 in tests/models/manifest.json)"
            );
            eprintln!("{FIXTURE} missing - skipping");
            return;
        }
    };

    let native = process_geometry(&bytes);
    let streaming = process_geometry_streaming(&bytes, 8, |_, _, _| {});

    assert_eq!(
        native.stats.total_csg_failures, streaming.stats.total_csg_failures,
        "batch size must not change the boolean-failure total"
    );
    assert_eq!(
        native.stats.products_with_failures, streaming.stats.products_with_failures,
        "batch size must not change the product-failure count"
    );

    let native_reasons = native
        .stats
        .geometry_diagnostics
        .as_ref()
        .map(|d| d.failures_by_reason.clone())
        .unwrap_or_default();
    let streaming_reasons = streaming
        .stats
        .geometry_diagnostics
        .as_ref()
        .map(|d| d.failures_by_reason.clone())
        .unwrap_or_default();
    let as_pairs = |v: Vec<ifc_lite_geometry::ReasonCount>| {
        v.into_iter()
            .map(|r| (r.reason, r.count))
            .collect::<std::collections::BTreeMap<_, _>>()
    };
    assert_eq!(
        as_pairs(native_reasons),
        as_pairs(streaming_reasons),
        "batch size must not change the per-reason breakdown"
    );
}
