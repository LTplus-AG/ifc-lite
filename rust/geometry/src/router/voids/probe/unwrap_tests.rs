// SPDX-License-Identifier: MPL-2.0
//! #7781: real STEP wrapper chains retain each probe's admission policy.
use super::*;
use crate::profile_walk_model as model;

fn unwrap(content: &str, id: u32, policy: UnwrapPolicy) -> Option<(u32, Option<Matrix4<f64>>)> {
    let router = GeometryRouter::new();
    let mut decoder = EntityDecoder::new(content);
    let item = decoder.decode_by_id(id).unwrap();
    router.unwrap_probe_solid(item, None, policy, &mut decoder).unwrap()
        .map(|(solid, chain)| (solid.id, chain))
}

#[test]
fn issue_7781_first_item_and_single_unclipped_probe_policies_remain_distinct() {
    let content = model::wall("#160", &format!(
        "{}\n{}\n#160=IFCSHAPEREPRESENTATION(#13,'Body','MappedRepresentation',(#1000));\n\
         #3000=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#1000,#240);",
        model::TARGET, model::mapped(1000, "#140,#240")));
    assert_eq!(unwrap(&content, 1000, UnwrapPolicy::FIRST).unwrap().0, 140);
    assert!(unwrap(&content, 1000, UnwrapPolicy::SINGLE_UNCLIPPED).is_none());
    assert_eq!(unwrap(&content, 3000, UnwrapPolicy::FIRST).unwrap().0, 140);
    assert!(unwrap(&content, 3000, UnwrapPolicy::SINGLE_UNCLIPPED).is_none());
    let single = content.replace("(#140,#240)", "(#140)");
    assert_eq!(unwrap(&single, 1000, UnwrapPolicy::SINGLE_UNCLIPPED).unwrap().0, 140);
    assert!(unwrap(&single, 3000, UnwrapPolicy::SINGLE_UNCLIPPED).is_none());
}

#[test]
fn issue_7781_probe_depth_counts_wrappers_and_leaf_and_cycles_decline() {
    for policy in [UnwrapPolicy::FIRST, UnwrapPolicy::SINGLE_UNCLIPPED] {
        assert_eq!(unwrap(&model::chain(31), 1000, policy).unwrap().0, 240);
        assert!(unwrap(&model::chain(32), 1000, policy).is_none());
        let cyclic = model::chain(1).replace("(#240)", "(#1000)");
        assert!(unwrap(&cyclic, 1000, policy).is_none());
    }
}

#[test]
fn issue_7781_probe_mapping_composes_both_levels_and_preserves_absence() {
    let content = model::chain(2).replace(model::TARGET,
        "#98=IFCCARTESIANPOINT((3.,4.,5.));\n#99=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#98,1.,$);");
    for policy in [UnwrapPolicy::FIRST, UnwrapPolicy::SINGLE_UNCLIPPED] {
        let (solid, chain) = unwrap(&content, 1000, policy).unwrap();
        assert_eq!(solid, 240);
        let matrix = chain.unwrap();
        assert_eq!([matrix[(0, 3)], matrix[(1, 3)], matrix[(2, 3)]], [6., 8., 10.]);
        assert!(unwrap(&content, 240, policy).unwrap().1.is_none());
        let mut decoder = EntityDecoder::new(&content);
        let leaf = decoder.decode_by_id(240).unwrap();
        let (_, identity) = GeometryRouter::new().unwrap_probe_solid(
            leaf, Some(Matrix4::identity()), policy, &mut decoder,
        ).unwrap().unwrap();
        assert_eq!(identity.unwrap(), Matrix4::identity());
    }
}

#[test]
fn issue_7781_probe_rejects_an_unreadable_mapping_transform() {
    let content = model::chain(1).replace(model::TARGET,
        "#99=IFCCARTESIANPOINT((3.,4.,5.));");
    for policy in [UnwrapPolicy::FIRST, UnwrapPolicy::SINGLE_UNCLIPPED] {
        assert!(unwrap(&content, 1000, policy).is_none());
    }
}

#[test]
fn issue_7781_boolean_leaf_policy_retains_long_chains_beyond_probe_limit() {
    let mut entities = String::new();
    for id in 1000..1040 {
        let next = if id == 1039 { 240 } else { id + 1 };
        entities.push_str(&format!("#{id}=IFCBOOLEANRESULT(.DIFFERENCE.,#{next},#140);\n"));
    }
    let content = model::wall("", &entities);
    assert!(unwrap(&content, 1000, UnwrapPolicy::FIRST).is_none());
    let mut decoder = EntityDecoder::new(&content);
    let root = decoder.decode_by_id(1000).unwrap();
    let leaf = unwrap_item(root, &mut decoder, WrapperPolicy::BooleanLeaf, |item, decoder| {
        Ok(decoder.resolve_ref(item.get(1).unwrap())?)
    }).unwrap().unwrap();
    assert_eq!(leaf.id, 240);
}
