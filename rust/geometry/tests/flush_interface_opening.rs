// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! A recess that ends on the interface between two bodies of its host (#10346).
//!
//! The wall is a 200 mm core with a 12 mm finish body on one face, authored
//! as two extrusions that touch. The recess removes the finish over one
//! square metre and stops on the core. Its end cap therefore lies in the
//! plane of two host faces: the finish's back, which bounds the material the
//! recess removes, and the core's front, which is the recess floor.
//!
//! Cutter and host agree on that plane only to f32 rounding, and the cut used
//! to follow whichever side each face vertex happened to land on. Moving the
//! wall by 137 mm was enough to change the answer: a correct recess, a closed
//! sheet with no thickness left across the recess (two square metres of
//! surface too many), a hole punched through the core (200 litres too many),
//! or a torn mesh.
//!
//! Every placement here must give the same solid: closed, the analytic
//! volume, the analytic surface area.

mod voids_common;

use ifc_lite_geometry::kernel::mesh_volume::mesh_volume;
use ifc_lite_geometry::mesh_check::{Degenerate, EdgeLedger, VertexKey};
use ifc_lite_geometry::Mesh;
use voids_common::production::{build_void_index_like_production, process_host_like_production};

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

fn wall(site_at: [f64; 3], site_turn_deg: f64, wall_turn_deg: f64, wall_y: f64, recess: Recess) -> String {
    let (site_sin, site_cos) = site_turn_deg.to_radians().sin_cos();
    let (wall_sin, wall_cos) = wall_turn_deg.to_radians().sin_cos();
    let [sx, sy, sz] = site_at;
    let finish_mid = CORE + FINISH * 0.5;
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
#20=IFCCARTESIANPOINT(({sx:?},{sy:?},{sz:?}));
#21=IFCDIRECTION(({site_cos:?},{site_sin:?},0.));
#22=IFCAXIS2PLACEMENT3D(#20,#14,#21);
#23=IFCLOCALPLACEMENT($,#22);
#24=IFCSITE('0FlushInterface0000002',$,'Site',$,$,#23,$,$,.ELEMENT.,$,$,$,$,$);
#25=IFCRELAGGREGATES('0FlushInterface0000003',$,$,$,#1,(#24));
#30=IFCCARTESIANPOINT((3.,{wall_y:?},0.5));
#31=IFCDIRECTION(({wall_cos:?},{wall_sin:?},0.));
#32=IFCAXIS2PLACEMENT3D(#30,#14,#31);
#33=IFCLOCALPLACEMENT(#23,#32);
#40=IFCCARTESIANPOINT(({half_length:?},{core_mid:?}));
#41=IFCAXIS2PLACEMENT2D(#40,$);
#42=IFCRECTANGLEPROFILEDEF(.AREA.,'Core',#41,{WALL_LENGTH:?},{CORE:?});
#43=IFCCARTESIANPOINT(({half_length:?},{finish_mid:?}));
#44=IFCAXIS2PLACEMENT2D(#43,$);
#45=IFCRECTANGLEPROFILEDEF(.AREA.,'Finish',#44,{WALL_LENGTH:?},{FINISH:?});
#46=IFCEXTRUDEDAREASOLID(#42,#11,#14,{WALL_HEIGHT:?});
#47=IFCEXTRUDEDAREASOLID(#45,#11,#14,{WALL_HEIGHT:?});
#50=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#46,#47));
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
        half_length = WALL_LENGTH * 0.5,
        core_mid = CORE * 0.5,
        half_recess = RECESS * 0.5,
    )
}

fn box_area(x: f64, y: f64, z: f64) -> f64 {
    2.0 * (x * y + y * z + z * x)
}

/// The surface the cut wall must have. The core is untouched. The finish
/// loses the recess square from its front and back faces and gains the
/// recess reveals: four when the recess sits mid-wall, three when it runs out
/// of the top, where the finish's top face loses a strip instead.
fn analytic_area(recess: Recess) -> f64 {
    let reveal = RECESS * FINISH;
    let finish = box_area(WALL_LENGTH, FINISH, WALL_HEIGHT) - 2.0 * RECESS * RECESS
        + match recess {
            Recess::FromInterface => 4.0 * reveal,
            Recess::ToInterfaceAtTop => 3.0 * reveal - reveal,
        };
    box_area(WALL_LENGTH, CORE, WALL_HEIGHT) + finish
}

fn analytic_volume() -> f64 {
    WALL_LENGTH * WALL_HEIGHT * (CORE + FINISH) - RECESS * RECESS * FINISH
}

fn area(mesh: &Mesh) -> f64 {
    let p = |i: u32| -> [f64; 3] { std::array::from_fn(|k| f64::from(mesh.positions[i as usize * 3 + k])) };
    mesh.indices
        .chunks_exact(3)
        .map(|t| {
            let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
            let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
            0.5 * (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt()
        })
        .sum()
}

/// Open boundary edges on a 1 mm grid, as the watertightness census reads them.
fn open_edges(mesh: &Mesh) -> usize {
    EdgeLedger::build(mesh, VertexKey::GridMul(1.0e3), Degenerate::SkipTriangle).unbalanced().count()
}

#[test]
fn a_recess_ending_on_a_body_interface_cuts_the_same_wherever_the_wall_sits() {
    let mut failures = Vec::new();
    for recess in [Recess::FromInterface, Recess::ToInterfaceAtTop] {
        for (site_at, site_turn) in [([0.0; 3], 0.0), ([31.25, -47.5, 12.0], 48.0)] {
            for wall_turn in [0.0, 42.0, 90.0, 137.0] {
                // Twelve offsets 137 mm apart: the interface plane then rounds
                // to f32 on either side of the cutter's f64 plane.
                for step in 0..12 {
                    let wall_y = 2.0 + 0.137 * f64::from(step);
                    let content = wall(site_at, site_turn, wall_turn, wall_y, recess);
                    let voids = build_void_index_like_production(&content);
                    let mesh = process_host_like_production(&content, 100, &voids).expect("the wall meshes");
                    let (open, volume, surface) = (open_edges(&mesh), mesh_volume(&mesh), area(&mesh));
                    if open != 0
                        || (volume - analytic_volume()).abs() > 5.0e-4
                        || (surface - analytic_area(recess)).abs() > 5.0e-3
                    {
                        failures.push(format!(
                            "{recess:?} site turn {site_turn} wall turn {wall_turn} y {wall_y:.3}: \
                             {open} open edges, volume {volume:.6} m3 (analytic {:.6}), \
                             surface {surface:.4} m2 (analytic {:.4})",
                            analytic_volume(),
                            analytic_area(recess),
                        ));
                    }
                }
            }
        }
    }
    assert!(failures.is_empty(), "{} of 192 placements are wrong:\n{}", failures.len(), failures.join("\n"));
}
