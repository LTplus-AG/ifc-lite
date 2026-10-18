// SPDX-License-Identifier: MPL-2.0
//! Platform extraction qualification: retained raw item construction must preserve
//! production buffers after IFC bytes, decoder and router have been disposed.
//! This deliberately excludes product placement, RTC and presentation assembly.

use ifc_lite_core::{EntityDecoder, IfcSchema};
use ifc_lite_geometry::{
    AdvancedBrepProcessor, BooleanClippingProcessor, ExtrudedAreaSolidProcessor, FacetedBrepProcessor,
    FaceBasedSurfaceModelProcessor, SurfaceOfLinearExtrusionProcessor,
    GeometryProcessor, GeometryRouter, Mesh, PolygonalFaceSetProcessor, TessellationQuality,
};

fn assert_mesh_bytes(id: u32, expected: &Mesh, actual: &Mesh) {
    let bits32 = |values: &[f32]| values.iter().map(|v| v.to_bits()).collect::<Vec<_>>();
    assert_eq!(bits32(&actual.positions), bits32(&expected.positions), "#{id} positions");
    assert_eq!(bits32(&actual.normals), bits32(&expected.normals), "#{id} normals");
    assert_eq!(actual.indices, expected.indices, "#{id} indices");
    assert_eq!(actual.origin.map(f64::to_bits), expected.origin.map(f64::to_bits), "#{id} origin");
    assert_eq!(actual.rtc_applied, expected.rtc_applied, "#{id} RTC state");
    assert_eq!(actual.welded_in_object_frame, expected.welded_in_object_frame, "#{id} weld state");
    assert_eq!(actual.local_bounds.map(|v| v.map(f32::to_bits)),
        expected.local_bounds.map(|v| v.map(f32::to_bits)), "#{id} bounds");
    assert_eq!(actual.local_to_world.map(|v| v.map(f64::to_bits)),
        expected.local_to_world.map(|v| v.map(f64::to_bits)), "#{id} transform");
    let plane_bits = |mesh: &Mesh| mesh.plane_tags.as_ref().map(|tags| tags.iter()
        .map(|tag| (tag.n.map(f64::to_bits), tag.d.to_bits())).collect::<Vec<_>>());
    assert_eq!(plane_bits(actual), plane_bits(expected), "#{id} kernel planes");
    assert!(expected.instance_meta.is_none() && actual.instance_meta.is_none(),
        "raw constructors must not introduce product instancing metadata for #{id}");
}

fn compare_raw_items(source: String, items: &[(u32, &dyn GeometryProcessor)]) {
    let schema = IfcSchema::new();
    let mut decoder = EntityDecoder::new(&source);
    let expected: Vec<_> = items.iter().map(|(id, processor)| {
        assert!(processor.take_bool_failures().is_empty(), "fresh processor diagnostics");
        let entity = decoder.decode_by_id(*id).unwrap();
        let mesh = processor.process(&entity, &mut decoder, &schema, TessellationQuality::Medium)
            .unwrap_or_else(|error| panic!("raw production item #{id}: {error}"));
        assert!(!mesh.is_empty(), "qualification item #{id} must exercise geometry");
        (mesh, processor.take_bool_failures())
    }).collect();
    drop(decoder);

    let ids: Vec<_> = items.iter().map(|(id, _)| *id).collect();
    let router = GeometryRouter::new();
    let mut decoder = EntityDecoder::new(&source);
    let batch = router.plan_construction_items(&mut decoder, &ids, ids.len()).unwrap();
    for node in batch.nodes() {
        assert!(node.requirement().is_none(), "item #{}: {:?}", node.source_id(), node.requirement());
    }
    drop(decoder);
    drop(router);
    drop(source);

    // Evaluation starts after the source lifetime ends. Boolean losses belong to
    // the owned result; face/curve reports travel with it independently of caller TLS.
    let compiled_reports = batch.reports().clone();
    let replay = batch.clone().evaluate().unwrap();
    let evaluated = batch.evaluate().unwrap();
    assert_eq!(evaluated.reports, replay.reports, "owned face/cap/decoder evidence must replay");
    assert_eq!(evaluated.observed_diagnostics, replay.observed_diagnostics);
    assert!(!compiled_reports.curve_capped || evaluated.reports.curve_capped);
    for face_type in &compiled_reports.face_refused {
        assert!(evaluated.reports.face_refused.contains(face_type), "retain source face refusals");
    }
    for record_id in &compiled_reports.decoder_refused_record_ids {
        assert!(evaluated.reports.decoder_refused_record_ids.contains(record_id), "retain source record refusals");
    }
    eprintln!("raw item qualification {ids:?}: {:?}", evaluated.reports);
    assert_eq!(evaluated.definitions.len(), ids.len());
    assert_eq!(evaluated.occurrences, (0..ids.len()).collect::<Vec<_>>());
    assert_eq!(evaluated.diagnostics.len(), ids.len());
    for (index, (mesh, diagnostics)) in expected.iter().enumerate() {
        assert_mesh_bytes(ids[index], mesh, &evaluated.definitions[index]);
        assert_eq!(&evaluated.diagnostics[index], diagnostics, "#{} boolean losses", ids[index]);
    }
}

#[test]
fn exported_wall_roof_polygons_and_ordered_cuts_preserve_raw_production_bytes() {
    let polygon = PolygonalFaceSetProcessor::new();
    let boolean = BooleanClippingProcessor::new();
    compare_raw_items(include_str!("fixtures/issue_4560_wall_roof_polygonal_cutters.ifc").to_owned(), &[
        (332, &polygon), (339, &polygon), (424, &polygon), (431, &polygon),
        (1399, &polygon), (1440, &polygon), (1448, &polygon),
        (1449, &boolean), (1450, &boolean),
    ]);
}

#[test]
fn bath_rounded_profile_and_coplanar_difference_preserve_raw_production_bytes() {
    let extrusion = ExtrudedAreaSolidProcessor::new(IfcSchema::new());
    let boolean = BooleanClippingProcessor::new();
    compare_raw_items(include_str!("fixtures/bath_csg_solid.ifc").to_owned(), &[
        (206, &extrusion), (207, &boolean),
    ]);
}

#[test]
fn exported_house_faceted_items_preserve_serial_and_parallel_raw_production_bytes() {
    let Some(source) = ifc_lite_testkit::fixture_text("ara3d/AC20-FZK-Haus.ifc") else { return; };
    let faceted = FacetedBrepProcessor::new();
    compare_raw_items(source, &[(17446, &faceted), (66059, &faceted), (13124, &faceted)]);
}

#[test]
fn exported_large_model_faceted_items_preserve_raw_production_bytes() {
    let Some(source) = ifc_lite_testkit::fixture_text(
        "ara3d/ISSUE_129_N1540_17_EXE_MOD_448200_02_09_11SMC_IGC_V17.ifc") else { return; };
    let faceted = FacetedBrepProcessor::new();
    compare_raw_items(source, &[(219624, &faceted), (233183, &faceted), (328707, &faceted)]);
}


#[test]
fn catalogue_advanced_brep_curved_and_planar_shells_preserve_raw_production_bytes() {
    let advanced = AdvancedBrepProcessor::new();
    let Some(basin) = ifc_lite_testkit::fixture_text(
        "buildingsmart/annex_e/advanced-geometric-shape/basin-advanced-brep.ifc") else { return; };
    compare_raw_items(basin, &[(612, &advanced)]);
    let Some(cube) = ifc_lite_testkit::fixture_text(
        "buildingsmart/annex_e/advanced-geometric-shape/cube-advanced-brep.ifc") else { return; };
    compare_raw_items(cube, &[(180, &advanced)]);
}

#[test]
fn revit_space_boundary_surfaces_and_face_models_preserve_raw_production_bytes() {
    let Some(source) = ifc_lite_testkit::fixture_text("ara3d/duplex.ifc") else { return; };
    let surface = SurfaceOfLinearExtrusionProcessor::new();
    let faces = FaceBasedSurfaceModelProcessor::new();
    // Original Revit 2011 space-boundary strips include nonzero constructor
    // Position and several profile directions; face models exercise collection
    // and face admission on the same actual export.
    compare_raw_items(source, &[
        (96, &surface), (103, &surface), (111, &surface), (118, &surface),
        (125, &surface), (133, &surface), (816, &faces), (2409, &faces),
    ]);
}

#[test]
fn exported_large_model_face_collections_preserve_raw_production_bytes() {
    let Some(source) = ifc_lite_testkit::fixture_text(
        "ara3d/ISSUE_129_N1540_17_EXE_MOD_448200_02_09_11SMC_IGC_V17.ifc") else { return; };
    let faces = FaceBasedSurfaceModelProcessor::new();
    compare_raw_items(source, &[(18156, &faces), (22990, &faces), (27760, &faces), (32424, &faces)]);
}
