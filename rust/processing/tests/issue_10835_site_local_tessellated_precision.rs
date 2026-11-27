// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #10835: in the site-local frame, an `IfcTriangulatedFaceSet` whose raw
//! coordinates lie kilometres from the site's origin kept f32 precision AT
//! that distance even with the per-mesh local frame on: two boxes 0.3 mm
//! apart, 10 km out, touched. Extruded solids and the `ModelRtc` frame keep
//! the gap.

use ifc_lite_processing::{process, MeshFrame, ProcessingRequest, TessellationQuality};

// The geometry override is process-global, so these tests must set it serially.
static FRAME_POLICY: std::sync::Mutex<()> = std::sync::Mutex::new(());

const BOX: &str = "((1,3,4),(1,4,2),(5,6,8),(5,8,7),(1,2,6),(1,6,5),(3,7,8),(3,8,4),(1,5,7),(1,7,3),(2,4,8),(2,8,6))";
const QUADS: [&str; 6] = ["(1,3,4,2)", "(5,6,8,7)", "(1,2,6,5)", "(3,7,8,4)", "(1,5,7,3)", "(2,4,8,6)"];

#[derive(Clone, Copy)]
enum Kind {
    Triangulated,
    Polygonal,
}

/// The face set entity `#{id}` over point list `#{points}`, plus any faces it
/// needs, numbered from `#{faces}`.
fn face_set(kind: Kind, id: usize, points: usize, faces: usize, unused_prefix: bool) -> String {
    let indices = |text: &str| {
        if unused_prefix {
            text.chars().map(|c| if ('1'..='8').contains(&c) { char::from(c as u8 + 1) } else { c }).collect()
        } else {
            text.to_owned()
        }
    };
    match kind {
        Kind::Triangulated => format!("#{id}=IFCTRIANGULATEDFACESET(#{points},$,.T.,{},$);\n", indices(BOX)),
        Kind::Polygonal => {
            let mut out = String::new();
            let refs: Vec<String> = QUADS.iter().enumerate().map(|(f, quad)| {
                out.push_str(&format!("#{}=IFCINDEXEDPOLYGONALFACE({});\n", faces + f, indices(quad)));
                format!("#{}", faces + f)
            }).collect();
            out + &format!("#{id}=IFCPOLYGONALFACESET(#{points},.T.,({}),$);\n", refs.join(","))
        }
    }
}

/// One 1 m box per name, its min corner at `x` along X; IfcSite at `site`.
fn tessellated(site: (f64, f64), boxes: &[(&str, f64)]) -> String {
    tessellated_as(Kind::Triangulated, site, boxes)
}

fn tessellated_as(kind: Kind, site: (f64, f64), boxes: &[(&str, f64)]) -> String {
    tessellated_with_prefix(kind, site, boxes, false)
}

fn tessellated_with_prefix(kind: Kind, site: (f64, f64), boxes: &[(&str, f64)], unused_prefix: bool) -> String {
    let mut data = String::new();
    let mut ids = Vec::new();
    for (i, (name, x)) in boxes.iter().enumerate() {
        let b = 100 + 10 * i;
        let mut pts: Vec<String> = (0..8)
            .map(|v| {
                let (dx, dy, dz) = ((v & 1) as f64, ((v >> 1) & 1) as f64, ((v >> 2) & 1) as f64);
                format!("({:.4},{dy:.1},{dz:.1})", x + dx)
            })
            .collect();
        // No face references this point. Including it in the anchor rounds
        // away the sub-millimetre gap when the positions narrow to f32.
        if unused_prefix {
            pts.insert(0, "(0.,0.,0.)".to_owned());
        }
        pts.push("(1000000.,0.,0.)".to_owned());
        data.push_str(&format!("#{b}=IFCCARTESIANPOINTLIST3D(({}),$);\n", pts.join(",")));
        data.push_str(&face_set(kind, b + 1, b, 1000 + 10 * i, unused_prefix));
        data.push_str(&format!(
            "#{}=IFCSHAPEREPRESENTATION(#11,'Body','Tessellation',(#{}));\n\
             #{}=IFCPRODUCTDEFINITIONSHAPE($,$,(#{}));\n\
             #{}=IFCLOCALPLACEMENT(#26,#9);\n\
             #{}=IFCBUILDINGELEMENTPROXY('{:0>22}',$,'{name}',$,$,#{},#{},$,$);\n",
            b + 2, b + 1, b + 3, b + 2, b + 4, b + 5, i, b + 4, b + 3,
        ));
        ids.push(format!("#{}", b + 5));
    }
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\n\
FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'p',$,$,$,$,(#10),#5);\n\
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);\n#3=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);\n\
#5=IFCUNITASSIGNMENT((#2,#3));\n#6=IFCCARTESIANPOINT((0.,0.,0.));\n#7=IFCDIRECTION((0.,0.,1.));\n\
#8=IFCDIRECTION((1.,0.,0.));\n#9=IFCAXIS2PLACEMENT3D(#6,#7,#8);\n\
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#9,$);\n\
#11=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#10,$,.MODEL_VIEW.,$);\n\
#20=IFCCARTESIANPOINT(({:.1},{:.1},0.));\n#21=IFCAXIS2PLACEMENT3D(#20,$,$);\n#22=IFCLOCALPLACEMENT($,#21);\n\
#23=IFCSITE('1hqIFTRjfV6AWq_bMtnZwI',$,'Site',$,$,#22,$,$,.ELEMENT.,$,$,$,$,$);\n\
#24=IFCLOCALPLACEMENT(#22,#9);\n#25=IFCBUILDING('2FCZDorxHDT8NI01kdXi8P',$,'B',$,$,#24,$,$,.ELEMENT.,$,$,$);\n\
#26=IFCLOCALPLACEMENT(#24,#9);\n#27=IFCBUILDINGSTOREY('0w4p3Zrg9AnhvYd1uuN7Rq',$,'G',$,$,#26,$,$,.ELEMENT.,0.);\n\
#28=IFCRELAGGREGATES('3Ar4xUkLz2vRgM4JjeCNpQ',$,$,$,#1,(#23));\n\
#29=IFCRELAGGREGATES('1QdGJ3uYv5WRgC2pyCwTdl',$,$,$,#23,(#25));\n\
#30=IFCRELAGGREGATES('0eGCN0xwz3ZBEiShDF2Mu5',$,$,$,#25,(#27));\n{data}\
#70=IFCRELCONTAINEDINSPATIALSTRUCTURE('2VtB6sH0jR3uLx9QmP4cZe',$,$,$,({}),#27);\nENDSEC;\nEND-ISO-10303-21;\n",
        site.0, site.1, ids.join(","),
    )
}

/// Gap along X between each named pair, in mm, read as `origin + f64(position)`.
fn gaps(ifc: &str, pairs: &[(&str, &str)]) -> (MeshFrame, Vec<f64>) {
    let request = ProcessingRequest::full_pass().quality(TessellationQuality::Low);
    let result = process(ifc.as_bytes(), &request, &mut ());
    let extent = |name: &str| {
        let mesh = result.meshes.iter().find(|m| m.name.as_deref() == Some(name)).expect(name);
        mesh.positions.chunks_exact(3).fold((f64::MAX, f64::MIN), |(lo, hi), p| {
            let x = mesh.origin[0] + f64::from(p[0]);
            (lo.min(x), hi.max(x))
        })
    };
    let gaps = pairs.iter().map(|(a, b)| (extent(b).0 - extent(a).1) * 1e3).collect();
    (result.frame, gaps)
}

#[test]
fn site_local_face_set_far_from_the_site_keeps_its_sub_millimetre_gap() {
    let _policy = FRAME_POLICY.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    ifc_lite_geometry::local_frame_set_enabled_override(Some(true));
    let boxes = [("near-a", 10.0), ("near-b", 11.0003), ("far-a", 10000.0), ("far-b", 10001.0003)];
    let pairs = [("near-a", "near-b"), ("far-a", "far-b")];
    let (frame, gaps) = gaps(&tessellated((100.0, 100.0), &boxes), &pairs);
    assert!(matches!(frame, MeshFrame::SiteLocal { .. }), "{frame:?}");
    for ((a, b), gap) in pairs.iter().zip(&gaps) {
        assert!((gap - 0.3).abs() < 0.01, "{a} -> {b}: gap {gap:.4} mm, file says 0.3000 mm");
    }
}

#[test]
fn site_local_polygonal_face_set_far_from_the_site_keeps_its_gap() {
    let _policy = FRAME_POLICY.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    ifc_lite_geometry::local_frame_set_enabled_override(Some(true));
    let boxes = [("far-a", 10000.0), ("far-b", 10001.0003)];
    let (frame, gaps) = gaps(&tessellated_as(Kind::Polygonal, (100.0, 100.0), &boxes), &[("far-a", "far-b")]);
    assert!(matches!(frame, MeshFrame::SiteLocal { .. }), "{frame:?}");
    assert!((gaps[0] - 0.3).abs() < 0.01, "far gap {:.4} mm, file says 0.3000 mm", gaps[0]);
}

#[test]
fn site_local_gap_on_opposite_side_of_the_rtc_is_preserved() {
    let _policy = FRAME_POLICY.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    ifc_lite_geometry::local_frame_set_enabled_override(Some(true));
    let boxes = [("far-a", -10001.0), ("far-b", -9999.9997)];
    for kind in [Kind::Triangulated, Kind::Polygonal] {
        let source = tessellated_as(kind, (100.0, 100.0), &boxes);
        let (frame, gaps) = gaps(&source, &[("far-a", "far-b")]);
        assert!(matches!(frame, MeshFrame::SiteLocal { .. }), "{frame:?}");
        assert!((gaps[0] - 0.3).abs() < 0.01, "far gap {:.4} mm, file says 0.3000 mm", gaps[0]);
    }
}

#[test]
fn site_local_gap_ignores_an_unused_first_coordinate() {
    let _policy = FRAME_POLICY.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let boxes = [("far-a", -10001.0), ("far-b", -9999.9997)];
    for kind in [Kind::Triangulated, Kind::Polygonal] {
        let source = tessellated_with_prefix(kind, (100.0, 100.0), &boxes, true);
        let pairs = [("far-a", "far-b")];
        ifc_lite_geometry::local_frame_set_enabled_override(Some(false));
        let (_, disabled) = gaps(&source, &pairs);
        assert_eq!(disabled[0], 0.0);
        ifc_lite_geometry::local_frame_set_enabled_override(Some(true));
        let (frame, enabled) = gaps(&source, &pairs);
        assert!(matches!(frame, MeshFrame::SiteLocal { .. }), "{frame:?}");
        assert!((enabled[0] - 0.3).abs() < 0.01, "far gap {:.4} mm, file says 0.3000 mm", enabled[0]);
    }
}
