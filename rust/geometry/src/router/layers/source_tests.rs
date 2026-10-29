// SPDX-License-Identifier: MPL-2.0
//! #7781: layer admission keeps its leaf types and uncapped boolean policy.
use super::*;

#[test]
fn issue_7781_layer_boolean_walk_preserves_long_chains_cycles_and_leaf_admission() {
    for (leaf, expected) in [
        ("IFCEXTRUDEDAREASOLID($,$,$,1.)", true),
        ("IFCREVOLVEDAREASOLID($,$,$,1.)", true),
        ("IFCFACETEDBREP($)", true),
        ("IFCTRIANGULATEDFACESET($,$,$,$,$)", true),
        ("IFCMAPPEDITEM($,$)", false),
        ("IFCCARTESIANPOINT((0.,0.,0.))", false),
    ] {
        for depth in [0, 31, 32, 42, 100] {
            let mut source = format!("#1000={leaf};");
            for id in 1..=depth {
                let next = if id == depth { 1000 } else { id + 1 };
                source.push_str(&format!("#{id}=IFCBOOLEANRESULT(.DIFFERENCE.,#{next},$);"));
            }
            let mut decoder = EntityDecoder::new(&source);
            let root = decoder.decode_by_id(if depth == 0 { 1000 } else { 1 }).unwrap();
            assert_eq!(
                item_has_identity_position(root, &mut decoder),
                expected,
                "{leaf}, depth {depth}"
            );
        }
    }
    for source in [
        "#1=IFCBOOLEANRESULT(.DIFFERENCE.,#1,$);",
        "#1=IFCBOOLEANRESULT(.DIFFERENCE.,#2,$);#2=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#1,$);",
        "#1=IFCBOOLEANRESULT(.DIFFERENCE.,#999,$);",
    ] {
        let mut decoder = EntityDecoder::new(source);
        let root = decoder.decode_by_id(1).unwrap();
        assert!(!item_has_identity_position(root, &mut decoder));
    }
}
