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
//! volume, the analytic surface area. The split host of the kilometre test
//! is held more loosely; see there.

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

/// How the wall's bodies are laid out.
#[derive(Clone, Copy, Debug)]
enum Host {
    /// A core and a finish body over the whole wall length.
    CoreAndFinish,
    /// Core and finish up to the middle of the recess, then one body of the
    /// full thickness: past the interface under half the recess there is
    /// material and no floor face.
    SplitUnderRecess,
    /// `SplitUnderRecess` with the full-thickness body a faceted brep whose
    /// face inside the recess is split at the interface plane: no single
    /// triangle runs through the plane there.
    SplitMeshedAtInterface,
}

fn wall(site_at: [f64; 3], site_turn_deg: f64, wall_turn_deg: f64, wall_y: f64, recess: Recess, host: Host) -> String {
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
        half_length = WALL_LENGTH * 0.5,
        core_mid = CORE * 0.5,
        half_recess = RECESS * 0.5,
        bodies = match host {
            Host::CoreAndFinish => "#50=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#46,#47));".to_string(),
            Host::SplitUnderRecess => split_bodies(),
            Host::SplitMeshedAtInterface => split_meshed_bodies(),
        },
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

/// Core and finish over `x` in [0, 1.5] as extrusions, and the body over
/// [1.5, 4] as a faceted brep box whose `x = 1.5` face is two quads split at
/// `y = CORE`. The split vertices also sit on its top and bottom faces, so
/// the shell stays closed.
fn split_meshed_bodies() -> String {
    let (x0, x1, ym, y1, z1) = (1.5, WALL_LENGTH, CORE, CORE + FINISH, WALL_HEIGHT);
    let points = [
        [x0, 0.0, 0.0],
        [x1, 0.0, 0.0],
        [x1, y1, 0.0],
        [x0, y1, 0.0],
        [x0, ym, 0.0],
        [x0, 0.0, z1],
        [x1, 0.0, z1],
        [x1, y1, z1],
        [x0, y1, z1],
        [x0, ym, z1],
    ];
    // Outward loops, 1-based into `points`.
    let faces: [&[usize]; 7] =
        [&[1, 5, 4, 3, 2], &[6, 7, 8, 9, 10], &[1, 2, 7, 6], &[3, 4, 9, 8], &[2, 3, 8, 7], &[1, 6, 10, 5], &[5, 10, 9, 4]];
    let mut out = split_extrusions();
    for (i, [x, y, z]) in points.iter().enumerate() {
        out += &format!("#{}=IFCCARTESIANPOINT(({x:?},{y:?},{z:?}));\n", 900 + i);
    }
    let mut face_ids = Vec::new();
    for (k, face) in faces.iter().enumerate() {
        let id = 920 + 3 * k;
        let refs: Vec<String> = face.iter().map(|i| format!("#{}", 899 + i)).collect();
        out += &format!(
            "#{id}=IFCPOLYLOOP(({}));\n#{}=IFCFACEOUTERBOUND(#{id},.T.);\n#{}=IFCFACE((#{}));\n",
            refs.join(","),
            id + 1,
            id + 2,
            id + 1,
        );
        face_ids.push(format!("#{}", id + 2));
    }
    out + &format!(
        "#950=IFCCLOSEDSHELL(({}));\n#951=IFCFACETEDBREP(#950);\n\
         #50=IFCSHAPEREPRESENTATION(#13,'Body','Brep',(#63,#67,#951));",
        face_ids.join(",")
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
                    let content = wall(site_at, site_turn, wall_turn, wall_y, recess, Host::CoreAndFinish);
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

/// A kilometre from the origin the rounding allowance is about 0.5 mm. Where
/// material runs on past the interface under part of the recess, seating the
/// cap there cut into that material and left the step to the floored part
/// open: 18 of these placements came back with 4 to 6 open edges (#10346
/// review). Such a cap keeps the plain cut; the plain two-body wall is still
/// seated. Every placement must be closed, except six pinned under
/// `csg_manifold_gate` (see [`gate_rejected_split`]). `Host::CoreAndFinish`
/// must also have the analytic volume and surface. `Host::SplitUnderRecess` must land
/// between 0.5 litres short and 2 litres over the analytic volume: the kernel
/// gives it up to 1.4 litres too much at some offsets, on main too. No
/// analytic surface is worked out for it.
#[test]
fn a_recess_ending_on_an_interface_a_kilometre_out_cuts_a_closed_solid() {
    let mut failures = Vec::new();
    for host in [Host::CoreAndFinish, Host::SplitUnderRecess] {
        for recess in [Recess::FromInterface, Recess::ToInterfaceAtTop] {
            for wall_turn in [0.0, 90.0] {
                for step in 0..6 {
                    let wall_y = 2.0 + 0.137 * f64::from(step);
                    let content = wall([1000.0, 800.0, 0.0], 0.0, wall_turn, wall_y, recess, host);
                    let voids = build_void_index_like_production(&content);
                    let mesh = process_host_like_production(&content, 100, &voids).expect("the wall meshes");
                    let (open, volume, surface) = (open_edges(&mesh), mesh_volume(&mesh), area(&mesh));
                    let excess = volume - analytic_volume();
                    let pin = gate_rejected_split(host, recess, wall_turn, step);
                    let solid_ok = if let Some((pinned_open, pinned_excess)) = &pin {
                        open == *pinned_open && pinned_excess.contains(&excess)
                    } else {
                        open == 0
                            && match host {
                                Host::CoreAndFinish => {
                                    excess.abs() <= 5.0e-4 && (surface - analytic_area(recess)).abs() <= 5.0e-3
                                }
                                Host::SplitUnderRecess | Host::SplitMeshedAtInterface => {
                                    (-5.0e-4..=2.0e-3).contains(&excess)
                                }
                            }
                    };
                    if !solid_ok {
                        failures.push(format!(
                            "{host:?} {recess:?} wall turn {wall_turn} y {wall_y:.3}: \
                             {open} open edges, volume {volume:.6} m3 (analytic {:.6}), \
                             surface {surface:.4} m2 (analytic for CoreAndFinish {:.4}){}",
                            analytic_volume(),
                            analytic_area(recess),
                            describe_pin(&pin),
                        ));
                    }
                }
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} of 48 placements are wrong:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

/// A placement's unpaired edges and volume excess over the analytic volume, in
/// m3, as pinned under `csg_manifold_gate` (alone or with `csg_topology_gate`;
/// both read the same), like the #098 gate readings (#7990).
type GatePin = Option<(usize, std::ops::RangeInclusive<f64>)>;

fn describe_pin(pin: &GatePin) -> String {
    pin.as_ref().map_or(String::new(), |(open, excess)| {
        format!(" [gate pin: {open} open edges, {excess:?} m3 excess; re-measure against main, do not re-pin]")
    })
}

/// The pin of a placement in the kilometre test, or `None` where the
/// ordinary bar holds.
///
/// The split wall is not seated, so it takes the plain cut. At wall turn 0 and
/// offset steps 1, 2 and 4 (y 2.137, 2.274, 2.548) the gate rejects that cut,
/// and the fallback leaves 62 unpaired edges (FromInterface) or 56
/// (ToInterfaceAtTop) and loses 22.9 to 23.6 or 28.9 to 29.6 litres (pinned
/// about 0.2 litres either side). main 99340cef8f reads the same, placement
/// for placement. Seating the split wall, which the through-face guard in
/// `flush_cap.rs` stops, left 90 unpaired edges over these 24 placements under
/// the gate against 354 here, but opened 18 placements in every other build.
/// Remove the pin once the gate's fallback closes them.
fn gate_rejected_split(host: Host, recess: Recess, wall_turn: f64, step: u32) -> GatePin {
    let rejected = cfg!(feature = "csg_manifold_gate")
        && matches!(host, Host::SplitUnderRecess)
        && wall_turn == 0.0
        && matches!(step, 1 | 2 | 4);
    rejected.then_some(match recess {
        Recess::FromInterface => (62, -0.0238..=-0.0227),
        Recess::ToInterfaceAtTop => (56, -0.0298..=-0.0287),
    })
}

/// The pin of a placement in the meshed-body test, or `None` where the
/// ordinary bar holds. Under the gate two ToInterfaceAtTop placements at wall
/// turn 0 take the fallback: at the origin, offset 2.685, 24 unpaired edges
/// and 6.1 litres too much; at the kilometre site, offset 2.274, 43 unpaired
/// edges and 28.9 litres too little. main 190d2fdb30 reads the same,
/// placement for placement (measured over walls 0, 42 and 90 deg; this test
/// runs 0 and 90). Remove the pin once the gate's fallback closes them.
fn gate_rejected_meshed(recess: Recess, at_origin: bool, wall_turn: f64, step: u32) -> GatePin {
    if !cfg!(feature = "csg_manifold_gate") || !matches!(recess, Recess::ToInterfaceAtTop) || wall_turn != 0.0 {
        return None;
    }
    match (at_origin, step) {
        (true, 5) => Some((24, 0.0059..=0.0063)),
        (false, 2) => Some((43, -0.0291..=-0.0287)),
        _ => None,
    }
}

/// The split wall again, with the full-thickness body meshed so that its face
/// inside the recess is split at the interface plane. The face still runs
/// through the plane, only across two triangles, so the cap must keep the
/// plain cut. Seated, it punched the core (200 litres lost) at the origin
/// with the wall turned 0 deg at offset 2.274 (#10346 review).
#[test]
fn a_recess_over_a_body_meshed_at_the_interface_keeps_the_plain_cut() {
    let mut failures = Vec::new();
    for recess in [Recess::FromInterface, Recess::ToInterfaceAtTop] {
        for site_at in [[0.0; 3], [1000.0, 800.0, 0.0]] {
            for wall_turn in [0.0, 90.0] {
                for step in 0..6 {
                    let wall_y = 2.0 + 0.137 * f64::from(step);
                    let content = wall(site_at, 0.0, wall_turn, wall_y, recess, Host::SplitMeshedAtInterface);
                    let voids = build_void_index_like_production(&content);
                    let mesh = process_host_like_production(&content, 100, &voids).expect("the wall meshes");
                    let (open, excess) = (open_edges(&mesh), mesh_volume(&mesh) - analytic_volume());
                    let pin = gate_rejected_meshed(recess, site_at == [0.0; 3], wall_turn, step);
                    // Unpinned: the same band as the split wall's in the
                    // kilometre test.
                    let ok = match &pin {
                        Some((pinned_open, pinned_excess)) => open == *pinned_open && pinned_excess.contains(&excess),
                        None => open == 0 && (-5.0e-4..=2.0e-3).contains(&excess),
                    };
                    if !ok {
                        failures.push(format!(
                            "{recess:?} site {site_at:?} wall turn {wall_turn} y {wall_y:.3}: \
                             {open} open edges, volume {excess:+.6} m3 off analytic{}",
                            describe_pin(&pin),
                        ));
                    }
                }
            }
        }
    }
    assert!(failures.is_empty(), "{} of 48 placements are wrong:\n{}", failures.len(), failures.join("\n"));
}
