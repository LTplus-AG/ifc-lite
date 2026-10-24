// SPDX-License-Identifier: MPL-2.0
//! #7955: source semantics only. None of these assertions qualifies an SDK cut.
use super::*;
use ifc_lite_core::SourceBundle;
const SOURCE: &str = include_str!("../../../../../../tests/evidence/retained-layers-j3/circular-slab.ifc");
fn captured(text: &str) -> Result<Arc<RetainedLayerSource>, RetainedExecutionError> {
    let source = SourceBundle::new(text.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(text, &mut decoder);
    let context = ProductionModel::from_source(source.clone()).snapshot(Default::default());
    let product = decoder.decode_by_id(10).unwrap();
    capture(&context, &product, &mut decoder, &router)?.ok_or_else(invalid)
}
#[test]
fn j3_source_authored_order_and_units_are_not_visual_merge() {
    let layer = captured(SOURCE).unwrap();
    assert_eq!(layer.reference(), &RetainedLayerReference::ProductAxis(LayerAxis::Axis3));
    assert_eq!(layer.bands().iter().map(|b| (b.layer_id,b.material_id,b.ordinal,b.start_metres,b.end_metres))
        .collect::<Vec<_>>(), [(30,Some(20),0,0.,0.5),(31,Some(21),1,0.5,1.5),(32,Some(22),2,1.5,3.)], "J3_SOURCE_BANDS");
    assert_eq!(layer.interfaces(), [RetainedLayerInterface { usage_id:41,before_band:0,after_band:1 },
        RetainedLayerInterface { usage_id:41,before_band:1,after_band:2 }]);
    let mm = SOURCE.replace("$,.METRE.",".MILLI.,.METRE.")
        .replace(".POSITIVE.,0.,$", ".NEGATIVE.,3000.,$")
        .replace("#20,0.5,", "#20,500.,").replace("#21,1.,", "#21,1000.,")
        .replace("#22,1.5,", "#22,1500.,");
    let layer = captured(&mm).unwrap();
    assert_eq!(layer.bands().iter().map(|b|(b.start_metres,b.end_metres)).collect::<Vec<_>>(),
        [(3.,2.5),(2.5,1.5),(1.5,0.)], "J3_DIRECTION_UNITS");
    // An authored sub-mm band must not disappear into a visually dominant neighbor.
    let thin = captured(&SOURCE.replace("#20,0.5,", "#20,0.0001,")).unwrap();
    assert_eq!(thin.bands().len(),3);
    assert_eq!(thin.bands()[0].material_id,Some(20));
    let air = captured(&SOURCE.replace("#20,0.5,", "$,0.5,")).unwrap();
    assert_eq!(air.bands()[0].material_id,None);
}
#[test]
fn j3_source_rejects_malformed_whole_stack_without_skipping_a_band() {
    for value in ["0.","-1.","1.E309","$","1.E-323"] {
        let text = SOURCE.replace("#21,1.,", &format!("#21,{value},"));
        assert!(captured(&text).is_err(), "J3_INVALID_THICKNESS {value}");
    }
    for text in [SOURCE.replace(".POSITIVE.,0.,$", ".POSITIVE.,$,$"),
        SOURCE.replace("#21,1.,", "#999,1.,"),
        SOURCE.replace("#21,1.,", "#13,1.,"),
        SOURCE.replace("(#30,#31,#32)","(#30,$,#32)"),
        SOURCE.replace(".AXIS3.",".UNKNOWN."),
        SOURCE.replace("#20,0.5,", "#20,1.E308,").replace("#21,1.,", "#21,1.E308,")] {
        assert!(captured(&text).is_err(),"J3_ATOMIC_SOURCE_REFUSAL");
    }
}
#[test]
fn j3_source_curve_reference_is_not_a_planar_y_interface() {
    for text in [include_str!("../../../../../../tests/evidence/retained-layers-j3/circular-wall-2.ifc"),
        include_str!("../../../../../../tests/evidence/retained-layers-j3/circular-wall-3.ifc")] {
        let layer = captured(text).unwrap();
        assert_eq!(layer.reference(), &RetainedLayerReference::WallAxis {
            representation_id:54,curve_id:53 }, "J3_CURVED_REFERENCE");
        assert!(captured(&text.replace("'Axis'","'FootPrint'")).is_err());
        // Body is an analytic annular sector with an opening across all bands.
        // Source admission alone does not certify its numerical partition.
    }
}

#[test]
fn j3_source_context_and_budget_are_authority_not_matching_ids() {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(SOURCE, &mut decoder);
    let model = ProductionModel::from_source(source.clone());
    let context = model.snapshot(Default::default());
    let product = decoder.decode_by_id(10).unwrap();
    let value = capture(&context,&product,&mut decoder,&router).unwrap().unwrap();
    let other = model.snapshot(Default::default());
    assert!(value.validate(&other,10).is_err(),"J3_SOURCE_REVISION");
    assert!(value.validate(&context,11).is_err());
    let foreign = SourceBundle::new(SOURCE.as_bytes().to_vec());
    assert!(capture(&context,&product,&mut foreign.decoder(),&router).is_err());
    let account = resource::ExecutionAccount::new(resource::ExecutionPolicy::Bounded(
        resource::ResourceLimits { work:Some(0), ..Default::default() }));
    assert!(matches!(account.scope(||capture(&context,&product,&mut decoder,&router)),
        Err(RetainedExecutionError::Stopped(_))));
    model.invalidate_source();
    assert!(value.validate(&context,10).is_err());
}
