// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #4611: every pipeline picks the RTC frame from the same sample window.
//!
//! Included from `prepass.rs` with `#[cfg(test)] #[path = "prepass_tests.rs"]
//! mod prepass_tests;`, so `super` resolves to the `prepass` module.

use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::GeometryRouter;
use ifc_lite_processing::stream_meta::{resolve_stream_meta, MetaMode};
use ifc_lite_processing::{MeshFrame, OpeningFilterMode, StreamingOptions};

/// A 22-character IFC GlobalId, unique per `(keyword, index)` pair.
fn guid(keyword: &str, index: usize) -> String {
    let seed = format!("{keyword}{index}");
    format!("{seed:0>22}")
}

/// Where the first cluster sits (metres east). `IfcWindow`: a COMPLEX geometry
/// type to the pre-pass classifier and a LOW-priority one to the native
/// `fast_first_batch` sort.
const FIRST_ANCHOR_X: f64 = 1_000_000.0;
/// Where the second cluster sits, 100 km further east. `IfcWall`: SIMPLE to the
/// pre-pass classifier, HIGHEST priority to the native sort.
const SECOND_ANCHOR_X: f64 = 1_100_000.0;
/// How far east of the first cluster the grid is placed.
const GRID_OFFSET_M: f64 = 5.0;

/// A metre model with two clusters of large-coordinate placements: `first`
/// `IfcWindow`s at [`FIRST_ANCHOR_X`], then `second` `IfcWall`s at
/// [`SECOND_ANCHOR_X`], then one `IfcGrid` [`GRID_OFFSET_M`] east of the first
/// cluster.
///
/// The grid carries a null Representation, so it abstains from the RTC vote
/// (`sample_element_translation` needs attribute 6) and does not move the
/// median; its axis is what the overlay leg is read off.
fn two_cluster_model(first: usize, second: usize) -> String {
    let mut s = String::from(
        "ISO-10303-21;\n\
         HEADER;\n\
         FILE_DESCRIPTION((''),'2;1');\n\
         FILE_NAME('','',(''),(''),'','','');\n\
         FILE_SCHEMA(('IFC4'));\n\
         ENDSEC;\n\
         DATA;\n\
         #1=IFCPROJECT('0PrOjEcTpRoJeCtPrOjEc',$,'P',$,$,$,$,$,#8);\n\
         #8=IFCUNITASSIGNMENT((#9));\n\
         #9=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);\n\
         #3=IFCPRODUCTDEFINITIONSHAPE($,$,(#4));\n\
         #4=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',());\n",
    );
    let mut id = 100u32;
    let mut cluster = |s: &mut String, keyword: &str, tail: &str, x: f64, count: usize| {
        for i in 0..count {
            let (elem, place, axis, point) = (id, id + 1, id + 2, id + 3);
            id += 4;
            let guid = guid(keyword, i);
            s.push_str(&format!(
                "#{point}=IFCCARTESIANPOINT(({x}.,0.,0.));\n\
                 #{axis}=IFCAXIS2PLACEMENT3D(#{point},$,$);\n\
                 #{place}=IFCLOCALPLACEMENT($,#{axis});\n\
                 #{elem}={keyword}('{guid}',$,'E{i}',$,$,#{place},#3{tail});\n",
            ));
        }
    };
    // IfcWindow: ..., ObjectPlacement, Representation, Tag, OverallHeight,
    // OverallWidth, PredefinedType, PartitioningType, UserDefinedPartitioningType.
    cluster(&mut s, "IFCWINDOW", ",$,$,$,$,$,$", FIRST_ANCHOR_X, first);
    // IfcWall: ..., ObjectPlacement, Representation, Tag, PredefinedType.
    cluster(&mut s, "IFCWALL", ",$,$", SECOND_ANCHOR_X, second);
    let grid_x = FIRST_ANCHOR_X + GRID_OFFSET_M;
    s.push_str(&format!(
        "#9000=IFCGRID('0GrIdGrIdGrIdGrIdGrId0',$,'Grid',$,$,#9001,$,(#9010),$,$);\n\
         #9001=IFCLOCALPLACEMENT($,#9002);\n\
         #9002=IFCAXIS2PLACEMENT3D(#9003,$,$);\n\
         #9003=IFCCARTESIANPOINT(({grid_x}.,0.,0.));\n\
         #9010=IFCGRIDAXIS('A',#9011,.T.);\n\
         #9011=IFCPOLYLINE((#9012,#9013));\n\
         #9012=IFCCARTESIANPOINT((0.,0.));\n\
         #9013=IFCCARTESIANPOINT((0.,10.));\n\
         ENDSEC;\nEND-ISO-10303-21;\n"
    ));
    s
}

/// A metre model whose tail is sampleable from the HEAD's index: 10
/// `IfcWindow`s at [`FIRST_ANCHOR_X`] carrying their own placements, then 60
/// `IfcWall`s at [`SECOND_ANCHOR_X`] that all share ONE placement chain
/// declared up front, before the windows.
///
/// That shared chain is what makes the fixture discriminate. The sampler
/// decodes an element from its own byte span, so the wall RECORDS are readable
/// whatever the index holds; only their placement needs a lookup, and here it
/// resolves against a head-only index too. So a sampler that walks past the
/// head really does fold the walls into the median (answer:
/// `SECOND_ANCHOR_X`), and one that stops at the head does not (answer:
/// `FIRST_ANCHOR_X`). With per-wall placements in the tail — the ordinary
/// case — both answers are `FIRST_ANCHOR_X` and the walk is invisible in the
/// result while still costing a full-file decode.
fn shared_tail_placement_model() -> String {
    let mut s = String::from(
        "ISO-10303-21;\n\
         HEADER;\n\
         FILE_DESCRIPTION((''),'2;1');\n\
         FILE_NAME('','',(''),(''),'','','');\n\
         FILE_SCHEMA(('IFC4'));\n\
         ENDSEC;\n\
         DATA;\n\
         #1=IFCPROJECT('0PrOjEcTpRoJeCtPrOjEc',$,'P',$,$,$,$,$,#8);\n\
         #8=IFCUNITASSIGNMENT((#9));\n\
         #9=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);\n\
         #3=IFCPRODUCTDEFINITIONSHAPE($,$,(#4));\n\
         #4=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',());\n",
    );
    s.push_str(&format!(
        "#10=IFCCARTESIANPOINT(({SECOND_ANCHOR_X}.,0.,0.));\n\
         #11=IFCAXIS2PLACEMENT3D(#10,$,$);\n\
         #12=IFCLOCALPLACEMENT($,#11);\n"
    ));
    let mut id = 100u32;
    for i in 0..10 {
        let (elem, place, axis, point) = (id, id + 1, id + 2, id + 3);
        id += 4;
        let guid = guid("IFCWINDOW", i);
        s.push_str(&format!(
            "#{point}=IFCCARTESIANPOINT(({FIRST_ANCHOR_X}.,0.,0.));\n\
             #{axis}=IFCAXIS2PLACEMENT3D(#{point},$,$);\n\
             #{place}=IFCLOCALPLACEMENT($,#{axis});\n\
             #{elem}=IFCWINDOW('{guid}',$,'W{i}',$,$,#{place},#3,$,$,$,$,$,$);\n",
        ));
    }
    for i in 0..60 {
        let elem = id;
        id += 1;
        let guid = guid("IFCWALL", i);
        s.push_str(&format!("#{elem}=IFCWALL('{guid}',$,'A{i}',$,$,#12,#3,$,$);\n"));
    }
    let grid_x = FIRST_ANCHOR_X + GRID_OFFSET_M;
    s.push_str(&format!(
        "#9000=IFCGRID('0GrIdGrIdGrIdGrIdGrId0',$,'Grid',$,$,#9001,$,(#9010),$,$);\n\
         #9001=IFCLOCALPLACEMENT($,#9002);\n\
         #9002=IFCAXIS2PLACEMENT3D(#9003,$,$);\n\
         #9003=IFCCARTESIANPOINT(({grid_x}.,0.,0.));\n\
         #9010=IFCGRIDAXIS('A',#9011,.T.);\n\
         #9011=IFCPOLYLINE((#9012,#9013));\n\
         #9012=IFCCARTESIANPOINT((0.,0.));\n\
         #9013=IFCCARTESIANPOINT((0.,10.));\n\
         ENDSEC;\nEND-ISO-10303-21;\n"
    ));
    s
}

/// The anchor the native pipeline picks, with `fast_first_batch` on or off.
fn native_anchor(content: &[u8], fast_first_batch: bool) -> [f64; 3] {
    ifc_lite_processing::process_geometry_streaming_filtered_with_options(
        content,
        OpeningFilterMode::Default,
        StreamingOptions {
            fast_first_batch,
            retain_emitted_meshes: false,
            include_properties: false,
            include_presentation_layers: false,
            ..StreamingOptions::default()
        },
        |_, _, _| {},
        |_| {},
        |_| {},
    )
    .metadata
    .coordinate_info
    .origin_shift
}

/// #4611. The RTC sample window used to be whatever job list the caller had:
/// the browser pre-pass handed the detector 25 simple + 25 complex jobs, the
/// streaming pre-pass the first 50 it had buffered, the native pipeline its own
/// (optionally priority-sorted) schedule, and the overlays every geometry
/// entity in file order. One file could get several anchors. Measured on the
/// fetched fixture corpus, the overlays disagreed with `buildPrePassOnce` by
/// 2.1 m on `ara3d/ISSUE_098_R8_F1_MAB_AR_M3_XX_XXX_MO_7000.IFC`, 5.2 m on
/// `various/rvt01.ifc` and 349 m on
/// `issues/859_linear_placement_of_signal.ifc` — grid and alignment lines drawn
/// that far off the meshes they belong to.
///
/// Here the two windows are 100 km apart by construction: the file-order window
/// sees 30 windows then 20 walls and lands on `FIRST_ANCHOR_X`, while the
/// 25-simple-plus-25-complex window and the `fast_first_batch` schedule that
/// sorts walls first both land on `SECOND_ANCHOR_X`. Every leg must give the
/// file-order answer.
#[test]
fn every_pipeline_picks_the_frame_from_one_sample_window() {
    let content = two_cluster_model(30, 30);
    let bytes = content.as_bytes();

    let mut decoder = EntityDecoder::with_index(bytes, build_entity_index(bytes));
    let pre_pass = crate::api::styling::combined_pre_pass(bytes, &mut decoder);
    // Premise: the fixture still discriminates. Both classes must outnumber the
    // historical 25-job cut, or the pre-pass window and the file window agree
    // and the assertions below stop proving anything. (`simple_jobs` also
    // carries the `IfcGrid`, which abstains from the vote.)
    let (simple, complex) = (pre_pass.simple_jobs.len(), pre_pass.complex_jobs.len());
    assert!(
        simple > 25 && complex > 25,
        "premise: both classes must outnumber the 25-job cut, got {simple} simple and {complex} complex",
    );

    let expected = (FIRST_ANCHOR_X, 0.0, 0.0);

    // Leg 1: the browser pre-pass (`buildPrePassOnce` / the streaming tail).
    let meta = resolve_stream_meta(
        MetaMode::SmallFileSingle,
        bytes,
        pre_pass.project_id,
        pre_pass.site_position,
        &mut decoder,
    );
    assert_eq!(
        meta.frame,
        MeshFrame::ModelRtc { anchor: expected },
        "the pre-pass sampled its own 25 simple + 25 complex window again",
    );

    // Leg 2: the streaming early-meta ladder. Its window is the scanned head,
    // which here is the whole file.
    let mut partial = EntityDecoder::with_index(bytes, build_entity_index(bytes));
    let partial_meta = resolve_stream_meta(
        MetaMode::StreamingPartial {
            scanned_through: bytes.len(),
        },
        bytes,
        pre_pass.project_id,
        pre_pass.site_position,
        &mut partial,
    );
    assert_eq!(
        partial_meta.frame, meta.frame,
        "streaming ladder picked another frame"
    );

    // Leg 3: the overlays.
    let mut overlay_decoder = EntityDecoder::with_index(bytes, build_entity_index(bytes));
    let router = GeometryRouter::with_units(bytes, &mut overlay_decoder);
    let overlay = MeshFrame::for_overlay(&router, bytes, &mut overlay_decoder);
    assert_eq!(overlay, meta.frame, "overlays picked another frame");

    // Leg 4: the native pipeline. `fast_first_batch = false` is the control
    // arm — the native schedule is file order there, so it agreed even before
    // this change; `true` sorts the walls to the front, which is the window
    // that answers SECOND_ANCHOR_X.
    let expected_native = [expected.0, expected.1, expected.2];
    assert_eq!(
        native_anchor(bytes, false),
        expected_native,
        "native pipeline picked another frame"
    );
    assert_eq!(
        native_anchor(bytes, true),
        expected_native,
        "fast_first_batch reordered the jobs and moved the frame with them",
    );

    // And the thing a user sees: the grid axis drawn in the mesh frame,
    // GRID_OFFSET_M east of the anchor, not 100 km west of it.
    let axes = crate::api::grid_lines::extract_grid_axes(&content, None);
    assert_eq!(axes.len(), 1, "expected one grid axis");
    let x = axes[0].start[0];
    assert!(
        (x - GRID_OFFSET_M as f32).abs() < 1e-3,
        "grid axis x must be {GRID_OFFSET_M} in the mesh frame, got {x}",
    );
}

/// The streaming early-meta ladder samples the scanned HEAD, not the whole
/// file. Its decoder holds a partial index, so every entity past the head
/// abstains anyway, and sampling to end of file only decodes them to learn
/// nothing: measured on seven fixtures, all seven walked to EOF, adding 235 ms
/// on a 343 MB model and returning the anchor the head alone already gave. That
/// walk lands inside the mid-scan emission whose whole purpose is a short
/// time-to-first-geometry.
///
/// [`shared_tail_placement_model`] makes the two windows disagree: the
/// whole-file window folds in 40 of the tail walls and medians on
/// `SECOND_ANCHOR_X`, the head alone medians on `FIRST_ANCHOR_X`.
#[test]
fn the_streaming_ladder_samples_only_the_scanned_head() {
    let content = shared_tail_placement_model();
    let bytes = content.as_bytes();
    let last_window = content.rfind("IFCWINDOW").expect("fixture has windows");
    let head_end = last_window + content[last_window..].find(';').expect("record end") + 1;
    assert!(
        !content[..head_end].contains("IFCWALL"),
        "premise: the head must stop before the second cluster",
    );

    // Premise: the two windows really do answer differently.
    let mut full = EntityDecoder::with_index(bytes, build_entity_index(bytes));
    let whole_file =
        resolve_stream_meta(MetaMode::SmallFileSingle, bytes, Some(1), None, &mut full);
    assert_eq!(
        whole_file.frame,
        MeshFrame::ModelRtc {
            anchor: (SECOND_ANCHOR_X, 0.0, 0.0)
        },
        "premise: the whole-file window medians on the second cluster",
    );

    let mut partial = EntityDecoder::with_index(bytes, build_entity_index(&content[..head_end]));
    let head = resolve_stream_meta(
        MetaMode::StreamingPartial {
            scanned_through: head_end,
        },
        bytes,
        Some(1),
        None,
        &mut partial,
    );
    assert_eq!(
        head.frame,
        MeshFrame::ModelRtc {
            anchor: (FIRST_ANCHOR_X, 0.0, 0.0)
        },
        "the streaming ladder sampled past the scanned head",
    );
}

/// The exact frame overload is the behavioral fix for the intentional
/// partial-head/full-source divergence above: standalone overlay detection
/// sees the tail walls and chooses the second cluster, while the pre-pass
/// selects the first-cluster frame for subsequent mesh emission. Passing that
/// selected head frame must keep the grid in the same coordinate frame without
/// widening the latency-critical pre-pass scan.
#[test]
fn explicit_overlay_frame_wins_when_partial_head_and_full_source_diverge() {
    let content = shared_tail_placement_model();
    let bytes = content.as_bytes();
    let last_window = content.rfind("IFCWINDOW").expect("fixture has windows");
    let head_end = last_window + content[last_window..].find(';').expect("record end") + 1;
    let mut partial = EntityDecoder::with_index(bytes, build_entity_index(&content[..head_end]));
    let head = resolve_stream_meta(
        MetaMode::StreamingPartial {
            scanned_through: head_end,
        },
        bytes,
        Some(1),
        None,
        &mut partial,
    );

    let standalone = crate::api::grid_lines::extract_grid_axes(&content, None);
    let explicit = crate::api::grid_lines::extract_grid_axes(&content, Some(head.frame));
    assert_eq!(standalone.len(), 1);
    assert_eq!(explicit.len(), 1);
    assert!(
        (standalone[0].start[0] - explicit[0].start[0]).abs() > 90_000.0,
        "premise: the full-source overlay detector must pick the tail frame"
    );
    assert!(
        (explicit[0].start[0] - GRID_OFFSET_M as f32).abs() < 1e-3,
        "the selected streaming frame must place the grid in the subsequent mesh frame"
    );
}
