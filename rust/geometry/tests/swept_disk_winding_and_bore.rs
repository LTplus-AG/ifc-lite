// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `IfcSweptDiskSolid` meshing, pinned against the geometry it claims to
//! produce (rust review follow-up, findings D1 and D9 in the void/sweep
//! bookkeeping class).
//!
//! D1: the side walls were wound radially INWARD while both end caps were
//! wound outward, so every swept disk was a mixed-winding shell. The
//! directed-edge closure gate that admits a cutter to a batched void group
//! rejected it, and the shipped per-vertex normals pointed into the tube.
//!
//! D9: `InnerRadius` was parsed and discarded, so a hollow tube meshed as a
//! solid rod with no diagnostic and the wrong volume.
//!
//! The fixture is a straight 1 m bar along +X in millimetres: `#50` a rod
//! (radius 50 mm) and `#60` a tube (radius 50 mm, bore 30 mm), both swept
//! along the same two-point `IfcPolyline`.

use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::kernel::mesh_volume::mesh_volume;
use ifc_lite_geometry::{GeometryRouter, Mesh, Vector3};
use std::collections::HashMap;

const RADIUS_M: f64 = 0.05;
const BORE_M: f64 = 0.03;
const LENGTH_M: f64 = 1.0;

const FIXTURE: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('swept_disk_winding_and_bore.ifc','2026-09-12T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#2=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#3=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);
#4=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);
#5=IFCUNITASSIGNMENT((#1,#2,#3,#4));
#10=IFCCARTESIANPOINT((0.,0.,0.));
#11=IFCDIRECTION((0.,0.,1.));
#12=IFCDIRECTION((1.,0.,0.));
#13=IFCAXIS2PLACEMENT3D(#10,#11,#12);
#14=IFCDIRECTION((0.,1.));
#15=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#13,#14);
#16=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#15,$,.MODEL_VIEW.,$);
#20=IFCPROJECT('0000000000000000000001',$,'SweptDiskWindingAndBore',$,$,$,$,(#15),#5);
#30=IFCLOCALPLACEMENT($,#13);
#40=IFCCARTESIANPOINT((1000.,0.,0.));
#41=IFCPOLYLINE((#10,#40));
#43=IFCSWEPTDISKSOLID(#41,50.,$,$,$);
#44=IFCSHAPEREPRESENTATION(#16,'Body','AdvancedSweptSolid',(#43));
#45=IFCPRODUCTDEFINITIONSHAPE($,$,(#44));
#50=IFCBUILDINGELEMENTPROXY('0000000000000000000002',$,'Rod',$,$,#30,#45,$,$);
#53=IFCSWEPTDISKSOLID(#41,50.,30.,$,$);
#54=IFCSHAPEREPRESENTATION(#16,'Body','AdvancedSweptSolid',(#53));
#55=IFCPRODUCTDEFINITIONSHAPE($,$,(#54));
#60=IFCBUILDINGELEMENTPROXY('0000000000000000000003',$,'Tube',$,$,#30,#55,$,$);
ENDSEC;
END-ISO-10303-21;
"#;

fn mesh_element(id: u32) -> Mesh {
    let entity_index = ifc_lite_core::build_entity_index(FIXTURE);
    let mut decoder = EntityDecoder::with_index(FIXTURE, entity_index);
    let router = GeometryRouter::with_units(FIXTURE, &mut decoder);
    let element = decoder
        .decode_by_id(id)
        .unwrap_or_else(|e| panic!("decode #{id}: {e}"));
    let mesh = router
        .process_element(&element, &mut decoder)
        .unwrap_or_else(|e| panic!("process #{id}: {e}"));
    assert!(mesh.triangle_count() > 0, "#{id} meshed to nothing");
    mesh
}

fn vertex(mesh: &Mesh, i: u32) -> Vector3<f64> {
    let b = i as usize * 3;
    Vector3::new(
        mesh.positions[b] as f64,
        mesh.positions[b + 1] as f64,
        mesh.positions[b + 2] as f64,
    )
}

/// The exact-bits directed-edge closure the void router's batch admission
/// gate applies (`mesh_is_closed_exact`): every directed edge is matched by
/// its reverse. A mixed-winding shell fails this even when it is
/// geometrically watertight.
fn directed_edges_balance(mesh: &Mesh) -> bool {
    let key = |i: u32| {
        let b = i as usize * 3;
        (
            mesh.positions[b].to_bits(),
            mesh.positions[b + 1].to_bits(),
            mesh.positions[b + 2].to_bits(),
        )
    };
    let mut edges: HashMap<_, i64> = HashMap::new();
    for t in mesh.indices.chunks_exact(3) {
        let k = [key(t[0]), key(t[1]), key(t[2])];
        for (u, v) in [(0usize, 1usize), (1, 2), (2, 0)] {
            if k[u] == k[v] {
                return false;
            }
            *edges.entry((k[u], k[v])).or_insert(0) += 1;
            *edges.entry((k[v], k[u])).or_insert(0) -= 1;
        }
    }
    edges.values().all(|&c| c == 0)
}

/// One triangle, classified against the bar's own axis (+X through the
/// origin): a cap has its normal along the axis, a wall has it in the
/// cross-section plane.
struct Face {
    normal: Vector3<f64>,
    centroid: Vector3<f64>,
}

impl Face {
    fn radial(&self) -> Vector3<f64> {
        Vector3::new(0.0, self.centroid.y, self.centroid.z)
    }
    fn is_cap(&self) -> bool {
        self.normal.x.abs() > 0.9 * self.normal.norm()
    }
}

fn faces(mesh: &Mesh) -> Vec<Face> {
    mesh.indices
        .chunks_exact(3)
        .map(|t| {
            let (a, b, c) = (vertex(mesh, t[0]), vertex(mesh, t[1]), vertex(mesh, t[2]));
            Face { normal: (b - a).cross(&(c - a)), centroid: (a + b + c) / 3.0 }
        })
        .collect()
}

/// Every wall triangle's geometric normal points AWAY from the material and
/// both caps point along the axis away from the bar. Mutation: flipping
/// either side-wall triangle in `build_tube` back to the old order fails the
/// wall assertion on all 48 wall faces; flipping a cap fails the cap one.
#[test]
fn swept_disk_side_walls_face_outward() {
    let mesh = mesh_element(50);
    let (mut walls, mut caps) = (0usize, 0usize);
    for f in faces(&mesh) {
        if f.is_cap() {
            caps += 1;
            let along = if f.centroid.x > LENGTH_M / 2.0 { 1.0 } else { -1.0 };
            assert!(
                f.normal.x * along > 0.0,
                "cap at x={:.3} faces into the bar: normal {:?}",
                f.centroid.x,
                f.normal
            );
        } else {
            walls += 1;
            assert!(
                f.normal.dot(&f.radial()) > 0.0,
                "side wall wound inward at {:?}: normal {:?}",
                f.centroid,
                f.normal
            );
        }
    }
    assert!(walls >= 40 && caps >= 20, "unexpected face split: {walls} walls, {caps} caps");

    let vol = mesh_volume(&mesh);
    let expected = std::f64::consts::PI * RADIUS_M * RADIUS_M * LENGTH_M;
    assert!(
        (vol - expected).abs() < 0.02 * expected,
        "signed volume {vol:.6} m^3, expected ~{expected:.6} (a positive rod)"
    );
    assert!(
        directed_edges_balance(&mesh),
        "rod is not a closed directed shell: the void batch gate would reject it"
    );
}

/// `InnerRadius` bores the tube: the mesh encloses an annulus, not a rod, the
/// bore wall faces the axis, and no vertex sits on the axis. Mutation:
/// dropping `inner_radius` back to `None` in the processor fails the volume
/// and the on-axis-vertex assertions; winding the bore wall outward fails the
/// bore-wall assertion.
#[test]
fn swept_disk_inner_radius_bores_the_tube() {
    let mesh = mesh_element(60);

    let vol = mesh_volume(&mesh);
    let expected = std::f64::consts::PI * (RADIUS_M * RADIUS_M - BORE_M * BORE_M) * LENGTH_M;
    assert!(
        (vol - expected).abs() < 0.02 * expected,
        "signed volume {vol:.6} m^3, expected ~{expected:.6} (an annulus, not a rod)"
    );

    let min_radial = mesh
        .positions
        .chunks_exact(3)
        .map(|p| ((p[1] as f64).powi(2) + (p[2] as f64).powi(2)).sqrt())
        .fold(f64::INFINITY, f64::min);
    assert!(
        min_radial > 0.9 * BORE_M,
        "a vertex sits inside the bore (radial {min_radial:.4} m): the tube meshed solid"
    );

    let (mut outer, mut inner) = (0usize, 0usize);
    for f in faces(&mesh).into_iter().filter(|f| !f.is_cap()) {
        let r = f.radial().norm();
        let facing = f.normal.dot(&f.radial());
        if r > (RADIUS_M + BORE_M) / 2.0 {
            outer += 1;
            assert!(facing > 0.0, "outer wall wound inward at {:?}", f.centroid);
        } else {
            inner += 1;
            assert!(facing < 0.0, "bore wall faces away from the axis at {:?}", f.centroid);
        }
    }
    assert!(outer >= 40 && inner >= 40, "unexpected wall split: {outer} outer, {inner} bore");
    assert!(directed_edges_balance(&mesh), "tube is not a closed directed shell");
}
