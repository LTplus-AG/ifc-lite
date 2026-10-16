// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7674 (PROC-S30, PROC-AL-17): malformed files whose values reach a float
//! sort as NaN. Each sort used `partial_cmp(..).unwrap_or(Equal)`, which is
//! not a total order with NaN, and Rust's sort may panic on that past the
//! 20-element insertion-sort cutoff (an abort in the wasm worker).
//!
//! `1.E999` parses to +inf. Through an identity placement, `inf * 0.0` is
//! NaN, so an infinite boundary coordinate gives a NaN angle (cylinder,
//! surface of revolution), and an infinite `IfcParameterValue` on a line
//! with a zero-magnitude direction vector gives a NaN station (sectioned
//! solid). The tests only require that processing returns instead of
//! panicking; what it returns for a malformed face is not pinned.

use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::{GeometryRouter, Mesh};

fn wrap(data: &str) -> String {
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\n\
         FILE_SCHEMA(('IFC4X3_ADD2'));\nENDSEC;\nDATA;\n{data}ENDSEC;\nEND-ISO-10303-21;\n"
    )
}

/// Process entity `id` of `content` through the public router.
fn process(content: &str, id: u32) -> Option<Mesh> {
    let index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, index);
    let router = GeometryRouter::new();
    let entity = decoder.decode_by_id(id).expect("decode");
    router.process_representation_item(&entity, &mut decoder).ok()
}

/// An `IfcAdvancedBrep` (#1) with one `IfcAdvancedFace` on `surface` whose
/// edge loop has `n` vertices on the unit circle. Every third
/// vertex has an infinite X, which becomes NaN in the surface frame.
/// Ids 1..=9 are the shell; the surface and its parts use 10..=19.
fn advanced_brep(surface: &str, n: usize) -> String {
    let mut s = String::from(
        "#1=IFCADVANCEDBREP(#2);\n#2=IFCCLOSEDSHELL((#3));\n#3=IFCADVANCEDFACE((#4),#10,.T.);\n\
         #4=IFCFACEOUTERBOUND(#5,.T.);\n",
    );
    s.push_str(surface);
    let edges: Vec<String> = (0..n).map(|i| format!("#{}", 1000 + i)).collect();
    s.push_str(&format!("#5=IFCEDGELOOP(({}));\n", edges.join(",")));
    for i in 0..n {
        // Visit the circle out of order (37 is coprime to the counts used), so
        // the angles are not already sorted runs.
        let t = ((i * 37) % n) as f64 / n as f64 * std::f64::consts::TAU;
        let x = if i % 3 == 0 { "1.E999".to_string() } else { format!("{:.6}", t.cos()) };
        let z = (i % 5) as f64 * 0.1;
        s.push_str(&format!(
            "#{e}=IFCORIENTEDEDGE(#{v},#{v},$,.T.);\n#{v}=IFCVERTEXPOINT(#{p});\n#{p}=IFCCARTESIANPOINT(({x},{y:.6},{z:.1}));\n",
            e = 1000 + i,
            v = 2000 + i,
            p = 3000 + i,
            y = t.sin(),
        ));
    }
    wrap(&s)
}

/// PROC-S30, `advanced_face/surfaces.rs`: the cylinder's boundary angles.
#[test]
fn cylindrical_face_with_infinite_boundary_vertices_7674() {
    let surface = "#10=IFCCYLINDRICALSURFACE(#11,1.);\n#11=IFCAXIS2PLACEMENT3D(#12,$,$);\n\
                   #12=IFCCARTESIANPOINT((0.,0.,0.));\n";
    let _ = process(&advanced_brep(surface, 60), 1);
}

/// PROC-S30, `advanced_face/revolution.rs`: the revolved face's angles.
#[test]
fn surface_of_revolution_face_with_infinite_boundary_vertices_7674() {
    let surface = "#10=IFCSURFACEOFREVOLUTION(#13,$,#11);\n#11=IFCAXIS1PLACEMENT(#12,#14);\n\
                   #12=IFCCARTESIANPOINT((0.,0.,0.));\n#14=IFCDIRECTION((0.,0.,1.));\n\
                   #13=IFCARBITRARYOPENPROFILEDEF(.CURVE.,$,#15);\n#15=IFCPOLYLINE((#16,#17));\n\
                   #16=IFCCARTESIANPOINT((1.,0.,0.));\n#17=IFCCARTESIANPOINT((1.,0.,1.));\n";
    let _ = process(&advanced_brep(surface, 60), 1);
}

/// PROC-S30, `advanced_face/conics.rs`: the circle frame's fallback when the
/// RefDirection is parallel to the Axis (a malformed placement). That reader
/// had its own `min_by` fallback; since #7687 it is the canonical
/// `transform::build_axis2_matrix` perpendicular fallback. This test reaches
/// it and pins a finite result; it passes on the parent commit too, by design.
#[test]
fn circle_edge_with_refdirection_parallel_to_axis_7674() {
    let data = "#1=IFCADVANCEDBREP(#2);\n#2=IFCCLOSEDSHELL((#3));\n#3=IFCADVANCEDFACE((#4),#10,.T.);\n\
        #4=IFCFACEOUTERBOUND(#5,.T.);\n#5=IFCEDGELOOP((#6));\n#6=IFCORIENTEDEDGE(*,*,#7,.T.);\n\
        #7=IFCEDGECURVE(#8,#8,#20,.T.);\n#8=IFCVERTEXPOINT(#9);\n#9=IFCCARTESIANPOINT((0.,0.,1.));\n\
        #10=IFCPLANE(#11);\n#11=IFCAXIS2PLACEMENT3D(#12,#13,#13);\n#12=IFCCARTESIANPOINT((0.,0.,0.));\n\
        #13=IFCDIRECTION((1.,0.,0.));\n#20=IFCCIRCLE(#11,1.);\n";
    let mesh = process(&wrap(data), 1).expect("the circle face meshes");
    assert!(!mesh.positions.is_empty(), "the circle face must still produce triangles");
    assert!(mesh.positions.iter().all(|c| c.is_finite()));
}

/// PROC-AL-17, `processors/sectioned.rs`: the authored stations' sort. 24
/// stations on an `IfcLine` directrix whose direction vector has magnitude
/// 0; every third is an infinite `IfcParameterValue`, so its station is
/// `inf * 0 = NaN`.
#[test]
fn sectioned_solid_with_nan_stations_7674() {
    let n = 24;
    let mut s = String::from(
        "#1=IFCCARTESIANPOINT((0.,0.));\n#2=IFCDIRECTION((0.,1.));\n#3=IFCVECTOR(#2,0.);\n\
         #4=IFCLINE(#1,#3);\n#5=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,0.5);\n",
    );
    let mut positions = Vec::new();
    for i in 0..n {
        let measure = if i % 3 == 0 {
            "IFCPARAMETERVALUE(1.E999)".to_string()
        } else {
            format!("IFCLENGTHMEASURE({}.)", (i * 7) % 23)
        };
        s.push_str(&format!(
            "#{p}=IFCPOINTBYDISTANCEEXPRESSION({measure},$,$,$,#4);\n#{a}=IFCAXIS2PLACEMENTLINEAR(#{p},$,$);\n",
            p = 100 + 2 * i,
            a = 101 + 2 * i,
        ));
        positions.push(format!("#{}", 101 + 2 * i));
    }
    let sections = vec!["#5"; n].join(",");
    s.push_str(&format!("#9=IFCSECTIONEDSOLIDHORIZONTAL(#4,({sections}),({}));\n", positions.join(",")));
    let _ = process(&wrap(&s), 9);
}
