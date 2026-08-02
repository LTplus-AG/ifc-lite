// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #1910 — geometry hanging off `IfcBuilding` never rendered.
//!
//! A terrain/DGM export attaches its surface model directly to `IfcBuilding`,
//! leaves every placement at the origin, and bakes raw projected (UTM)
//! coordinates into the vertices. The file loaded with correct metadata and
//! hierarchy but rendered nothing.
//!
//! `is_non_geometric_spatial` blocked `IfcBuilding`, so `has_geometry_by_name`
//! returned false and the building never became a geometry job at all — the
//! reported `(0,0,0)` RTC offset is downstream of that, not the cause: with no
//! job to sample, RTC detection had nothing to look at and fell through to the
//! placement-bounds scan, which sees only origin placements.
//!
//! Same shape as #1075, which unblocked `IfcSpatialZone` once real exporters
//! were found emitting it with a body. The gate only *permits* meshing; a
//! building with no representation still produces nothing.

use ifc_lite_processing::process_geometry;

/// The reported file's shape: `IfcShellBasedSurfaceModel` on `IfcBuilding`,
/// `IfcMapConversion` with zero eastings/northings, every placement at the
/// origin, vertices carrying full EPSG:25832 coordinates.
const TERRAIN_ON_BUILDING: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-1910 terrain on IfcBuilding'),'2;1');
FILE_NAME('dgm.ifc','2026-08-02T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCDIRECTION((0.,0.,1.));
#3=IFCDIRECTION((1.,0.,0.));
#15=IFCAXIS2PLACEMENT3D(#1,#2,#3);
#16=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#17=IFCUNITASSIGNMENT((#16));
#19=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#15,$);
#20=IFCPROJECT('1Project00000000001910',$,'P',$,$,$,$,(#19),#17);
#21=IFCPROJECTEDCRS('EPSG:25832',$,$,$,$,$,$);
#22=IFCMAPCONVERSION(#19,#21,0.,0.,0.,1.,0.,1.);
#30=IFCCARTESIANPOINT((496742.45807390002,5556616.4791799998,109.6418231));
#31=IFCCARTESIANPOINT((496752.45807390002,5556616.4791799998,109.6418231));
#32=IFCCARTESIANPOINT((496752.45807390002,5556626.4791799998,110.6418231));
#33=IFCCARTESIANPOINT((496742.45807390002,5556626.4791799998,110.6418231));
#40=IFCPOLYLOOP((#30,#31,#32,#33));
#41=IFCFACEOUTERBOUND(#40,.T.);
#42=IFCFACE((#41));
#43=IFCOPENSHELL((#42));
#44=IFCSHELLBASEDSURFACEMODEL((#43));
#45=IFCSHAPEREPRESENTATION(#19,'Horizont30','Tessellation',(#44));
#46=IFCPRODUCTDEFINITIONSHAPE($,$,(#45));
#50=IFCLOCALPLACEMENT($,#15);
#51=IFCBUILDING('1Building000000001910',$,'Horizont30',$,$,#50,#46,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
"#;

/// Origin-local twin with a NON-identity building placement, to prove the
/// placement is applied exactly once. `building_transform` is also derived from
/// this same placement and shipped as view-orientation metadata, so a building
/// that now also meshes must not have it folded in twice.
const TRANSLATED_BUILDING: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-1910 translated building placement'),'2;1');
FILE_NAME('t.ifc','2026-08-02T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));
#15=IFCAXIS2PLACEMENT3D(#1,$,$);
#16=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#17=IFCUNITASSIGNMENT((#16));
#19=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#15,$);
#20=IFCPROJECT('1Project00000000191002',$,'P',$,$,$,$,(#19),#17);
#25=IFCCARTESIANPOINT((10.,20.,0.));
#26=IFCAXIS2PLACEMENT3D(#25,$,$);
#27=IFCLOCALPLACEMENT($,#26);
#30=IFCCARTESIANPOINT((1.,2.,3.));
#31=IFCCARTESIANPOINT((2.,2.,3.));
#32=IFCCARTESIANPOINT((2.,3.,3.));
#40=IFCPOLYLOOP((#30,#31,#32));
#41=IFCFACEOUTERBOUND(#40,.T.);
#42=IFCFACE((#41));
#43=IFCOPENSHELL((#42));
#44=IFCSHELLBASEDSURFACEMODEL((#43));
#45=IFCSHAPEREPRESENTATION(#19,'Body','SurfaceModel',(#44));
#46=IFCPRODUCTDEFINITIONSHAPE($,$,(#45));
#51=IFCBUILDING('1Building000000191002',$,'B',$,$,#27,#46,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
"#;

/// An `IfcBuilding` with no `Representation` — the overwhelmingly common case.
/// Unblocking the class must not conjure geometry for it.
const PLAIN_BUILDING: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-1910 plain building'),'2;1');
FILE_NAME('p.ifc','2026-08-02T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));
#15=IFCAXIS2PLACEMENT3D(#1,$,$);
#16=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#17=IFCUNITASSIGNMENT((#16));
#19=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#15,$);
#20=IFCPROJECT('1Project00000000191003',$,'P',$,$,$,$,(#19),#17);
#27=IFCLOCALPLACEMENT($,#15);
#51=IFCBUILDING('1Building000000191003',$,'B',$,$,#27,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn terrain_attached_to_building_is_meshed() {
    let result = process_geometry(&TERRAIN_ON_BUILDING.to_string());

    // Pre-fix: 0 meshes — the building was never a geometry job.
    let building_meshes: Vec<_> = result
        .meshes
        .iter()
        .filter(|m| m.express_id == 51)
        .collect();
    assert_eq!(
        building_meshes.len(),
        1,
        "IfcBuilding terrain must mesh; got {} mesh(es) total",
        result.meshes.len()
    );
    assert!(
        !building_meshes[0].positions.is_empty(),
        "meshed but empty positions"
    );
}

#[test]
fn building_hosted_raw_coordinates_are_rtc_rebased() {
    let result = process_geometry(&TERRAIN_ON_BUILDING.to_string());

    // With the building sampled, RTC detection reads its first raw vertex and
    // re-bases. Pre-fix there was nothing to sample, the offset came out at the
    // placement-bounds midpoint, and full UTM values reached the f32 buffer —
    // where the ULP at northing 5.5e6 is ~0.5 m and metre-scale triangles
    // collapse.
    assert_eq!(
        result.mesh_coordinate_space.as_deref(),
        Some("model_rtc"),
        "raw projected coordinates must be re-based"
    );

    let mesh = result
        .meshes
        .iter()
        .find(|m| m.express_id == 51)
        .expect("building mesh");
    let mut mins = [f64::INFINITY; 3];
    let mut maxs = [f64::NEG_INFINITY; 3];
    for chunk in mesh.positions.chunks(3) {
        let world = [
            chunk[0] as f64 + mesh.origin[0] as f64,
            chunk[1] as f64 + mesh.origin[1] as f64,
            chunk[2] as f64 + mesh.origin[2] as f64,
        ];
        for (axis, v) in world.iter().enumerate() {
            mins[axis] = mins[axis].min(*v);
            maxs[axis] = maxs[axis].max(*v);
            assert!(
                v.abs() < 1_000.0,
                "axis {axis} still carries raw magnitude {v} after re-basing",
            );
        }
    }

    // Small coordinates alone do not prove the fix: a mesh collapsed to the
    // origin — the exact f32 failure mode this issue is about — would also pass
    // the check above. Assert the terrain kept its SIZE. The fixture's quad
    // spans 10 m x 10 m x 1 m; sorted so the assertion does not depend on axis
    // order or any later Z-up/Y-up convention change.
    let mut extents: Vec<f64> = (0..3).map(|axis| maxs[axis] - mins[axis]).collect();
    extents.sort_by(f64::total_cmp);
    for (got, want) in extents.iter().zip([1.0, 10.0, 10.0]) {
        assert!(
            (got - want).abs() < 1e-3,
            "extents {extents:?} do not match the fixture's 10x10x1 m quad",
        );
    }
}

#[test]
fn building_placement_is_applied_exactly_once() {
    let result = process_geometry(&TRANSLATED_BUILDING.to_string());

    let mesh = result
        .meshes
        .iter()
        .find(|m| m.express_id == 51)
        .expect("building mesh");

    // Vertex (1,2,3) under a building placement translated by (10,20,0).
    // Applied once → (11,22,3). Applied twice → (21,42,3).
    let mut xs: Vec<f64> = Vec::new();
    let mut ys: Vec<f64> = Vec::new();
    for chunk in mesh.positions.chunks(3) {
        xs.push(chunk[0] as f64 + mesh.origin[0] as f64);
        ys.push(chunk[1] as f64 + mesh.origin[1] as f64);
    }
    let min_x = xs.iter().cloned().fold(f64::INFINITY, f64::min);
    let min_y = ys.iter().cloned().fold(f64::INFINITY, f64::min);

    assert!(
        (min_x - 11.0).abs() < 1e-6,
        "min x = {min_x}, expected 11 (placement applied once; 21 means twice)",
    );
    assert!(
        (min_y - 22.0).abs() < 1e-6,
        "min y = {min_y}, expected 22 (placement applied once; 42 means twice)",
    );
}

#[test]
fn building_without_representation_produces_nothing() {
    let result = process_geometry(&PLAIN_BUILDING.to_string());
    assert!(
        result.meshes.iter().all(|m| m.express_id != 51),
        "a representation-less IfcBuilding must not produce geometry",
    );
}
