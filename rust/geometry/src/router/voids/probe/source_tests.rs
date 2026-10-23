// SPDX-License-Identifier: MPL-2.0
//! #7781: opening probes share mesh shape admission and retain item fallback.
use super::*;
use crate::profile_walk_model as model;

#[test]
fn issue_7781_opening_probe_rejects_wrong_shape_type_before_meshing() {
    let valid = model::wall("#160", "#160=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#140));");
    let wrong = valid.replace("#151=IFCPRODUCTDEFINITIONSHAPE($,$,(#160));", "#151=IFCBLOCK($,$,(#160));");
    for content in [&valid, &wrong] {
        let mut decoder = EntityDecoder::new(content);
        let wall = decoder.decode_by_id(100).unwrap();
        let router = GeometryRouter::new();
        let source = router.opening_probe_source(&wall, &mut decoder);
        if content == &valid {
            assert_eq!(source.unwrap().0.iter().map(|item| item.id).collect::<Vec<_>>(), [140]);
        } else {
            assert!(matches!(source, Err(Error::GeometryError(ref message))
                if message.contains("Expected IfcProductDefinitionShape")));
            assert!(router.get_opening_item_meshes_world(&wall, &mut decoder).is_err());
            assert!(router.get_opening_item_bounds_with_direction(&wall, &mut decoder).is_err());
        }
    }
}

#[test]
fn issue_7781_opening_probe_skips_missing_items_but_keeps_later_selected_roots() {
    let content = model::wall("#160,#161,#162", "\
#160=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid');
#161=IFCSHAPEREPRESENTATION(#13,'Axis','Curve2D',(#240));
#162=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#140));");
    let mut decoder = EntityDecoder::new(&content);
    let wall = decoder.decode_by_id(100).unwrap();
    let (items, _) = GeometryRouter::new().opening_probe_source(&wall, &mut decoder).unwrap();
    assert_eq!(items.iter().map(|item| item.id).collect::<Vec<_>>(), [140]);
}

#[test]
fn issue_7781_null_opening_shape_abstains_before_placement_read() {
    let content = "#100=IFCWALL('empty',$,$,$,$,#999,$,$);";
    let mut decoder = EntityDecoder::new(content);
    let wall = decoder.decode_by_id(100).unwrap();
    let (items, placement) = GeometryRouter::new().opening_probe_source(&wall, &mut decoder).unwrap();
    assert!(items.is_empty());
    assert_eq!(placement, Matrix4::identity());
}
