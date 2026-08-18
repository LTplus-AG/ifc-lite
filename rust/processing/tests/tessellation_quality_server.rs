// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Server half of the tessellation-quality knob (issue #976).
//!
//! The wasm path has honoured `setTessellationQuality` since #1025; the
//! server pipeline silently pinned `Medium`. These tests pin that
//! `process_geometry_filtered_with_quality` actually threads the level into
//! the per-job routers — so a server consumer requesting `highest` gets the
//! same densification a browser consumer gets, and the default stays
//! byte-identical to the historical output (cache keys for `medium` map to
//! the legacy shape, see `apps/server/src/routes/parse.rs`).

use ifc_lite_processing::{
    process_geometry_filtered, process_geometry_filtered_with_quality, OpeningFilterMode,
    TessellationQuality,
};

/// One pipe (`IfcFlowSegment` with a swept-disk body) — the tube ring count
/// scales with quality, so vertex counts must rise monotonically.
const PIPE_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-976 server tessellation fixture'),'2;1');
FILE_NAME('pipe.ifc','2026-06-12T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);

#10=IFCFLOWSEGMENT('1PipeQualityFixture01',$,'Pipe',$,$,#11,#12,$);
#11=IFCLOCALPLACEMENT($,#5);
#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));
#13=IFCSHAPEREPRESENTATION(#2,'Body','AdvancedSweptSolid',(#14));
#14=IFCSWEPTDISKSOLID(#17,0.05,$,$,$);
#15=IFCCARTESIANPOINT((0.,0.,0.));
#16=IFCCARTESIANPOINT((0.,0.,2.));
#17=IFCPOLYLINE((#15,#16));
ENDSEC;
END-ISO-10303-21;
"#;

fn vertex_count(quality: TessellationQuality) -> usize {
    let result =
        process_geometry_filtered_with_quality(PIPE_IFC, OpeningFilterMode::Default, quality);
    assert!(
        !result.meshes.is_empty(),
        "pipe fixture produced no meshes at {quality:?}"
    );
    result.stats.total_vertices
}

#[test]
fn quality_threads_into_server_geometry() {
    let low = vertex_count(TessellationQuality::Lowest);
    let medium = vertex_count(TessellationQuality::Medium);
    let highest = vertex_count(TessellationQuality::Highest);

    assert!(
        low < medium && medium < highest,
        "swept-disk vertex counts must rise monotonically with quality \
         (lowest={low}, medium={medium}, highest={highest})"
    );
}

/// The `Medium` output on `PIPE_IFC`, pinned as literals.
///
/// The equality assertion below cannot carry this test on its own:
/// `process_geometry_filtered` IS
/// `..._with_quality(content, filter, TessellationQuality::default())`
/// (`processor/mod.rs`), and `TessellationQuality::default()` IS `Medium`
/// (`geometry/src/tessellation.rs`) — so both sides run the identical code
/// path and the equality only observes `default() == Medium`. Any change to
/// what `Medium` actually produces moves both sides together and stays green.
/// These literals are what make such a change visible; the doc comment on this
/// module claims the default "stays byte-identical to the historical output"
/// and cache keys for `medium` depend on it (`apps/server/src/routes/parse.rs`).
///
/// If a deliberate change to `Medium`'s densification lands, update these two
/// numbers in the same commit — do not delete the assertion.
const MEDIUM_VERTICES: usize = 50;
const MEDIUM_TRIANGLES: usize = 96;

#[test]
fn default_quality_is_byte_identical_to_legacy_entrypoint() {
    let legacy = process_geometry_filtered(PIPE_IFC, OpeningFilterMode::Default);
    let medium = process_geometry_filtered_with_quality(
        PIPE_IFC,
        OpeningFilterMode::Default,
        TessellationQuality::Medium,
    );
    assert_eq!(legacy.stats.total_vertices, medium.stats.total_vertices);
    assert_eq!(legacy.stats.total_triangles, medium.stats.total_triangles);

    assert_eq!(
        (legacy.stats.total_vertices, legacy.stats.total_triangles),
        (MEDIUM_VERTICES, MEDIUM_TRIANGLES),
        "the legacy/default entrypoint's output on the pipe fixture changed"
    );
    assert_eq!(
        (medium.stats.total_vertices, medium.stats.total_triangles),
        (MEDIUM_VERTICES, MEDIUM_TRIANGLES),
        "the explicit `Medium` level's output on the pipe fixture changed"
    );
}

#[test]
fn quality_labels_round_trip() {
    for q in [
        TessellationQuality::Lowest,
        TessellationQuality::Low,
        TessellationQuality::Medium,
        TessellationQuality::High,
        TessellationQuality::Highest,
    ] {
        assert_eq!(TessellationQuality::parse_label(q.label()), Some(q));
        assert_eq!(TessellationQuality::from_index(q.to_index()), q);
    }
}
