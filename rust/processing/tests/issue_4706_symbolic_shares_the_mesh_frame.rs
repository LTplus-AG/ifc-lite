// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #4706: the native pipeline's symbolic stream must be in the SAME frame as
//! the meshes shipped beside it.
//!
//! The server sends both from one response (`apps/server/src/routes/parse/*`).
//! `process_geometry` picks `MeshFrame::SiteLocal` for a translated `IfcSite`
//! and bakes its meshes as `Rᵀ · (P − t_site)`; the symbolic extractor used to
//! choose its own frame (`MeshFrame::for_overlay`, no site tier), so on a
//! site-local model the 2D stream kept the whole site translation AND the site
//! rotation the meshes had dropped.
//!
//! The fixture makes the two streams describe THE SAME POINTS: an `IfcGrid`
//! whose two axes run along the box's footprint edges, both placed relative to
//! the site. Every grid-axis endpoint is therefore a box corner, and the
//! assertion is a shared point - each symbolic endpoint must coincide with a
//! real mesh vertex, in the plan pair the renderer draws (`x`, `-y`) - not a
//! coordinate-space flag.
//!
//! Mutation: hand `extract_symbolic_data_with_provenance_in_frame` anything
//! other than the frame `process_geometry` selected (for example
//! `MeshFrame::RawIfc`, or the overlay frame the browser path uses) and every
//! endpoint lands 583 m away, rotated 30 degrees.

use ifc_lite_processing::{
    extract_symbolic_data_with_provenance_in_frame, process_geometry, MeshCoordinateSpace,
    MeshFrame, ProcessingResult,
};

/// Site placement translation for both fixtures (metres).
const SITE_T: [f64; 2] = [500.0, 300.0];
/// f32 mesh positions folded back to f64 at coordinate magnitude 500.
const EPS: f32 = 2e-3;

/// Minimal IFC4 metre model: a 4 x 1 x 2 box (`#23`) and an `IfcGrid` (`#50`),
/// both placed RELATIVE to the site placement (`#34`), so in the site's own
/// frame the box footprint spans (0,0)-(4,1) and the two grid axes run
/// (0,0)-(4,0) and (0,0)-(0,1) - along two of that footprint's edges.
fn model(site_placement: &str) -> String {
    format!(
        r##"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('','2026-01-01T00:00:00',(''),(''),'test','test','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#2=IFCUNITASSIGNMENT((#1));
#3=IFCCARTESIANPOINT((0.,0.,0.));
#4=IFCAXIS2PLACEMENT3D(#3,$,$);
#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-06,#4,$);
#6=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#5,$,.MODEL_VIEW.,$);
#7=IFCPROJECT('11tEAnIV5BixApwp1YzpwS',$,'t',$,$,$,$,(#5),#2);
{site_placement}
#34=IFCLOCALPLACEMENT($,#33);
#35=IFCSITE('1s1tEAnIV5BixApwp1Yzp0',$,'site',$,$,#34,$,$,.ELEMENT.,$,$,$,$,$);
#8=IFCCARTESIANPOINT((0.,0.));
#9=IFCCARTESIANPOINT((4.,0.));
#10=IFCCARTESIANPOINT((4.,1.));
#11=IFCCARTESIANPOINT((0.,1.));
#12=IFCPOLYLINE((#8,#9,#10,#11,#8));
#13=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#12);
#14=IFCCARTESIANPOINT((0.,0.,0.));
#15=IFCAXIS2PLACEMENT3D(#14,$,$);
#16=IFCDIRECTION((0.,0.,1.));
#17=IFCEXTRUDEDAREASOLID(#13,#15,#16,2.);
#18=IFCSHAPEREPRESENTATION(#6,'Body','SweptSolid',(#17));
#19=IFCPRODUCTDEFINITIONSHAPE($,$,(#18));
#20=IFCCARTESIANPOINT((0.,0.,0.));
#21=IFCAXIS2PLACEMENT3D(#20,$,$);
#22=IFCLOCALPLACEMENT(#34,#21);
#23=IFCBUILDINGELEMENTPROXY('36FTsOKg956eWgO6DwnT8U',$,'box',$,$,#22,#19,$,$);
#40=IFCCARTESIANPOINT((0.,0.,0.));
#41=IFCCARTESIANPOINT((4.,0.,0.));
#42=IFCPOLYLINE((#40,#41));
#43=IFCGRIDAXIS('A',#42,.T.);
#44=IFCCARTESIANPOINT((0.,0.,0.));
#45=IFCCARTESIANPOINT((0.,1.,0.));
#46=IFCPOLYLINE((#44,#45));
#47=IFCGRIDAXIS('1',#46,.T.);
#50=IFCGRID('2s1tEAnIV5BixApwp1Yzp1',$,'grid',$,$,#34,$,(#43),(#47),$);
#60=IFCCARTESIANPOINT((2.,0.5));
#61=IFCAXIS2PLACEMENT2D(#60,$);
#62=IFCPLANAREXTENT(1.,0.25);
#63=IFCTEXTLITERALWITHEXTENT('N',#61,.RIGHT.,#62,'center');
#64=IFCSHAPEREPRESENTATION(#5,'Annotation','Annotation2D',(#63));
#65=IFCPRODUCTDEFINITIONSHAPE($,$,(#64));
#66=IFCANNOTATION('3s1tEAnIV5BixApwp1Yzp2',$,'label',$,$,#22,#65);
ENDSEC;
END-ISO-10303-21;
"##
    )
}

/// Site translated 500 m east / 300 m north AND rotated 30 degrees about Z
/// (`RefDirection = (cos30, sin30, 0)`): the failing input from #4706.
const ROTATED_SITE: &str = r##"#30=IFCCARTESIANPOINT((500.,300.,0.));
#31=IFCDIRECTION((0.,0.,1.));
#32=IFCDIRECTION((0.866025403784439,0.5,0.));
#33=IFCAXIS2PLACEMENT3D(#30,#31,#32);"##;

/// Same translation, no rotation: the site tier with only a translation to
/// remove.
const TRANSLATED_SITE: &str = r##"#30=IFCCARTESIANPOINT((500.,300.,0.));
#33=IFCAXIS2PLACEMENT3D(#30,$,$);"##;

/// Every box vertex in the frame the response declares: `origin + position`.
fn mesh_vertices(result: &ProcessingResult) -> Vec<[f32; 3]> {
    let mut out = Vec::new();
    for m in result.meshes.iter().filter(|m| m.express_id == 23) {
        for p in m.positions.chunks_exact(3) {
            out.push([
                p[0] + m.origin[0] as f32,
                p[1] + m.origin[1] as f32,
                p[2] + m.origin[2] as f32,
            ]);
        }
    }
    assert!(!out.is_empty(), "the box (#23) must mesh");
    out
}

/// Distance from a symbolic plan point to the nearest mesh vertex, measured
/// in the renderer's plan pair: a mesh vertex `(x, y, z)` is drawn at
/// `(x, -y)` (`symbolic/rebase.rs`, `wall-rects-from-meshes.ts`).
fn distance_to_nearest_vertex(plan: (f32, f32), vertices: &[[f32; 3]]) -> f32 {
    vertices
        .iter()
        .map(|v| {
            let dx = plan.0 - v[0];
            let dy = plan.1 - -v[1];
            (dx * dx + dy * dy).sqrt()
        })
        .fold(f32::INFINITY, f32::min)
}

/// The four grid-axis endpoints as plan pairs, in authoring order
/// (axis A start/end, then axis 1 start/end).
fn grid_endpoints(data: &ifc_lite_processing::SymbolicData) -> Vec<(&str, (f32, f32))> {
    let mut out = Vec::new();
    for axis in &data.grid_axes {
        out.push((axis.tag.as_str(), (axis.endpoints[0], axis.endpoints[1])));
        out.push((axis.tag.as_str(), (axis.endpoints[2], axis.endpoints[3])));
    }
    assert_eq!(
        out.len(),
        4,
        "two axes, two endpoints each: {:?}",
        data.grid_axes
    );
    out
}

/// Run the native pipeline and extract the symbolic stream in the frame it
/// chose, exactly as every server route does.
fn native_streams(ifc: &str) -> (ProcessingResult, ifc_lite_processing::SymbolicData) {
    let result = process_geometry(ifc);
    assert_eq!(
        result.mesh_coordinate_space,
        MeshCoordinateSpace::SiteLocal,
        "a site translated {SITE_T:?} selects the site-local tier"
    );
    assert_eq!(
        result.frame.coordinate_space(),
        result.mesh_coordinate_space,
        "the frame and the wire tag are one value"
    );
    assert_eq!(
        result.frame.rtc_offset(),
        (SITE_T[0], SITE_T[1], 0.0),
        "the site translation is what the meshes had subtracted"
    );
    let symbolic = extract_symbolic_data_with_provenance_in_frame(ifc, result.frame)
        .expect("symbolic extraction must complete")
        .into_parts()
        .0;
    (result, symbolic)
}

/// The shared-point assertion, for both fixtures: every grid-axis endpoint the
/// symbolic stream emits sits ON a vertex of the box the same response ships.
fn symbolic_endpoints_land_on_mesh_vertices(ifc: &str) {
    let (result, symbolic) = native_streams(ifc);
    let vertices = mesh_vertices(&result);
    for (tag, plan) in grid_endpoints(&symbolic) {
        let distance = distance_to_nearest_vertex(plan, &vertices);
        assert!(
            distance < EPS,
            "grid axis {tag} endpoint {plan:?} is {distance} m from the nearest mesh vertex \
             of the same response; the two streams are in different frames"
        );
    }
}

#[test]
fn a_translated_site_puts_symbolic_and_meshes_on_the_same_points() {
    symbolic_endpoints_land_on_mesh_vertices(&model(TRANSLATED_SITE));
}

#[test]
fn a_rotated_site_puts_symbolic_and_meshes_on_the_same_points() {
    symbolic_endpoints_land_on_mesh_vertices(&model(ROTATED_SITE));
}

/// The exact site-frame values, so a fix that merely moves the stream NEAR the
/// meshes (dropping the translation but keeping the rotation, say) still fails.
/// Axis A runs (0,0)-(4,0) and axis 1 runs (0,0)-(0,1) in the site's own
/// frame; the plan pair negates the northing.
#[test]
fn the_rotated_sites_axes_come_back_on_the_site_axes() {
    let (_, symbolic) = native_streams(&model(ROTATED_SITE));
    let got = grid_endpoints(&symbolic);
    let want = [
        ("A", (0.0f32, 0.0f32)),
        ("A", (4.0, 0.0)),
        ("1", (0.0, 0.0)),
        ("1", (0.0, -1.0)),
    ];
    for (i, ((got_tag, got_plan), (want_tag, want_plan))) in got.iter().zip(want.iter()).enumerate()
    {
        assert_eq!(got_tag, want_tag, "endpoint {i}");
        assert!(
            (got_plan.0 - want_plan.0).abs() < EPS && (got_plan.1 - want_plan.1).abs() < EPS,
            "endpoint {i} ({got_tag}): got {got_plan:?} want {want_plan:?}"
        );
    }
}

/// A text baseline is a DIRECTION, and the site rotation has to come out of
/// it too: the label is authored reading along the site's own +X axis, so in
/// the site frame it must read along +X (`dir = (1, 0)`). Dropping only the
/// translation leaves it yawed 30 degrees - `(cos30, -sin30)` - across a wall
/// that is no longer parallel to it. Its anchor is at (2, 0.5) in the site
/// frame, drawn at `(2, -0.5)`.
#[test]
fn a_rotated_site_comes_out_of_the_text_baseline_too() {
    let (_, symbolic) = native_streams(&model(ROTATED_SITE));
    let label = symbolic
        .texts
        .iter()
        .find(|t| t.content == "N")
        .expect("the IfcAnnotation label");
    for (got, want, what) in [
        (label.x, 2.0f32, "x"),
        (label.y, -0.5, "y"),
        (label.dir_x, 1.0, "dir_x"),
        (label.dir_y, 0.0, "dir_y"),
    ] {
        assert!(
            (got - want).abs() < EPS,
            "label {what}: got {got} want {want}"
        );
    }
}

/// The browser path keeps its own frame: `extract_symbolic_data` (which the
/// wasm binding calls) still resolves `MeshFrame::for_overlay`, which has no
/// site tier, because the browser's meshes have none either
/// (`stream_meta::resolve_stream_meta` passes no site). The native fix must
/// not move that stream.
#[test]
fn the_overlay_entry_point_still_answers_in_the_browser_frame() {
    let ifc = model(ROTATED_SITE);
    let overlay = ifc_lite_processing::extract_symbolic_data(&ifc)
        .expect("symbolic extraction must complete");
    let axis_a = overlay
        .grid_axes
        .iter()
        .find(|a| a.tag == "A")
        .expect("axis A");
    // World coordinates: the site translation is still in, and so is the
    // 30 degree rotation.
    assert!(
        (axis_a.endpoints[0] - 500.0).abs() < EPS && (axis_a.endpoints[1] - -300.0).abs() < EPS,
        "browser frame keeps world coordinates: {:?}",
        axis_a.endpoints
    );
    assert_eq!(
        MeshFrame::RawIfc.rtc_offset(),
        (0.0, 0.0, 0.0),
        "nothing is subtracted in that frame for this small model"
    );
}
