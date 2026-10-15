// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #6940, the second mechanism, through the void router's public entry
//! point and with no fixture: a slab whose profile already carries a hole, and
//! an `IfcOpeningElement` that fills that hole except that one of its corners
//! is one step of the kernel's snap grid (1/65536 m, 15 micrometres) from the
//! hole's. The opening removes nothing, so the slab must come back closed and
//! whole.
//!
//! In a real file the step comes from rounding: the hole corner and the
//! opening corner are one authored point that reaches the cut down two chains
//! of float arithmetic. Here it is written into the model, with every
//! coordinate on the grid, so the offset is exactly one step in whatever frame
//! the router stores vertices and the test does not depend on how any
//! particular chain rounds.
//!
//! The hole is turned in plan so that a corner moved along an axis leaves BOTH
//! walls that meet there; that is what the subtract weld cannot repair, since
//! it reconciles a vertex with one plane.
//!
//! This file uses only entry points that predate the fix, so it still compiles
//! with the fix taken out, and its assertions are what fail then: measured
//! with the reconcile switched off, 11 of the 28 cases below come back torn
//! (3 to 12 open edges). The rule itself is
//! `rust/geometry/src/router/voids/synthesis/host_vertices.rs`; its
//! clause-by-clause tests sit beside it.
//!
//! # Dispatch and frame coverage
//!
//! Every case runs with world vertices and with a per-element local frame.
//! Analytic prism preparation and exact-kernel cutter extension use the same
//! opening/host corner reconciliation. Closure is measured on the kernel grid,
//! so a one-step seam cannot disappear under a coarser test snap. Before the
//! analytic path shared the reconciliation, corner 0 moved (1, 0) returned six
//! unmatched edges even in the local frame; 1 mm edge keys hid that seam.

use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::kernel::mesh_volume::mesh_volume;
use ifc_lite_geometry::{GeometryRouter, Mesh};
use rustc_hash::FxHashMap;
use std::collections::HashMap;

/// One step of the kernel's snap grid, in metres.
const G: f64 = 1.0 / 65536.0;
const SLAB: u32 = 100;
const OPENING: u32 = 200;

/// The four corners of a hole about 1.2 x 0.8 m, one side slanted, turned
/// about 17 degrees in plan, counter-clockwise, each on the grid.
fn hole() -> [[f64; 2]; 4] {
    let (c, s) = (0.954_770_9_f64, 0.297_342_5_f64);
    let on_grid = |v: f64| (v / G).round() * G;
    [[-0.6, -0.4], [0.6, -0.4], [0.45, 0.4], [-0.6, 0.4]]
        .map(|[x, y]| [on_grid(4.0 + c * x - s * y), on_grid(4.0 + s * x + c * y)])
}

fn point_list(points: &[[f64; 2]]) -> String {
    let body: Vec<String> = points
        .iter()
        .map(|p| format!("({:?},{:?})", p[0], p[1]))
        .collect();
    format!("({})", body.join(","))
}

/// An 8 x 8 m slab, 0.25 m thick, with the hole in its profile, and the opening
/// that fills the hole with `corner` moved `(dx, dy)` grid steps. Metres,
/// identity placements throughout.
fn slab_ifc(corner: usize, dx: f64, dy: f64) -> String {
    let hole = hole();
    let mut opening = hole;
    opening[corner][0] += dx * G;
    opening[corner][1] += dy * G;
    let clockwise: Vec<[f64; 2]> = hole.iter().rev().copied().collect();
    let data = [
        "#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,(#20),#10);".to_string(),
        "#10=IFCUNITASSIGNMENT((#11));".into(),
        "#11=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);".into(),
        "#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#21,$);".into(),
        "#21=IFCAXIS2PLACEMENT3D(#22,$,$);".into(),
        "#22=IFCCARTESIANPOINT((0.,0.,0.));".into(),
        "#31=IFCLOCALPLACEMENT($,#21);".into(),
        "#40=IFCDIRECTION((0.,0.,1.));".into(),
        "#50=IFCCARTESIANPOINTLIST2D(((0.,0.),(8.,0.),(8.,8.),(0.,8.)));".into(),
        "#51=IFCINDEXEDPOLYCURVE(#50,$,.F.);".into(),
        format!("#52=IFCCARTESIANPOINTLIST2D({});", point_list(&clockwise)),
        "#53=IFCINDEXEDPOLYCURVE(#52,$,.F.);".into(),
        "#60=IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,$,#51,(#53));".into(),
        "#63=IFCEXTRUDEDAREASOLID(#60,#21,#40,0.25);".into(),
        "#90=IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#63));".into(),
        "#91=IFCPRODUCTDEFINITIONSHAPE($,$,(#90));".into(),
        format!("#{SLAB}=IFCSLAB('4YvctVUKr0kugbFTf53O9L',$,'S',$,$,#31,#91,$,.FLOOR.);"),
        format!("#150=IFCCARTESIANPOINTLIST2D({});", point_list(&opening)),
        "#151=IFCINDEXEDPOLYCURVE(#150,$,.F.);".into(),
        "#152=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#151);".into(),
        "#153=IFCEXTRUDEDAREASOLID(#152,#21,#40,0.25);".into(),
        "#154=IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#153));".into(),
        "#155=IFCPRODUCTDEFINITIONSHAPE($,$,(#154));".into(),
        "#156=IFCLOCALPLACEMENT(#31,#21);".into(),
        format!(
            "#{OPENING}=IFCOPENINGELEMENT('5YvctVUKr0kugbFTf53O9L',$,'O',$,$,#156,#155,$,.OPENING.);"
        ),
        format!("#201=IFCRELVOIDSELEMENT('6YvctVUKr0kugbFTf53O9L',$,$,$,#{SLAB},#{OPENING});"),
    ];
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('slab-hole-corner'),'2;1');\n\
         FILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n{}\nENDSEC;\nEND-ISO-10303-21;\n",
        data.join("\n")
    )
}

/// Edges not used exactly once in each direction, on the kernel position grid,
/// collapsed triangles skipped: 0 iff the mesh closes consistently wound.
fn open_edges(m: &Mesh) -> usize {
    let q = |i: u32| {
        let p = &m.positions[i as usize * 3..i as usize * 3 + 3];
        [0, 1, 2].map(|k| (p[k] as f64 / G).round() as i64)
    };
    let mut uses: HashMap<([i64; 3], [i64; 3]), (u32, u32)> = HashMap::new();
    for t in m.indices.chunks_exact(3) {
        let v = [q(t[0]), q(t[1]), q(t[2])];
        if v[0] == v[1] || v[1] == v[2] || v[2] == v[0] {
            continue;
        }
        for k in 0..3 {
            let (a, b) = (v[k], v[(k + 1) % 3]);
            let e = uses.entry((a.min(b), a.max(b))).or_insert((0, 0));
            if a < b {
                e.0 += 1;
            } else {
                e.1 += 1;
            }
        }
    }
    uses.values().filter(|&&(f, r)| f != 1 || r != 1).count()
}

/// The slab as the router meshes it, uncut and cut, in either vertex frame.
fn slab(content: &str, local_frame: bool) -> (Mesh, Mesh) {
    let mut decoder = EntityDecoder::new(content);
    let entity = decoder.decode_by_id(SLAB).expect("the slab decodes");
    let router = GeometryRouter::with_scale_and_local_frame(1.0, local_frame);
    let voids: FxHashMap<u32, Vec<u32>> = [(SLAB, vec![OPENING])].into_iter().collect();
    let uncut = router
        .process_element(&entity, &mut decoder)
        .expect("the slab meshes");
    let cut = router
        .process_element_with_voids(&entity, &mut decoder, &voids)
        .expect("the slab meshes with its opening");
    (uncut, cut)
}

/// The most a corner moved one step can add to or take from the hole: a
/// sliver along each of the two walls that meet there (the longest is 1.2 m),
/// one step wide at the corner (1.5 covers a step on both axes at once),
/// through the slab's 0.25 m: 5.7e-6 m^3. The largest measured is 3.4e-6.
const AUTHORED_SLIVER: f64 = 0.25 * (1.2 + 0.8) * 0.5 * 1.5 * G;

#[test]
fn issue_6940_an_opening_one_grid_step_off_its_hole_leaves_the_slab_closed() {
    let offsets = [
        [1.0, 0.0],
        [-1.0, 0.0],
        [0.0, 1.0],
        [0.0, -1.0],
        [1.0, 1.0],
        [-1.0, -1.0],
    ];
    for local_frame in [false, true] {
        for corner in 0..4 {
            for [dx, dy] in std::iter::once([0.0, 0.0]).chain(offsets) {
                let what =
                    format!("local_frame={local_frame}, corner {corner} moved ({dx}, {dy}) steps");
                let (uncut, cut) = slab(&slab_ifc(corner, dx, dy), local_frame);
                assert_eq!(open_edges(&uncut), 0, "{what}: the slab arrives closed");
                assert_eq!(
                    open_edges(&cut),
                    0,
                    "{what}: the slab came back torn ({} triangles)",
                    cut.triangle_count()
                );
                let moved = (mesh_volume(&cut) - mesh_volume(&uncut)).abs();
                assert!(
                    moved <= AUTHORED_SLIVER,
                    "{what}: the opening fills a hole, yet the volume moved by {moved} m^3"
                );
            }
        }
    }
}
