// SPDX-License-Identifier: MPL-2.0
use super::*;
use ifc_lite_geometry::GeometryRouter;
use ifc_lite_testkit::step_file;

fn slab(unit: &str, shift: f64) -> String {
    step_file("IFC4", &[
        "#1=IFCPROJECT('0M7tQ9Jbj1BAeHd7rqnDmQ',$,'Project',$,$,$,$,(#10),#4);".into(),
        format!("#2=IFCSIUNIT(*,.LENGTHUNIT.,{unit},.METRE.);"),
        "#4=IFCUNITASSIGNMENT((#2));".into(),
        "#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#11,$);".into(),
        "#11=IFCAXIS2PLACEMENT3D(#12,$,$);".into(),
        "#12=IFCCARTESIANPOINT((0.,0.,0.));".into(),
        format!("#20=IFCCARTESIANPOINT(({shift},0.,0.));"),
        "#21=IFCAXIS2PLACEMENT3D(#20,$,$);".into(),
        "#22=IFCLOCALPLACEMENT($,#21);".into(),
        "#41=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,10.,8.);".into(),
        "#42=IFCEXTRUDEDAREASOLID(#41,#11,#43,2.);".into(),
        "#43=IFCDIRECTION((0.,0.,1.));".into(),
        "#44=IFCSHAPEREPRESENTATION(#10,'Body','SweptSolid',(#42));".into(),
        "#45=IFCPRODUCTDEFINITIONSHAPE($,$,(#44));".into(),
        "#50=IFCSLAB('0M7tQ9Jbj1BAeHd7rqnDmR',$,'Slab',$,$,#22,#45,$,.FLOOR.);".into(),
    ])
}

fn volume(part: &SectionExportPart) -> f64 {
    let vertex = |i: u32| { let i = i as usize * 3; [part.positions[i], part.positions[i+1], part.positions[i+2]] };
    part.indices.chunks_exact(3).map(|t| v3::dot(vertex(t[0]), v3::cross(vertex(t[1]),vertex(t[2])))).sum::<f64>().abs() / 6.0
}

#[test]
fn issue_7711_caps_multiple_sections_and_preserves_inside_and_whole_modes() {
    let source = slab("$", 0.0);
    let planes = [SectionExportPlane { normal: [1.,0.,0.], offset: 0. },
        SectionExportPlane { normal: [0.,1.,0.], offset: 0. }];
    let plan = plan_section_export(source.as_bytes(), &planes, true).unwrap();
    assert!(plan.outside.is_empty());
    assert_eq!(plan.replacements.len(), 1);
    assert_eq!(plan.replacements[0].express_id, 50);
    let part = &plan.replacements[0].parts[0];
    assert!((volume(part) - 40.).abs() < 1e-7, "closed quarter slab: {}", volume(part));
    assert!(part.positions.chunks_exact(3).all(|p| p[0] <= 1e-8 && p[1] <= 1e-8));
    assert!(plan_section_export(source.as_bytes(), &planes, false).unwrap().replacements.is_empty());
    let inside = [SectionExportPlane { normal: [1.,0.,0.], offset: 10. }];
    assert!(plan_section_export(source.as_bytes(), &inside, true).unwrap().replacements.is_empty());
    let outside = [SectionExportPlane { normal: [1.,0.,0.], offset: -10. }];
    assert_eq!(plan_section_export(source.as_bytes(), &outside, true).unwrap().outside, [50]);
}

#[test]
fn issue_7711_restores_rtc_and_file_units_before_export() {
    for (unit, scale, shift) in [("$", 1.0, 5_000_000.), (".MILLI.", 0.001, 5_000_000_000.)] {
        let source = slab(unit, shift);
        let planes = [SectionExportPlane { normal: [1.,0.,0.], offset: shift * scale }];
        let plan = plan_section_export(source.as_bytes(), &planes, true).unwrap();
        let part = &plan.replacements[0].parts[0];
        assert!(part.positions.chunks_exact(3).all(|p| p[0] <= 1e-6 && p[0] >= -5.000001));
        assert!((volume(part) - 80.).abs() < 0.01);
    }
}

#[test]
fn issue_7711_rejects_invalid_planes_instead_of_exporting_uncut_geometry() {
    for normal in [[0.,0.,0.], [f64::NAN,0.,1.]] {
        assert!(plan_section_export(slab("$", 0.).as_bytes(), &[SectionExportPlane {normal, offset:0.}], true).is_err());
    }
}

#[test]
fn issue_7711_an_open_source_surface_is_clipped_without_inventing_a_solid() {
    let triangle = [[[-2.,-1.,0.],[2.,-1.,0.],[0.,2.,0.]]];
    let clipped = mesh::cut(&triangle, [1.,0.,0.], 0.).unwrap();
    assert!(!clipped.is_empty());
    assert!(!mesh::closed(&clipped));
    assert!(clipped.iter().flatten().all(|p| p[0] <= 1e-6));
    let area: f64 = clipped.iter().map(|t| v3::norm(v3::cross(v3::sub(t[1],t[0]),v3::sub(t[2],t[0]))) / 2.).sum();
    assert!((area - 3.).abs() < 1e-6);
}

#[test]
fn issue_7711_whole_mode_uses_the_combined_crop_not_independent_bounds() {
    let source = slab("$", 0.);
    let planes = [SectionExportPlane {normal:[1.,0.,0.],offset:-1.},
        SectionExportPlane {normal:[-1.,0.,0.],offset:-1.}];
    assert_eq!(plan_section_export(source.as_bytes(), &planes, false).unwrap().outside, [50]);
}

#[test]
fn issue_7711_oblique_section_has_a_closed_cut_face() {
    let source = slab("$", 0.);
    let plane = SectionExportPlane {normal:[1.,0.,1.],offset:1.};
    let plan = plan_section_export(source.as_bytes(), &[plane], true).unwrap();
    let part = &plan.replacements[0].parts[0];
    assert!(part.closed);
    assert!((volume(part)-80.).abs()<1e-6);
    assert!(part.positions.chunks_exact(3).all(|p| p[0]+p[2]<=1.+1e-7));
}

#[test]
fn issue_7711_preflight_never_leaks_unmeshed_spatial_bodies_or_rejects_opening_subtypes() {
    let planes = [SectionExportPlane {normal:[1.,0.,0.],offset:0.}];
    let spatial = slab("$", 0.).replace("IFCSLAB(", "IFCBUILDINGSTOREY(")
        .replace("#22,#45,$,.FLOOR.", "#22,#45,$,.ELEMENT.,0.");
    let clipped = plan_section_export(spatial.as_bytes(), &planes, true).unwrap();
    assert_eq!(clipped.replacements.len(), 1, "a meshable spatial body must be cropped too");
    let unmeshed = spatial.replace("#42=IFCEXTRUDEDAREASOLID(#41,#11,#43,2.);", "#42=IFCBOUNDINGBOX(#12,10.,8.,2.);")
        .replace("'Body','SweptSolid'", "'Box','BoundingBox'");
    let error = plan_section_export(unmeshed.as_bytes(), &planes, true).unwrap_err();
    assert!(error.contains("cannot safely crop unmeshed IFCBUILDINGSTOREY #50"), "{error}");
    let opening = slab("$", 0.).replace("IFCSLAB(", "IFCOPENINGSTANDARDCASE(")
        .replace(",.FLOOR.", ",.OPENING.");
    let plan = plan_section_export(opening.as_bytes(), &planes, true).unwrap();
    assert!(plan.replacements.is_empty() && plan.outside.is_empty(), "void cutters belong to their host");
    let annotation = slab("$", 0.).replace("IFCSLAB(", "IFCANNOTATION(").replace("#22,#45,$,.FLOOR.", "#22,#45");
    assert!(plan_section_export(annotation.as_bytes(), &planes, true).unwrap().replacements.is_empty());
}

#[test]
fn issue_7711_palette_fragments_share_one_closed_cut_topology() {
    // Exact cube from processing/tests/styling_indexed_colour.rs (#858).
    let source = include_str!("../tests/fixtures/section_palette.ifc");
    let original = process_geometry(source);
    let parts: Vec<_> = original.meshes.iter().filter(|part| part.express_id == 10).collect();
    assert_eq!(parts.len(), 2);
    assert!(parts.iter().all(|part| !mesh::closed(&mesh::triangles(part).unwrap())));
    let plan = plan_section_export(source.as_bytes(), &[SectionExportPlane {normal:[1.,0.,0.],offset:0.5}], true).unwrap();
    assert_eq!(plan.replacements[0].parts.len(), 1);
    let part = &plan.replacements[0].parts[0];
    assert!(part.closed, "palette splits must not turn a source solid into sheets");
    assert!((volume(part)-0.5).abs()<1e-7);
    assert_eq!(part.face_colors.len(), part.indices.len()/3);
    let mut cap_area = 0.;
    for (indices, color) in part.indices.chunks_exact(3).zip(&part.face_colors) {
        let tri = [indices[0],indices[1],indices[2]].map(|i| { let i=i as usize*3; [part.positions[i],part.positions[i+1],part.positions[i+2]] });
        if tri.iter().all(|p| (p[0]-0.5).abs()<1e-7) { cap_area += v3::norm(v3::cross(v3::sub(tri[1],tri[0]),v3::sub(tri[2],tri[0])))/2.; }
        if tri.iter().all(|p| p[0].abs()<1e-7) || tri.iter().all(|p| (p[1]-1.).abs()<1e-7) { assert!((color[1]-0.9).abs()<1e-6); }
        if tri.iter().all(|p| p[2].abs()<1e-7) || tri.iter().all(|p| (p[2]-1.).abs()<1e-7) || tri.iter().all(|p| p[1].abs()<1e-7) { assert!((color[0]-0.9).abs()<1e-6); }
    }
    assert!((cap_area-1.).abs()<1e-7, "one square metre closes the half-cube");
    assert!(part.face_colors.iter().any(|color| (color[0]-0.9).abs()<1e-6));
}

#[test]
fn issue_7711_material_layer_slices_are_occurrence_geometry() {
    // Three-layer source wall from the canonical #3199 provenance fixture.
    let source = include_str!("../tests/fixtures/section_layers.ifc");
    // Arm the same canonical producer as the WASM batch; the native worker
    // currently does not propagate its parent's MaterialLayerIndex.
    use ifc_lite_processing::element::{produce_element_meshes, ElementJobKind, ElementMeshJob, MeshProductionContext, MeshProductionOptions};
    let mut decoder = EntityDecoder::new(source);
    let mut router = GeometryRouter::with_units(source, &mut decoder);
    let index = ifc_lite_geometry::MaterialLayerIndex::from_content(source, &mut decoder);
    router.set_material_layer_index(std::sync::Arc::new(index));
    let wall = decoder.decode_by_id(100).unwrap();
    let ctx = MeshProductionContext {
        void_index: &Default::default(), geometry_style_index: &Default::default(),
        indexed_colour_full: &Default::default(), element_material_colors: &Default::default(),
        texture_index: &Default::default(), site_local_rotation: None,
    };
    let job = ElementMeshJob { id:100, ifc_type:IfcType::IfcWall, entity:&wall,
        kind:ElementJobKind::Product, element_color:None, metadata:None };
    let original = produce_element_meshes(&job, &ctx, &MeshProductionOptions::default(), &mut decoder, &router).meshes;
    assert_eq!(original.len(), 3);
    assert!(original.iter().all(|part| part.geometry_class == GEOM_CLASS_LAYER_SLICE && part.geometry_item_id.is_none() && part.material_id.is_some()));
    let refs: Vec<_> = original.iter().collect();
    let (cut, changed) = parts::cut_parts(&refs, MeshFrame::RawIfc, &[SectionExportPlane {normal:[1.,0.,0.],offset:0.}], true).unwrap();
    assert!(changed && cut.iter().all(|part| mesh::closed(&part.triangles)));
    let clipped_volume = cut.iter().flat_map(|part| &part.triangles).map(|t| v3::dot(t[0],v3::cross(t[1],t[2]))).sum::<f64>().abs()/6.;
    assert!((clipped_volume-1.8).abs()<1e-5, "collective material skins close the half-wall: {clipped_volume}");
    let plan = plan_section_export(source.as_bytes(), &[SectionExportPlane {normal:[1.,0.,0.],offset:0.}], true).unwrap();
    assert_eq!(plan.replacements[0].express_id, 100);
    assert!(plan.replacements[0].parts.iter().all(|part| part.closed));
    let total: f64 = plan.replacements[0].parts.iter().map(volume).sum();
    assert!((total-1.8).abs()<1e-5, "all material slices contribute to the half-wall: {total}");
}

#[path = "section_clip_safety_tests.rs"]
mod safety;
