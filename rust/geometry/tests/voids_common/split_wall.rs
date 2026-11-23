// SPDX-License-Identifier: MPL-2.0

//! Split-wall recess fixture adapted from #10346 for #10512.

const WALL_LENGTH: f64 = 4.0;
const WALL_HEIGHT: f64 = 3.0;
const CORE: f64 = 0.2;
const FINISH: f64 = 0.012;
/// The recess is a square of this side in the wall's face.
const RECESS: f64 = 1.0;

/// How the recess is authored.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Recess {
    /// Extruded from the interface out through the finish, mid-wall.
    FromInterface,
    /// Extruded from the finish's outer face back to the interface, and
    /// placed so that it runs out of the top of the wall.
    ToInterfaceAtTop,
}

pub(crate) fn wall(site: [f64; 2], wall_turn_deg: f64, wall_y: f64, recess: Recess) -> String {
    wall_with_bodies(site, wall_turn_deg, wall_y, recess, split_bodies())
}

// The manifold unit tests include this fixture module for the three-body wall.
// Only the integration tests use the two-body fixture.
#[allow(dead_code)]
pub(crate) fn wall_with_finish(
    site: [f64; 2], wall_turn_deg: f64, wall_y: f64, recess: Recess, finish_length: f64,
) -> String {
    let bodies = format!(
        "{}{}#50=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#63,#67));",
        extrusion(60, 0.0, WALL_LENGTH, 0.0, CORE),
        extrusion(64, 0.0, finish_length, CORE, CORE + FINISH),
    );
    wall_with_bodies(site, wall_turn_deg, wall_y, recess, bodies)
}

fn wall_with_bodies(site: [f64; 2], wall_turn_deg: f64, wall_y: f64, recess: Recess, bodies: String) -> String {
    let (wall_sin, wall_cos) = wall_turn_deg.to_radians().sin_cos();
    let (axis, start) = match recess {
        Recess::FromInterface => ("#15", CORE),
        Recess::ToInterfaceAtTop => ("#16", CORE + FINISH),
    };
    format!(
        r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('flush-interface-opening.ifc','2026-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0FlushInterface0000001',$,'Project',$,$,$,$,(#10),#7);
#7=IFCUNITASSIGNMENT((#8));
#8=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#11,$);
#11=IFCAXIS2PLACEMENT3D(#12,$,$);
#12=IFCCARTESIANPOINT((0.,0.,0.));
#13=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#10,$,.MODEL_VIEW.,$);
#14=IFCDIRECTION((0.,0.,1.));
#15=IFCDIRECTION((0.,1.,0.));
#16=IFCDIRECTION((0.,-1.,0.));
#17=IFCDIRECTION((1.,0.,0.));
#20=IFCCARTESIANPOINT(({site_x:?},{site_y:?},0.));
#21=IFCDIRECTION((1.,0.,0.));
#22=IFCAXIS2PLACEMENT3D(#20,#14,#21);
#23=IFCLOCALPLACEMENT($,#22);
#24=IFCSITE('0FlushInterface0000002',$,'Site',$,$,#23,$,$,.ELEMENT.,$,$,$,$,$);
#25=IFCRELAGGREGATES('0FlushInterface0000003',$,$,$,#1,(#24));
#30=IFCCARTESIANPOINT((3.,{wall_y:?},0.5));
#31=IFCDIRECTION(({wall_cos:?},{wall_sin:?},0.));
#32=IFCAXIS2PLACEMENT3D(#30,#14,#31);
#33=IFCLOCALPLACEMENT(#23,#32);
{bodies}
#51=IFCPRODUCTDEFINITIONSHAPE($,$,(#50));
#100=IFCWALL('0FlushInterface0000004',$,'Wall',$,$,#33,#51,$,$);
#110=IFCCARTESIANPOINT((1.,{start:?},2.));
#111=IFCAXIS2PLACEMENT3D(#110,{axis},#17);
#112=IFCLOCALPLACEMENT(#33,#111);
#120=IFCCARTESIANPOINT(({half_recess:?},{half_recess:?}));
#121=IFCAXIS2PLACEMENT2D(#120,$);
#122=IFCRECTANGLEPROFILEDEF(.AREA.,'Recess',#121,{RECESS:?},{RECESS:?});
#123=IFCEXTRUDEDAREASOLID(#122,#11,#14,{FINISH:?});
#124=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#123));
#125=IFCPRODUCTDEFINITIONSHAPE($,$,(#124));
#200=IFCOPENINGELEMENT('0FlushInterface0000005',$,'Recess',$,$,#112,#125,$,.RECESS.);
#300=IFCRELVOIDSELEMENT('0FlushInterface0000006',$,$,$,#100,#200);
ENDSEC;
END-ISO-10303-21;
"#,
        site_x = site[0],
        site_y = site[1],
        half_recess = RECESS * 0.5,
    )
}

/// Core and finish over `x` in [0, 1.5], one full-thickness body over
/// [1.5, 4]. The recess spans [1, 2].
fn split_bodies() -> String {
    format!(
        "{}{}#50=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#63,#67,#71));",
        split_extrusions(),
        extrusion(68, 1.5, WALL_LENGTH, 0.0, CORE + FINISH),
    )
}

/// Core (#63) and finish (#67) over `x` in [0, 1.5].
fn split_extrusions() -> String {
    extrusion(60, 0.0, 1.5, 0.0, CORE) + &extrusion(64, 0.0, 1.5, CORE, CORE + FINISH)
}

/// A box extruded over the wall height, entities `#id` to `#id+3`.
fn extrusion(id: u32, x0: f64, x1: f64, y0: f64, y1: f64) -> String {
    format!(
        "#{p}=IFCCARTESIANPOINT(({:?},{:?}));\n#{a}=IFCAXIS2PLACEMENT2D(#{p},$);\n\
         #{r}=IFCRECTANGLEPROFILEDEF(.AREA.,$,#{a},{:?},{:?});\n\
         #{e}=IFCEXTRUDEDAREASOLID(#{r},#11,#14,{WALL_HEIGHT:?});\n",
        (x0 + x1) * 0.5,
        (y0 + y1) * 0.5,
        x1 - x0,
        y1 - y0,
        p = id,
        a = id + 1,
        r = id + 2,
        e = id + 3,
    )
}

pub(crate) fn analytic_volume() -> f64 {
    WALL_LENGTH * WALL_HEIGHT * (CORE + FINISH) - RECESS * RECESS * FINISH
}
