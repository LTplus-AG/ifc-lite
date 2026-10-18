// SPDX-License-Identifier: MPL-2.0
//! Synthetic analytic witnesses for the common opening child, via the canonical
//! producer (not a numerical helper or a mocked processor). Two material leaves
//! share one two-body opening. Dimensions below are metres before unit encoding.
use ifc_lite_geometry::{mesh_check, Mesh};
use ifc_lite_processing::process_geometry;

fn model(scale: f64, far: bool, rotated: bool, overlap: bool, representation: &str) -> String {
    let n = |v: f64| v / scale;
    let (x, y, z) = if far {
        (5_000_000., 1_000_000., 300.)
    } else {
        (0., 0., 0.)
    };
    let direction = if rotated { "(0.,1.,0.)" } else { "(1.,0.,0.)" };
    let prefix = if scale == 0.001 { ".MILLI." } else { "$" };
    let second = if overlap { -1. } else { 1.5 };
    format!(
        "ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('synthetic opening program invariant'),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('project',$,$,$,$,$,$,(#20),#10);
#10=IFCUNITASSIGNMENT((#11));
#11=IFCSIUNIT(*,.LENGTHUNIT.,{prefix},.METRE.);
#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21=IFCAXIS2PLACEMENT3D(#22,$,$);
#22=IFCCARTESIANPOINT((0.,0.,0.));
#30=IFCSITE('site',$,$,$,$,#31,$,$,.ELEMENT.,$,$,$,$,$);
#31=IFCLOCALPLACEMENT($,#21);
#32=IFCRELAGGREGATES('aggregate',$,$,$,#1,(#30));
#33=IFCRELCONTAINEDINSPATIALSTRUCTURE('contained',$,$,$,(#100),#30);
#40=IFCDIRECTION((0.,0.,1.));
#41=IFCDIRECTION({direction});
#42=IFCCARTESIANPOINT(({x},{y},{z}));
#43=IFCAXIS2PLACEMENT3D(#42,#40,#41);
#44=IFCLOCALPLACEMENT(#31,#43);
#50=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,{length},{thin});
#51=IFCCARTESIANPOINT((0.,{thin_y},0.));
#52=IFCAXIS2PLACEMENT3D(#51,$,$);
#53=IFCEXTRUDEDAREASOLID(#50,#52,#40,{height});
#60=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,{length},{thick});
#61=IFCCARTESIANPOINT((0.,{thick_y},0.));
#62=IFCAXIS2PLACEMENT3D(#61,$,$);
#63=IFCEXTRUDEDAREASOLID(#60,#62,#40,{height});
#90=IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#53,#63));
#91=IFCPRODUCTDEFINITIONSHAPE($,$,(#90));
#100=IFCWALL('wall',$,'two leaves',$,$,#44,#91,$,.NOTDEFINED.);
#200=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,{hole},{through});
#201=IFCCARTESIANPOINT(({first},0.,{sill}));
#202=IFCAXIS2PLACEMENT3D(#201,$,$);
#203=IFCEXTRUDEDAREASOLID(#200,#202,#40,{hole});
#211=IFCCARTESIANPOINT(({second},0.,{sill}));
#212=IFCAXIS2PLACEMENT3D(#211,$,$);
#213=IFCEXTRUDEDAREASOLID(#200,#212,#40,{hole});
#220=IFCSHAPEREPRESENTATION(#20,'{representation}','{representation}',(#203,#213));
#221=IFCPRODUCTDEFINITIONSHAPE($,$,(#220));
#230=IFCOPENINGELEMENT('opening',$,$,$,$,#44,#221,$,.OPENING.);
#231=IFCRELVOIDSELEMENT('void',$,$,$,#100,#230);
ENDSEC;
END-ISO-10303-21;",
        x = n(x),
        y = n(y),
        z = n(z),
        length = n(6.),
        thin = n(0.1),
        thick = n(0.2),
        thin_y = n(-0.1),
        thick_y = n(0.05),
        height = n(3.),
        hole = n(1.),
        through = n(0.6),
        first = n(-1.5),
        second = n(second),
        sill = n(1.)
    )
}

fn assert_cut(scale: f64, far: bool, rotated: bool, overlap: bool, reference: bool) {
    let representation = if reference { "Reference" } else { "SweptSolid" };
    let result = process_geometry(model(scale, far, rotated, overlap, representation).as_bytes());
    let leaves: Vec<_> = result
        .meshes
        .iter()
        .filter(|m| m.express_id == 100)
        .collect();
    assert_eq!(leaves.len(), 2, "both placed host items must survive");
    let removed_area = if reference {
        0.
    } else if overlap {
        1.5
    } else {
        2.
    };
    let mut total = 0.;
    for leaf in leaves {
        let mut mesh = Mesh::new();
        mesh.positions.clone_from(&leaf.positions);
        mesh.indices.clone_from(&leaf.indices);
        mesh.normals.clone_from(&leaf.normals);
        assert_eq!(
            mesh_check::undirected_defect_count(&mesh),
            0,
            "window reveals must close each leaf"
        );
        let volume = mesh_check::signed_volume(&mesh).abs();
        let thickness = match leaf.geometry_item_id {
            Some(53) => 0.1,
            Some(63) => 0.2,
            other => panic!("host item provenance lost: {other:?}"),
        };
        let expected = (18. - removed_area) * thickness;
        assert!(
            (volume - expected).abs() < 1e-4,
            "leaf {:?}: {volume} != {expected}",
            leaf.geometry_item_id
        );
        // Surface area also detects a missing reveal despite matching volume.
        let point = |index: u32| {
            let i = index as usize * 3;
            nalgebra::Vector3::new(
                f64::from(mesh.positions[i]),
                f64::from(mesh.positions[i + 1]),
                f64::from(mesh.positions[i + 2]),
            )
        };
        let area: f64 = mesh
            .indices
            .chunks_exact(3)
            .map(|t| {
                let (a, b, c) = (point(t[0]), point(t[1]), point(t[2]));
                (b - a).cross(&(c - a)).norm() * 0.5
            })
            .sum();
        let perimeter = if reference {
            0.
        } else if overlap {
            5.
        } else {
            8.
        };
        let expected_area = 36. + 18. * thickness - 2. * removed_area + perimeter * thickness;
        assert!(
            (area - expected_area).abs() < 1e-3,
            "leaf surface/reveals: {area} != {expected_area}"
        );
        total += volume;
    }
    assert!((total - (18. - removed_area) * 0.3).abs() < 1e-4);
    let count = result
        .stats
        .geometry_diagnostics
        .as_ref()
        .map(|d| d.classification.total)
        .unwrap_or(0);
    assert_eq!(
        count,
        if reference { 0 } else { 2 },
        "classification is once per opening body, across host leaves"
    );
}

#[test]
fn common_opening_program_cuts_disconnected_windows_in_both_leaves() {
    assert_cut(1., false, false, false, false);
}
#[test]
fn common_opening_program_keeps_overlap_union_volume_and_reveals() {
    assert_cut(1., false, false, true, false);
}
#[test]
fn common_opening_program_preserves_mm_rotated_survey_geometry() {
    assert_cut(0.001, true, true, false, false);
}
#[test]
fn common_opening_program_suppresses_reference_only_geometry() {
    assert_cut(1., false, false, false, true);
}
