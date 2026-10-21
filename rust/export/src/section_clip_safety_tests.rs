// SPDX-License-Identifier: MPL-2.0
use super::*;

struct AuditSink(ifc_lite_processing::ProductGeometryAudit);
impl ifc_lite_processing::ProcessingSink for AuditSink {
    fn product_geometry_audit(&self) -> Option<ifc_lite_processing::ProductGeometryAudit> { Some(self.0.clone()) }
}

#[test]
fn issue_7711_partial_product_is_refused_inside_and_crossing() {
    // Ordinary unsupported items enter the router's Err/drop-and-continue arm.
    // Unlike a top-level broken mapped item, this does not abort the entire body.
    // Every child reference is readable, so source integrity cannot explain refusal.
    let source = slab("$", 0.).replace(
        "#44=IFCSHAPEREPRESENTATION", "#60=IFCGEOMETRICSET((#12));\n#44=IFCSHAPEREPRESENTATION",
    ).replace("'SweptSolid',(#42)", "'SweptSolid',(#42,#60)");
    let mut decoder = EntityDecoder::new(&source);
    let unsupported = decoder.decode_by_id(60).unwrap();
    assert_eq!(decoder.resolve_ref_list(unsupported.get(0).unwrap()).unwrap()[0].id, 12);
    let mut sink = AuditSink(Default::default());
    let partial = process(source.as_bytes(), &ProcessingRequest::full_pass(), &mut sink);
    let surviving: Vec<_> = partial.meshes.iter().filter(|p| p.express_id == 50).collect();
    assert!(!surviving.is_empty() && surviving.iter().all(|p| !p.indices.is_empty()), "the supported slab must survive the ordinary item drop");
    // This assertion runs BEFORE the section planner/source-integrity gate.
    let receipt = sink.0.require_complete(50).unwrap_err();
    assert!(receipt.contains("dropped representation items") && receipt.contains("IfcGeometricSet"), "{receipt}");
    let mut clean_sink = AuditSink(Default::default());
    process(slab("$", 0.).as_bytes(), &ProcessingRequest::full_pass(), &mut clean_sink);
    clean_sink.0.require_complete(50).unwrap();
    assert!(clean_sink.0.require_complete(999).is_err(), "an unprocessed id cannot be certified by omission");
    for offset in [10., 0.] {
        for trim in [true, false] {
            let error = plan_section_export(source.as_bytes(), &[SectionExportPlane { normal: [1.,0.,0.], offset }], trim).unwrap_err();
            assert!(error.contains("incomplete product #50"), "{error}");
        }
    }
}

#[test]
fn issue_7711_dangling_mapped_source_is_refused_without_claiming_a_partial_mesh() {
    let source = slab("$", 0.).replace(
        "#44=IFCSHAPEREPRESENTATION", "#60=IFCMAPPEDITEM(#999,#61);\n#61=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#12,1.,$);\n#44=IFCSHAPEREPRESENTATION",
    ).replace("'SweptSolid',(#42)", "'SweptSolid',(#42,#60)");
    // This malformed source can abort meshing the body altogether; it is NOT
    // the witness for admitting a partially meshed product with readable refs.
    for offset in [10., 0.] {
        let error = plan_section_export(source.as_bytes(), &[SectionExportPlane {normal:[1.,0.,0.],offset}], true).unwrap_err();
        assert!(error.contains("unmeshed") || error.contains("incomplete product #50"), "{error}");
    }
}

#[test]
fn issue_7711_csg_fallback_is_not_a_complete_product_receipt() {
    let source = slab("$", 0.).replace("#44=IFCSHAPEREPRESENTATION", "#60=IFCBOOLEANRESULT(.UNKNOWN.,#42,#42);\n#44=IFCSHAPEREPRESENTATION")
        .replace("'SweptSolid',(#42)", "'CSG',(#42,#60)");
    let mut sink = AuditSink(Default::default());
    let processed = process(source.as_bytes(), &ProcessingRequest::full_pass(), &mut sink);
    assert!(processed.meshes.iter().any(|p| p.express_id == 50));
    assert!(sink.0.require_complete(50).unwrap_err().contains("CSG diagnostic/fallback"));
    assert!(processed.stats.total_csg_failures > 0, "the malformed operation must exercise an actual CSG diagnostic");
    for offset in [10., 0.] {
        let error = plan_section_export(source.as_bytes(), &[SectionExportPlane {normal:[1.,0.,0.],offset}], true).unwrap_err();
        assert!(error.contains("CSG diagnostic/fallback") || error.contains("model processing diagnostics"), "{error}");
    }
}

#[test]
fn issue_7711_repeated_open_leaf_keeps_submetre_detail_at_distant_origins() {
    let source = slab("$", 0.).replace("#42=IFCEXTRUDEDAREASOLID(#41,#11,#43,2.);", r"
#100=IFCCARTESIANPOINTLIST3D(((0.,-1.,0.),(0.125,-1.,0.),(0.125,1.,0.),(0.,1.,0.)));
#101=IFCTRIANGULATEDFACESET(#100,$,.F.,((1,2,3),(1,3,4)),$);
#102=IFCSHAPEREPRESENTATION(#10,'Body','Tessellation',(#101));
#103=IFCREPRESENTATIONMAP(#11,#102);
#104=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#12,1.,$);
#105=IFCCARTESIANPOINT((5000000.,0.,0.));
#106=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#105,1.,$);
#42=IFCMAPPEDITEM(#103,#104);
#60=IFCMAPPEDITEM(#103,#106);")
        .replace("'SweptSolid',(#42)", "'MappedRepresentation',(#42,#60)");
    let processed = process_geometry(&source);
    let original: Vec<_> = processed.meshes.iter().filter(|p| p.express_id == 50).collect();
    assert_eq!(original.len(), 2, "two parsed occurrences of the same open leaf");
    assert_eq!(original[0].geometry_item_id, original[1].geometry_item_id);
    assert_ne!(original[0].origin, original[1].origin);
    let plan = plan_section_export(source.as_bytes(), &[SectionExportPlane {normal:[0.,1.,0.],offset:0.}], true).unwrap();
    let parts = &plan.replacements[0].parts;
    assert_eq!(parts.len(), 2);
    let mut minima = Vec::new();
    for part in parts {
        assert!(!part.closed);
        let lo = part.positions.chunks_exact(3).map(|p| p[0]).fold(f64::INFINITY, f64::min);
        let hi = part.positions.chunks_exact(3).map(|p| p[0]).fold(f64::NEG_INFINITY, f64::max);
        assert!((hi-lo-0.125).abs()<1e-8, "width at {lo}: {}", hi-lo);
        let vertex = |i: u32| { let i=i as usize*3; [part.positions[i],part.positions[i+1],part.positions[i+2]] };
        let area: f64 = part.indices.chunks_exact(3).map(|t| v3::norm(v3::cross(v3::sub(vertex(t[1]),vertex(t[0])),v3::sub(vertex(t[2]),vertex(t[0]))))/2.).sum();
        assert!((area-0.125).abs()<1e-8, "area at {lo}: {area}");
        assert!(part.positions.chunks_exact(3).all(|p| p[1]>=-1.-1e-8 && p[1]<=1e-8));
        minima.push(lo);
    }
    minima.sort_by(|a,b| ifc_lite_geometry::cmp_f64_nan_last(*a,*b));
    assert!((minima[0]).abs()<1e-8 && (minima[1]-5_000_000.).abs()<1e-8);
}

#[test]
fn issue_7711_textured_crossing_refuses_but_inside_keeps_the_authored_mapping() {
    let source = include_str!("../tests/fixtures/section_textured.ifc");
    let processed = process_geometry(&source);
    let original = processed.meshes.iter().find(|p| p.express_id == 50).unwrap();
    assert_eq!(original.texture.as_ref().unwrap().url.as_deref(), Some("textures/wood.jpg"));
    assert!(original.uvs.is_some());
    let inside = plan_section_export(source.as_bytes(), &[SectionExportPlane {normal:[1.,0.,0.],offset:2.}], true).unwrap();
    assert!(inside.replacements.is_empty() && inside.outside.is_empty());
    let error = plan_section_export(source.as_bytes(), &[SectionExportPlane {normal:[1.,0.,0.],offset:0.5}], true).unwrap_err();
    assert!(error.contains("cannot trim textured product #50"), "{error}");
    let whole = plan_section_export(source.as_bytes(), &[SectionExportPlane {normal:[1.,0.,0.],offset:0.5}], false).unwrap();
    assert!(whole.replacements.is_empty() && whole.outside.is_empty());
}

#[test]
fn issue_7711_source_texture_discovery_is_independent_of_mesh_uvs_and_other_attachments() {
    let inverse = include_str!("../tests/fixtures/section_inverse_texture.ifc");
    let plain = inverse.replace("#82=IFCTEXTUREMAP((#80),(#81,#86,#87,#88),#42);", "");
    let styled = plain.replace("#80=IFCIMAGETEXTURE", "#83=IFCSTYLEDITEM(#42,(#84),$);\n#84=IFCSURFACESTYLE('Texture',.BOTH.,(#85));\n#85=IFCSURFACESTYLEWITHTEXTURES((#80));\n#80=IFCIMAGETEXTURE");
    let mapped = inverse.replace("#44=IFCSHAPEREPRESENTATION(#10,'Body','SurfaceModel',(#46));", r"
#104=IFCSHAPEREPRESENTATION(#10,'Body','SurfaceModel',(#46));
#105=IFCREPRESENTATIONMAP(#11,#104);
#106=IFCCARTESIANPOINT((0.25,0.,0.));
#107=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#106,1.,$);
#108=IFCMAPPEDITEM(#105,#107);
#44=IFCSHAPEREPRESENTATION(#10,'Body','MappedRepresentation',(#108));");
    // No inverse map/StyledItem in this positive control; the same open face
    // can be cropped, so an unrelated mesher refusal cannot satisfy this test.
    let plane = [SectionExportPlane {normal:[1.,0.,0.],offset:0.5}];
    assert_eq!(plan_section_export(plain.as_bytes(), &plane, true).unwrap().replacements.len(), 1);
    for (label, source) in [("inverse-only", inverse), ("styled-only", styled.as_str()), ("mapped inverse-only", mapped.as_str())] {
        let processed = process_geometry(&source);
        let parts: Vec<_> = processed.meshes.iter().filter(|p| p.express_id == 50).collect();
        assert!(!parts.is_empty(), "{label}: the face must genuinely mesh");
        assert!(parts.iter().all(|p| p.texture.is_none() && p.uvs.is_none()), "{label}: this witness must depend on source attachments, not decoded mesh texture/UV guards");
        let inside = plan_section_export(source.as_bytes(), &[SectionExportPlane {normal:[1.,0.,0.],offset:2.}], true).unwrap();
        assert!(inside.replacements.is_empty() && inside.outside.is_empty(), "{label}");
        let error = plan_section_export(source.as_bytes(), &plane, true).unwrap_err();
        assert!(error.contains("cannot trim textured product #50"), "{label}: {error}");
    }
}
