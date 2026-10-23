// SPDX-License-Identifier: MPL-2.0
//! Geometry of Disposition::Add, checked in the text the executor writes and
//! in what the geometry engine makes of it.

use crate::plan::add_test_support::*;
use crate::plan::add_types::*;
use crate::plan::test_fixtures::storey_with_typed_wall;
use crate::plan::types::*;

fn with_mesh(schema: &str, mesh: TriangleMesh) -> (Vec<u8>, WriteReport) {
    let source = storey_with_typed_wall(schema);
    run(&source, vec![add(object(IfcClass::BuildingElementProxy, gid(1), Some(ObjectRef::Id(70)), Representation::Mesh(mesh)))])
}

#[test]
fn an_ifc2x3_mesh_is_a_faceted_brep_not_a_triangulated_face_set() {
    let (out, report) = with_mesh("IFC2X3", tetrahedron());
    assert_clean(&report, "IFC2X3");
    assert_eq!(count(&out, "IFCFACETEDBREP"), 1);
    assert_eq!(count(&out, "IFCCLOSEDSHELL"), 1);
    assert_eq!(count(&out, "IFCFACE"), 4, "one face per triangle");
    assert_eq!(count(&out, "IFCTRIANGULATEDFACESET"), 0);
    assert!(String::from_utf8(out).unwrap().contains("'Body','Brep'"));
}

#[test]
fn an_ifc4_or_ifc4x3_mesh_is_a_triangulated_face_set() {
    for schema in ["IFC4", "IFC4X3"] {
        let (out, report) = with_mesh(schema, tetrahedron());
        assert_clean(&report, schema);
        assert_eq!(count(&out, "IFCTRIANGULATEDFACESET"), 1, "{schema}");
        assert_eq!(count(&out, "IFCFACETEDBREP"), 0, "{schema}");
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("((1,3,2),(1,2,4),(2,3,4),(1,4,3))"), "{schema}: 1-based CoordIndex");
        assert!(text.contains(".T."), "{schema}: a closed mesh says so");
    }
}

/// A brep asserts a solid, so an open mesh in IFC2X3 is a surface model.
#[test]
fn an_open_ifc2x3_mesh_is_a_surface_model_not_a_brep() {
    let mut open = tetrahedron();
    open.triangles.pop();
    let (out, report) = with_mesh("IFC2X3", open);
    assert_clean(&report, "IFC2X3");
    assert_eq!(count(&out, "IFCFACETEDBREP"), 0);
    assert_eq!(count(&out, "IFCSHELLBASEDSURFACEMODEL"), 1);
    assert_eq!(count(&out, "IFCOPENSHELL"), 1);
}

/// The geometry engine meshes what Add wrote, in every schema, for both
/// solid tiers, with the requested colour (which in IFC2X3 goes through an
/// IfcPresentationStyleAssignment).
#[test]
fn the_engine_meshes_added_geometry_in_its_colour() {
    let colour = SurfaceColour { rgb: [0.8, 0.2, 0.1], transparency: 0.0 };
    for schema in SCHEMAS {
        let source = storey_with_typed_wall(schema);
        let mut wall = object(IfcClass::Wall, gid(1), Some(ObjectRef::Id(70)), Representation::Extrusion(block(4.0, 0.25, 3.0)));
        wall.style = Some(colour);
        let mut proxy = object(IfcClass::BuildingElementProxy, gid(2), Some(ObjectRef::Id(70)), Representation::Mesh(tetrahedron()));
        proxy.style = Some(colour);
        let (out, report) = run(&source, vec![add(wall), add(proxy)]);
        assert_clean(&report, schema);

        let result = ifc_lite_processing::process_geometry(&out);
        for (g, extent) in [(gid(1), [4.0, 0.25, 3.0]), (gid(2), [1.0, 1.0, 1.0])] {
            let id = id_in(&out, g);
            let mesh = result.meshes.iter().find(|m| m.express_id == id).unwrap_or_else(|| panic!("{schema}: #{id} not meshed"));
            assert!(!mesh.indices.is_empty(), "{schema}: #{id} has triangles");
            // Compared as sorted extents: the engine may swap Y and Z into its viewer frame.
            let mut got: Vec<f64> = (0..3)
                .map(|axis| {
                    let vals = mesh.positions.iter().skip(axis).step_by(3);
                    let (lo, hi) = vals.fold((f32::MAX, f32::MIN), |(lo, hi), &v| (lo.min(v), hi.max(v)));
                    f64::from(hi - lo)
                })
                .collect();
            let mut want = extent.to_vec();
            got.sort_by(f64::total_cmp);
            want.sort_by(f64::total_cmp);
            for (a, b) in got.iter().zip(&want) {
                assert!((a - b).abs() < 1e-4, "{schema}: #{id} extent {got:?} vs {want:?}");
            }
            let [r, gr, b, _] = mesh.color;
            assert!((r - 0.8).abs() < 1e-3 && (gr - 0.2).abs() < 1e-3 && (b - 0.1).abs() < 1e-3, "{schema}: #{id} colour {:?}", mesh.color);
        }
    }
}

#[test]
fn a_source_without_a_representation_context_gets_one_attached_to_its_project() {
    for schema in SCHEMAS {
        let source = String::from_utf8(storey_with_typed_wall(schema)).unwrap();
        let source = source
            .lines()
            .filter(|l| !l.starts_with("#100=") && !l.starts_with("#101=") && !l.starts_with("#102="))
            .map(|l| if l.starts_with("#1=") { l.replace("(#100)", "$") } else { l.to_string() })
            .collect::<Vec<_>>()
            .join("\n");
        let wall = object(IfcClass::Wall, gid(1), Some(ObjectRef::Id(70)), Representation::Extrusion(block(1.0, 1.0, 1.0)));
        let door = object(IfcClass::Door, gid(2), Some(ObjectRef::Id(70)), Representation::Extrusion(block(1.0, 1.0, 1.0)));
        let (out, report) = run(source.as_bytes(), vec![add(wall), add(door)]);
        assert_clean(&report, schema);
        assert_eq!(count(&out, "IFCGEOMETRICREPRESENTATIONCONTEXT"), 1, "{schema}: synthesized once, shared");
        let text = String::from_utf8(out.clone()).unwrap();
        let context = ids_of_type(&out, "IFCGEOMETRICREPRESENTATIONCONTEXT")[0];
        let project = text.lines().find(|l| l.starts_with("#1=")).unwrap();
        assert!(project.contains(&format!("(#{context})")), "{schema}: {project}");
    }
}

#[test]
fn geometry_that_cannot_be_written_validly_is_refused() {
    let source = storey_with_typed_wall("IFC4");
    let cases: Vec<(Representation, &str)> = vec![
        (Representation::Mesh(TriangleMesh { positions: vec![[0.0; 3]; 3], triangles: vec![[0, 1, 3]] }), "indexes past"),
        (Representation::Mesh(TriangleMesh { positions: vec![[0.0; 3]; 3], triangles: vec![[0, 1, 1]] }), "repeats a vertex"),
        (Representation::Extrusion(Extrusion { profile: vec![[0.0, 0.0], [1.0, 0.0], [2.0, 0.0]], voids: Vec::new(), direction: [0.0, 0.0, 1.0], depth: 1.0 }), "no area"),
        (Representation::Extrusion(Extrusion { direction: [1.0, 0.0, 0.0], ..block(1.0, 1.0, 1.0) }), "leave the profile plane"),
        (Representation::Extrusion(Extrusion { depth: f64::NAN, ..block(1.0, 1.0, 1.0) }), "depth"),
    ];
    for (rep, expect) in cases {
        let (_, report) = run(&source, vec![add(object(IfcClass::Wall, gid(9), None, rep))]);
        assert_eq!(report.added, 0, "{expect}");
        assert!(report.refusals[0].reason.contains(expect), "{expect}: {:?}", report.refusals);
    }
    let mut bad_colour = object(IfcClass::Wall, gid(9), None, Representation::Extrusion(block(1.0, 1.0, 1.0)));
    bad_colour.style = Some(SurfaceColour { rgb: [1.5, 0.0, 0.0], transparency: 0.0 });
    let (_, report) = run(&source, vec![add(bad_colour)]);
    assert!(report.refusals[0].reason.contains("0..1"), "{:?}", report.refusals);
}

/// IFC2X3 declares `IfcStyledItem.Styles` as `SET OF
/// IfcPresentationStyleAssignment`; IFC4 widened it to
/// `IfcStyleAssignmentSelect`, which takes the surface style directly. The
/// geometry engine reads either shape, so only the text can tell them apart.
#[test]
fn a_styled_item_points_at_what_its_schema_declares() {
    for (schema, target) in [("IFC2X3", "IFCPRESENTATIONSTYLEASSIGNMENT"), ("IFC4", "IFCSURFACESTYLE"), ("IFC4X3", "IFCSURFACESTYLE")] {
        let source = storey_with_typed_wall(schema);
        let mut wall = object(IfcClass::Wall, gid(1), None, Representation::Extrusion(block(1.0, 1.0, 1.0)));
        wall.style = Some(SurfaceColour { rgb: [0.5, 0.5, 0.5], transparency: 0.25 });
        let (out, report) = run(&source, vec![add(wall)]);
        assert_clean(&report, schema);
        let mut decoder = ifc_lite_core::EntityDecoder::new(&out);
        let styled = ids_of_type(&out, "IFCSTYLEDITEM")[0];
        let styles = decoder.decode_by_id(styled).unwrap().get_refs(1).unwrap();
        assert_eq!(styles.len(), 1, "{schema}");
        assert_eq!(type_in(&out, styles[0]), target, "{schema}");
    }
}

/// A geometry patch and an Add in one plan, in a file with no context, share
/// the one context the first of them creates.
#[test]
fn a_geometry_patch_and_an_add_share_one_synthesized_context() {
    for schema in SCHEMAS {
        let source = String::from_utf8(storey_with_typed_wall(schema)).unwrap();
        let source = source
            .lines()
            .filter(|l| !l.starts_with("#100=") && !l.starts_with("#101=") && !l.starts_with("#102="))
            .map(|l| if l.starts_with("#1=") { l.replace("(#100)", "$") } else { l.to_string() })
            .collect::<Vec<_>>()
            .join("\n");
        let patch = Patch { geometry: Some(GeometryPatch { mesh: tetrahedron(), colour: None }), ..Default::default() };
        let wall = object(IfcClass::Wall, gid(1), Some(ObjectRef::Id(70)), Representation::Extrusion(block(1.0, 1.0, 1.0)));
        let (out, report) = run(source.as_bytes(), vec![(ObjectRef::Id(10), Disposition::Patch(patch)), add(wall)]);
        assert_clean(&report, schema);
        let contexts = ids_of_type(&out, "IFCGEOMETRICREPRESENTATIONCONTEXT");
        assert_eq!(contexts.len(), 1, "{schema}: one context for both");
        let text = String::from_utf8(out).unwrap();
        let project = text.lines().find(|l| l.starts_with("#1=")).unwrap();
        assert!(project.contains(&format!("(#{})", contexts[0])), "{schema}: {project}");
    }
}
