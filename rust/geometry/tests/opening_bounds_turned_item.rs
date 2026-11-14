// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! An opening whose solid is turned in the opening's frame and turned back
//! by the placement above it.
//!
//! The wall is rotated 6 degrees in plan. Its opening is placed in the wall's
//! frame, and the opening solid's own Position turns it 6 degrees the other
//! way, so in the world the opening is an axis-aligned box crossing a skewed
//! wall. The bounds probe placed the eight corners of the solid's item-frame
//! box, which gave a box wider than the opening, and an axis-aligned opening
//! is cut by its bounds: the wall lost 75 litres too many.
//! (`ISSUE_129` #141060 loses 89.5 litres the same way once its site sits at
//! the origin.)

mod voids_common;

use ifc_lite_geometry::kernel::mesh_volume::mesh_volume;
use voids_common::production::{build_void_index_like_production, process_host_like_production};

const TURN_DEGREES: f64 = 6.0;
const WALL: (f64, f64, f64) = (6.0, 0.3, 3.0);
/// The opening's width across the wall's run, and its height.
const OPENING: (f64, f64) = (1.0, 1.0);

fn skewed_wall_with_world_aligned_opening() -> String {
    let (sin, cos) = TURN_DEGREES.to_radians().sin_cos();
    format!(
        r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('test.ifc','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('1234567890123456789012',#2,'Test',$,$,$,$,(#10),#7);
#2=IFCOWNERHISTORY(#3,#4,$,.ADDED.,$,$,$,0);
#3=IFCPERSONANDORGANIZATION(#5,#6,$);
#4=IFCAPPLICATION(#6,'1.0','Test','Test');
#5=IFCPERSON($,'Test',$,$,$,$,$,$);
#6=IFCORGANIZATION($,'Test',$,$,$);
#7=IFCUNITASSIGNMENT((#8,#9));
#8=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#9=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#11,$);
#11=IFCAXIS2PLACEMENT3D(#12,$,$);
#12=IFCCARTESIANPOINT((0.,0.,0.));
#13=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#10,$,.MODEL_VIEW.,$);
#20=IFCLOCALPLACEMENT($,#21);
#21=IFCAXIS2PLACEMENT3D(#12,#23,#24);
#23=IFCDIRECTION((0.,0.,1.));
#24=IFCDIRECTION(({cos:?},{sin:?},0.));
#30=IFCRECTANGLEPROFILEDEF(.AREA.,'WallProfile',#31,{wall_x:?},{wall_y:?});
#31=IFCAXIS2PLACEMENT2D(#32,$);
#32=IFCCARTESIANPOINT((0.,0.));
#40=IFCEXTRUDEDAREASOLID(#30,#11,#23,{wall_z:?});
#50=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#40));
#51=IFCPRODUCTDEFINITIONSHAPE($,$,(#50));
#100=IFCWALL('0001234567890123456789',#2,'Wall',$,$,#20,#51,'Test',$);
#110=IFCLOCALPLACEMENT(#20,#11);
#125=IFCRECTANGLEPROFILEDEF(.AREA.,'Opening',#31,{opening_x:?},1.2);
#130=IFCEXTRUDEDAREASOLID(#125,#131,#23,{opening_z:?});
#131=IFCAXIS2PLACEMENT3D(#133,#23,#134);
#133=IFCCARTESIANPOINT((0.,0.,1.));
#134=IFCDIRECTION(({cos:?},{back:?},0.));
#140=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#130));
#141=IFCPRODUCTDEFINITIONSHAPE($,$,(#140));
#200=IFCOPENINGELEMENT('0001234567890123456790',#2,'Opening',$,$,#110,#141,$,.OPENING.);
#300=IFCRELVOIDSELEMENT('0001234567890123456791',#2,$,$,#100,#200);
ENDSEC;
END-ISO-10303-21;
"#,
        back = -sin,
        wall_x = WALL.0,
        wall_y = WALL.1,
        wall_z = WALL.2,
        opening_x = OPENING.0,
        opening_z = OPENING.1,
    )
}

#[test]
fn an_opening_turned_back_onto_the_world_axes_removes_its_own_volume() {
    let content = skewed_wall_with_world_aligned_opening();
    let voids = build_void_index_like_production(&content);
    let mesh = process_host_like_production(&content, 100, &voids).expect("the wall meshes");

    // The opening is a strip of width `OPENING.0` across a slab of thickness
    // `WALL.1` skewed by the turn: a parallelogram of area w * t / cos.
    let removed = OPENING.0 * WALL.1 / TURN_DEGREES.to_radians().cos() * OPENING.1;
    let expected = WALL.0 * WALL.1 * WALL.2 - removed;
    let volume = mesh_volume(&mesh);
    assert!(
        (volume - expected).abs() < 1.0e-3,
        "cut wall volume {volume} m3, expected {expected} m3 ({:+.1} litres)",
        (volume - expected) * 1.0e3
    );
}
