// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! F3b X1 (#7779, D3, D25, D26): an element whose placement reads a malformed
//! point or direction is refused and counted in `refused_input_elements`,
//! instead of being drawn at an origin the file never gave it. Base read
//! `IFCCARTESIANPOINT((1.))` as (1, 0, 0), `((1.,'x'))` as (1, 0, 0),
//! `((1.,2.,3.,4.))` as (1, 2, 3), and a `((0.,'x'))` Axis as (0, 0, 0).
//! A two-component point is a valid 2D value and promotes to z = 0.

use ifc_lite_processing::process_geometry;

const HEAD: &str = "ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('f3b x1 placement refusal'),'2;1');
FILE_NAME('t.ifc','2026-10-17T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCDIRECTION((0.,0.,1.));
#3=IFCDIRECTION((1.,0.,0.));
#4=IFCAXIS2PLACEMENT3D(#1,#2,#3);
#5=IFCCARTESIANPOINT((0.,0.));
#6=IFCAXIS2PLACEMENT2D(#5,$);
#16=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#17=IFCUNITASSIGNMENT((#16));
#19=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#4,$);
#20=IFCPROJECT('1Project00000000007779',$,'P',$,$,$,$,(#19),#17);
#21=IFCLOCALPLACEMENT($,#4);
";

/// A 1 x 1 x 1 wall whose own placement is `Axis2Placement3D(Location, Axis, $)`.
fn wall(id: u32, location: &str, axis: &str) -> String {
    format!(
        "#{p}=IFCRECTANGLEPROFILEDEF(.AREA.,$,#6,1.,1.);
#{d}=IFCDIRECTION((0.,0.,1.));
#{s}=IFCEXTRUDEDAREASOLID(#{p},#4,#{d},1.);
#{r}=IFCSHAPEREPRESENTATION(#19,'Body','SweptSolid',(#{s}));
#{ps}=IFCPRODUCTDEFINITIONSHAPE($,$,(#{r}));
#{pt}=IFCCARTESIANPOINT({location});
#{ax}=IFCDIRECTION({axis});
#{pl}=IFCAXIS2PLACEMENT3D(#{pt},#{ax},$);
#{lp}=IFCLOCALPLACEMENT(#21,#{pl});
#{id}=IFCWALL('2Wall0000000000000{id}',$,'W{id}',$,$,#{lp},#{ps},$,$);
",
        p = id + 1,
        d = id + 2,
        s = id + 3,
        r = id + 4,
        ps = id + 5,
        pt = id + 6,
        ax = id + 7,
        pl = id + 8,
        lp = id + 9,
    )
}

fn run(body: &str) -> ifc_lite_processing::ProcessingResult {
    process_geometry(&format!("{HEAD}{body}ENDSEC;\nEND-ISO-10303-21;\n"))
}

fn min_x(result: &ifc_lite_processing::ProcessingResult, id: u32) -> f32 {
    let mesh = result.meshes.iter().find(|m| m.express_id == id).expect("meshed");
    mesh.positions.chunks(3).map(|p| p[0]).fold(f32::INFINITY, f32::min)
}

#[test]
fn a_malformed_location_or_axis_refuses_the_element_and_counts_it() {
    let good = wall(100, "(5.,0.,0.)", "(0.,0.,1.)");
    let clean = run(&good);
    assert_eq!(clean.stats.refused_input_elements, 0, "a clean file refuses nothing");
    let reference = min_x(&clean, 100);

    for (case, location, axis) in [
        ("1-component Location", "(1.)", "(0.,0.,1.)"),
        ("non-number Location", "(1.,'x')", "(0.,0.,1.)"),
        ("4-component Location", "(1.,2.,3.,4.)", "(0.,0.,1.)"),
        ("typed wrapper Location", "(IFCLENGTHMEASURE(1.),2.,3.)", "(0.,0.,1.)"),
        ("non-number Axis", "(5.,0.,0.)", "(0.,'x')"),
        ("1-component Axis", "(5.,0.,0.)", "(1.)"),
    ] {
        let result = run(&format!("{good}{}", wall(200, location, axis)));
        assert!(result.meshes.iter().all(|m| m.express_id != 200), "{case}: #200 must be refused, not drawn");
        assert_eq!(result.stats.refused_input_elements, 1, "{case}: counted once");
        assert_eq!(min_x(&result, 100), reference, "{case}: the neighbour is untouched");
    }
}

/// D26: a 2-component Location is a valid 2D point; z = 0.
#[test]
fn a_two_component_location_promotes_to_z_zero_and_is_not_refused() {
    let promoted = run(&wall(100, "(7.,0.)", "(0.,0.,1.)"));
    assert_eq!(promoted.stats.refused_input_elements, 0);
    let explicit = run(&wall(100, "(7.,0.,0.)", "(0.,0.,1.)"));
    assert_eq!(min_x(&promoted, 100), min_x(&explicit, 100));
    assert_eq!(
        promoted.meshes.iter().find(|m| m.express_id == 100).unwrap().positions,
        explicit.meshes.iter().find(|m| m.express_id == 100).unwrap().positions,
    );
}
