// SPDX-License-Identifier: MPL-2.0
use super::*;
use crate::processors::{FaceBasedSurfaceModelProcessor, ShellBasedSurfaceModelProcessor};

fn source(kind: &str, collection_suffix: &str) -> String {
    format!("#1=IFCCARTESIANPOINT((4999999.98,-0.02,0.));\n\
        #2=IFCCARTESIANPOINT((5000000.02,-0.02,0.));\n\
        #3=IFCCARTESIANPOINT((5000000.02,0.02,0.));\n\
        #4=IFCCARTESIANPOINT((4999999.98,0.02,0.));\n\
        #5=IFCPOLYLOOP((#1,#2,#3,#4));#6=IFCFACEOUTERBOUND(#5,.T.);\n\
        #7=IFCCARTESIANPOINT((4999999.99,-0.01,0.));\n\
        #8=IFCCARTESIANPOINT((4999999.99,0.01,0.));\n\
        #9=IFCCARTESIANPOINT((5000000.01,0.01,0.));\n\
        #10=IFCCARTESIANPOINT((5000000.01,-0.01,0.));\n\
        #11=IFCPOLYLOOP((#7,#8,#9,#10));#12=IFCFACEBOUND(#11,.T.);\n\
        #13=IFCFACE((#6,#12));#20=IFCCLOSEDSHELL((#13));\n\
        #30={kind}((#20{collection_suffix}));")
}

fn lower_owned(kind: &str, suffix: &str) -> SurfaceModelPlan {
    let source = source(kind, suffix);
    let mut decoder = EntityDecoder::new(&source);
    let entity = decoder.decode_by_id(30).unwrap();
    let rtc = Some((5_000_000.0, 0.0, 0.0));
    if kind == "IFCFACEBASEDSURFACEMODEL" {
        FaceBasedSurfaceModelProcessor::new().lower(&entity, &mut decoder, TessellationQuality::Medium, rtc)
    } else {
        ShellBasedSurfaceModelProcessor::new().lower(&entity, &mut decoder, TessellationQuality::Medium, rtc)
    }.unwrap()
}

#[test]
fn owned_surface_models_preserve_sub_ulp_hole_area_after_source_disposal() {
    for kind in ["IFCFACEBASEDSURFACEMODEL", "IFCSHELLBASEDSURFACEMODEL"] {
        let mesh = lower_owned(kind, "").evaluate().unwrap();
        assert!(mesh.rtc_applied);
        assert!(!mesh.is_empty());
        assert!(mesh.positions.iter().all(|value| value.is_finite() && value.abs() < 0.021));
        let area: f64 = mesh.indices.chunks_exact(3).map(|triangle| {
            let p = |id: u32| nalgebra::Vector3::new(mesh.positions[id as usize * 3] as f64,
                mesh.positions[id as usize * 3 + 1] as f64, mesh.positions[id as usize * 3 + 2] as f64);
            (p(triangle[1]) - p(triangle[0])).cross(&(p(triangle[2]) - p(triangle[0]))).norm() * 0.5
        }).sum();
        assert!((area - (0.04 * 0.04 - 0.02 * 0.02)).abs() < 1e-8,
            "{kind} must retain its inner hole before f32 narrowing: {area}");
    }
}

#[test]
fn owned_surface_model_preserves_late_collection_error_and_missing_collection_skip() {
    let error = lower_owned("IFCFACEBASEDSURFACEMODEL", ",$").evaluate().unwrap_err();
    assert_eq!(error.to_string(), "Geometry processing error: Expected entity reference for face set");
    let mesh = lower_owned("IFCSHELLBASEDSURFACEMODEL", ",#99").evaluate().unwrap();
    assert!(!mesh.is_empty(), "unreadable collection remains a skip, not a whole-model refusal");
}

// A finite simple face with nested holes fails only during triangulation;
// the following spline face fails its source degree bound before point reads.
// Their refusal ordering must remain the authored face order across phases.
fn mixed_refusals(kind: &str, suffix: &str) -> String {
    format!("#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCCARTESIANPOINT((10.,0.,0.));\n\
        #3=IFCCARTESIANPOINT((10.,10.,0.));#4=IFCCARTESIANPOINT((0.,10.,0.));\n\
        #5=IFCPOLYLOOP((#1,#2,#3,#4));#6=IFCFACEOUTERBOUND(#5,.T.);\n\
        #7=IFCCARTESIANPOINT((1.,1.,0.));#8=IFCCARTESIANPOINT((1.,4.,0.));\n\
        #9=IFCCARTESIANPOINT((4.,4.,0.));#10=IFCCARTESIANPOINT((4.,1.,0.));\n\
        #11=IFCPOLYLOOP((#7,#8,#9,#10));#12=IFCFACEBOUND(#11,.T.);\n\
        #13=IFCCARTESIANPOINT((2.,2.,0.));#14=IFCCARTESIANPOINT((2.,3.,0.));\n\
        #15=IFCCARTESIANPOINT((3.,3.,0.));#16=IFCCARTESIANPOINT((3.,2.,0.));\n\
        #17=IFCPOLYLOOP((#13,#14,#15,#16));#18=IFCFACEBOUND(#17,.T.);\n\
        #19=IFCFACE((#6,#12,#18));\n\
        #20=IFCBSPLINESURFACEWITHKNOTS(1000000,1,((#999,#999),(#999,#999)),\
        .UNSPECIFIED.,.F.,.F.,.F.,(2,2),(2,2),(0.,1.),(0.,1.),.UNSPECIFIED.);\n\
        #21=IFCADVANCEDFACE((),#20,.T.);#22=IFCCLOSEDSHELL((#19,#21));\n\
        #23={kind}((#22{suffix}));")
}

#[test]
fn production_surface_models_keep_mixed_refusal_order_and_pending_caller_reports() {
    use crate::GeometryProcessor;
    use ifc_lite_core::IfcSchema;
    use crate::processors::take_face_refused;
    for kind in ["IFCFACEBASEDSURFACEMODEL", "IFCSHELLBASEDSURFACEMODEL"] {
        for suffix in ["", ",$"] {
            let _ = take_face_refused();
            note_face_refused(&IfcType::IfcFaceSurface);
            let bytes = mixed_refusals(kind, suffix);
            let mut decoder = EntityDecoder::new(&bytes);
            let entity = decoder.decode_by_id(23).unwrap();
            let result = if kind == "IFCFACEBASEDSURFACEMODEL" {
                FaceBasedSurfaceModelProcessor::new().process(&entity, &mut decoder,
                    &IfcSchema::new(), TessellationQuality::Medium)
            } else {
                ShellBasedSurfaceModelProcessor::new().process(&entity, &mut decoder,
                    &IfcSchema::new(), TessellationQuality::Medium)
            };
            if suffix.is_empty() { assert!(result.unwrap().is_empty()); }
            else { assert!(result.is_err(), "late invalid collection remains a terminal error"); }
            assert_eq!(take_face_refused(), [IfcType::IfcFaceSurface, IfcType::IfcFace, IfcType::IfcAdvancedFace]);
        }
    }
}

#[test]
fn owned_surface_plan_keeps_source_reports_durable_without_early_production_emission() {
    use crate::processors::take_face_refused;
    let _ = take_face_refused();
    let plan = {
        let bytes = mixed_refusals("IFCFACEBASEDSURFACEMODEL", "");
        let mut decoder = EntityDecoder::new(&bytes);
        let entity = decoder.decode_by_id(23).unwrap();
        FaceBasedSurfaceModelProcessor::new().lower(&entity, &mut decoder,
            TessellationQuality::Medium, None).unwrap()
    };
    assert!(take_face_refused().is_empty(), "lowering cannot reorder later source refusals ahead of earlier numerical work");
    assert_eq!(plan.source_reports().face_refused, [IfcType::IfcAdvancedFace]);
    assert!(plan.evaluate().unwrap().is_empty());
    assert_eq!(take_face_refused(), [IfcType::IfcFace, IfcType::IfcAdvancedFace]);
}
