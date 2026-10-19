// SPDX-License-Identifier: MPL-2.0
//! Actual inner TypeMap ownership, source-claim and snapshot boundaries.
use super::*;
use ifc_lite_core::AttributeValue;
use std::sync::Arc;

fn drive(mut control: TypeMapControl, router: &GeometryRouter,
    decoder: &mut EntityDecoder<'_>) -> Result<super::super::type_map::TypeParts> {
    while control.poll().unwrap().is_some() {
        let reply = if let Some(ready) = control.take_ready() {
            let predicted = ready.tag();
            let reply = ready.execute();
            assert_eq!(reply.tag(), predicted, "detached numerical recipe preserves its linear reply kind");
            reply
        } else { control.execute(router, decoder, None).unwrap() };
        control.accept(reply, router);
    }
    match control.take_output().unwrap()? {
        GeometryOutput::TypeParts(parts) => Ok(parts),
        _ => panic!("actual TypeMap output"),
    }
}

#[test]
fn unaccepted_whole_items_reply_does_not_claim_source_drop_counting() {
    let source = "#1=IFCREPRESENTATIONMAP($,#2);
#2=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#10));
#10=IFCGEOMETRICCURVESET(());";
    let mut decoder = EntityDecoder::new(source);
    let map = decoder.decode_by_id(1).unwrap();
    let router = GeometryRouter::new();
    let mut unaccepted = TypeMapControl::from_entity(map.clone());
    unaccepted.poll().unwrap();
    let representation = unaccepted.execute(&router, &mut decoder, None).unwrap();
    unaccepted.accept(representation, &router);
    unaccepted.poll().unwrap();
    let items_reply = unaccepted.execute(&router, &mut decoder, None).unwrap();
    drop(items_reply);
    drop(unaccepted);
    // RepresentationType, not the unsupported child type, determines Body loss.
    let parts = drive(TypeMapControl::from_entity(map.clone()), &router, &mut decoder).unwrap();
    assert!(parts.is_empty());
    let dropped = router.take_unsupported_items();
    assert_eq!(dropped.get("IfcGeometricCurveSet"), Some(&1),
        "the first accepted source walk still owns its real unsupported item");
    assert_eq!(dropped.len(), 1);
    assert!(drive(TypeMapControl::from_entity(map), &router, &mut decoder).unwrap().is_empty());
    assert!(router.take_unsupported_items().is_empty(), "a reached retry cannot count the same source twice");
}

#[test]
fn entity_entry_preserves_supplied_snapshot_while_id_entry_decodes_actual_map() {
    let source = "#1=IFCREPRESENTATIONMAP($,#2);
#2=IFCSHAPEREPRESENTATION($,'Body','CSG',(#10));
#3=IFCSHAPEREPRESENTATION($,'Axis','CSG',(#11,#11));
#10=IFCBLOCK($,2.,3.,4.);
#11=IFCBLOCK($,5.,6.,7.);";
    let mut decoder = EntityDecoder::new(source);
    let mut map = decoder.decode_by_id(1).unwrap();
    Arc::make_mut(&mut map.attributes)[1] = AttributeValue::EntityRef(3);
    let router = GeometryRouter::new();
    let snapshot = drive(TypeMapControl::from_entity(map), &router, &mut decoder).unwrap();
    let actual = drive(TypeMapControl::from_id(1), &router, &mut decoder).unwrap();
    assert_eq!(snapshot[0].0.indices.len(), 72, "both non-Body repeated occurrences survive");
    assert_eq!(actual[0].0.indices.len(), 36);
    let max_x = |mesh: &Mesh| mesh.positions.chunks_exact(3).map(|p| p[0]).fold(f32::NEG_INFINITY, f32::max);
    assert_eq!(max_x(&snapshot[0].0), 5.);
    assert_eq!(max_x(&actual[0].0), 2.);
}

#[test]
fn common_type_map_control_and_linear_reply_remain_send() {
    fn send<T: Send>() {}
    send::<TypeMapControl>();
    send::<TypeMapReply>();
    send::<TypeMapReadyWork>();
}
