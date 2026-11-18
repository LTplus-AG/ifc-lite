// SPDX-License-Identifier: MPL-2.0

//! Split-wall recess fixture adapted from #10346 for #10512.

#![cfg(feature = "csg_manifold_gate")]

mod voids_common;

use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::kernel::mesh_volume::mesh_volume;
use ifc_lite_geometry::mesh_check::{edge_multiplicity_defects, Degenerate, EdgeLedger, VertexKey};
use ifc_lite_geometry::GeometryRouter;
use voids_common::production::{build_void_index_like_production, fold_origin};

const WALL_LENGTH: f64 = 4.0;
const WALL_HEIGHT: f64 = 3.0;
const CORE: f64 = 0.2;
const FINISH: f64 = 0.012;
/// The recess is a square of this side in the wall's face.
const RECESS: f64 = 1.0;

/// How the recess is authored.
#[derive(Clone, Copy, Debug)]
enum Recess {
    /// Extruded from the interface out through the finish, mid-wall.
    FromInterface,
    /// Extruded from the finish's outer face back to the interface, and
    /// placed so that it runs out of the top of the wall.
    ToInterfaceAtTop,
}

fn wall(wall_turn_deg: f64, wall_y: f64, recess: Recess) -> String {
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
#20=IFCCARTESIANPOINT((1000.,800.,0.));
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
        half_recess = RECESS * 0.5,
        bodies = split_bodies(),
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

fn analytic_volume() -> f64 {
    WALL_LENGTH * WALL_HEIGHT * (CORE + FINISH) - RECESS * RECESS * FINISH
}

#[test]
fn split_recess_from_a_kilometre_away() {
    let mut failures = Vec::new();
    for recess in [Recess::FromInterface, Recess::ToInterfaceAtTop] {
        for turn in [0.0, 90.0] {
            for step in 0..6 {
                let offset = 2.0 + 0.137 * f64::from(step);
                let content = wall(turn, offset, recess);
                let voids = build_void_index_like_production(&content);
                let mut decoder = EntityDecoder::with_index(&content, build_entity_index(&content));
                let entity = decoder.decode_by_id(100).unwrap();
                let router = GeometryRouter::with_scale(1.0);
                let mut mesh = router
                    .process_element_with_voids(&entity, &mut decoder, &voids)
                    .unwrap();
                fold_origin(&mut mesh);

                let ledger =
                    EdgeLedger::build(&mesh, VertexKey::GridMul(1.0e3), Degenerate::SkipTriangle);
                let open = ledger.unbalanced().count();
                let delta = mesh_volume(&mesh) - analytic_volume();
                let cut_failures = router.take_csg_failures();
                let recovered = turn == 0.0 && matches!(step, 1 | 2 | 4 | 5);
                if open != 0
                    || delta.abs() > 0.0005
                    || !cut_failures.is_empty()
                    || (recovered && !edge_multiplicity_defects(&mesh).is_clean())
                {
                    failures.push(format!(
                        "{recess:?} turn={turn} y={offset:.3}: {open} open edges, {:+.3} L volume delta, {cut_failures:?}",
                        delta * 1000.0
                    ));
                }
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
