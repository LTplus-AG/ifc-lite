// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The `IfcLocalPlacement.PlacementRelTo` walk has no depth cap (D27): it is a
//! loop with a visited set, so a chain of any length resolves in full, a cycle
//! is refused and counted, and a memoised answer is the same whichever product
//! warmed it first. The old recursion stopped at `MAX_PLACEMENT_DEPTH` and
//! returned the identity there, which made a deep chain's answer depend on
//! memo order (#3012), and was implemented twice, so the mesh path and the 2D
//! drawing path drew a deep chain in two places (#2873). The profile extractor
//! now calls the same walk (PROC-2, #7690).

use super::*;
use crate::GeometryRouter;
use ifc_lite_core::limits::MAX_PLACEMENT_DEPTH;
use ifc_lite_core::EntityDecoder;

/// `links` chained `IfcLocalPlacement`s, each translating +1.0 in X, so the
/// composed world X of the deepest one equals the number of placements the walk
/// actually composed. That makes the truncation directly readable off the
/// result instead of inferred.
///
/// Ids: `#1` axis placement, `#2` its origin, `#10..=#(10 + links)` the chain
/// (`#10` is the root, `#(10 + links)` the leaf).
fn deep_placement_chain(links: usize) -> String {
    let mut s = String::from(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n\
FILE_NAME('t.ifc','2024-01-01T00:00:00',(''),(''),'','','');\n\
FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
#1=IFCAXIS2PLACEMENT3D(#2,$,$);\n\
#2=IFCCARTESIANPOINT((1.,0.,0.));\n\
#10=IFCLOCALPLACEMENT($,#1);\n",
    );
    for i in 1..=links {
        s.push_str(&format!("#{}=IFCLOCALPLACEMENT(#{},#1);\n", 10 + i, 9 + i));
    }
    s.push_str("ENDSEC;\nEND-ISO-10303-21;\n");
    s
}

/// World X of the leaf of a `links`-long chain, from the mesh path's walk and
/// from the 2D drawing path (`extract_profiles` on a wall placed at the leaf).
/// Each gets its OWN decoder: the router memoises composed placements on the
/// decoder, and sharing one would let the first walk's answer be handed to the
/// second, which is the one thing this test must not do.
fn both_walks(links: usize) -> (f64, f64) {
    let content = deep_placement_chain(links);
    let leaf_id = (10 + links) as u32;

    let mut router_decoder = EntityDecoder::new(&content);
    let leaf = router_decoder.decode_by_id(leaf_id).expect("leaf placement");
    let router_x = resolve_chain(&leaf, &mut router_decoder)
        .expect("placement transform")
        .column(3)[0];

    // A 1 x 1 x 1 extruded wall on the leaf; its profile's world X is the leaf's.
    let wall = format!(
        "#3=IFCCARTESIANPOINT((0.,0.));#4=IFCAXIS2PLACEMENT2D(#3,$);\n\
         #5=IFCRECTANGLEPROFILEDEF(.AREA.,$,#4,1.,1.);#6=IFCDIRECTION((0.,0.,1.));\n\
         #7=IFCEXTRUDEDAREASOLID(#5,$,#6,1.);#8=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#7));\n\
         #9=IFCPRODUCTDEFINITIONSHAPE($,$,(#8));\n\
         #5000=IFCWALL('0000000000000000000000',$,$,$,$,#{leaf_id},#9,$,$);\nENDSEC;"
    );
    let content = content.replacen("ENDSEC;\nEND-ISO", &format!("{wall}\nEND-ISO"), 1);
    let profiles = crate::profile_extractor::extract_profiles(&content, 0);
    assert_eq!(profiles.len(), 1, "the wall yields one drawing profile");
    // Column-major: the translation is elements 12..15; WebGL X is IFC X.
    let extractor_x = profiles[0].transform[12];

    (router_x, extractor_x)
}

fn x_of(id: u32, decoder: &mut EntityDecoder) -> f64 {
    let node = decoder.decode_by_id(id).expect("placement");
    resolve_chain(&node, decoder).expect("placement transform").column(3)[0]
}

/// A chain inside the old cap: both walks must report every link, which also
/// proves the fixture measures what it claims before the long cases use it.
#[test]
fn both_walks_compose_a_chain_inside_the_old_cap_identically() {
    let links = MAX_PLACEMENT_DEPTH / 2;
    let (router_x, extractor_x) = both_walks(links);
    assert_eq!((router_x, extractor_x), ((links + 1) as f64, (links + 1) as f64));
}

/// D27 (base: truncated at `MAX_PLACEMENT_DEPTH + 1` placements, silently).
/// A chain longer than the old cap resolves in full, from the mesh path and
/// the 2D drawing path alike.
#[test]
fn a_chain_beyond_the_old_cap_resolves_in_full() {
    let links = MAX_PLACEMENT_DEPTH + 50;
    let (router_x, extractor_x) = both_walks(links);
    assert_eq!(router_x, (links + 1) as f64, "the mesh path composes every link");
    assert_eq!(extractor_x, router_x, "the 2D path places it identically");
}

/// The walk is iterative: a chain far deeper than any stack the recursion
/// could have survived resolves, and its memo holds every node.
#[test]
fn a_very_deep_chain_resolves_without_recursion() {
    let links = 20_000;
    let content = deep_placement_chain(links);
    let mut decoder = EntityDecoder::new(&content);
    let leaf = (10 + links) as u32;
    assert_eq!(x_of(leaf, &mut decoder), (links + 1) as f64);
    assert!(decoder.get_placement_transform_cached(10).is_some(), "the root is memoised");
    assert!(decoder.get_placement_transform_cached(leaf).is_some(), "the leaf is memoised");
    assert_eq!(decoder.refused_records(), 0);
}

/// #3012, now by construction: the memo entry of a node is the same whether or
/// not a deeper element was resolved first, at every node of a chain that
/// crosses the old cap.
#[test]
fn every_node_resolves_the_same_cold_and_warm() {
    let links = MAX_PLACEMENT_DEPTH + 50;
    let content = deep_placement_chain(links);
    let mut warmed = EntityDecoder::new(&content);
    x_of((10 + links) as u32, &mut warmed);
    for id in (10..=10 + links as u32).step_by(7) {
        let cold = x_of(id, &mut EntityDecoder::new(&content));
        assert_eq!(cold, f64::from(id - 9), "#{id} composes its own {} links", id - 9);
        assert_eq!(cold, x_of(id, &mut warmed), "#{id} warm == cold");
    }
}

/// The same obligation through the `IfcLinearPlacement` branch: its authored
/// `CartesianPosition` is the same +1.0 X as every other link.
#[test]
fn a_linear_placement_in_a_long_chain_resolves_the_same_cold_and_warm() {
    let links = MAX_PLACEMENT_DEPTH + 20;
    let linear_id = 10 + links / 2;
    let content = deep_placement_chain(links).replace(
        &format!("#{linear_id}=IFCLOCALPLACEMENT(#{},#1);", linear_id - 1),
        &format!("#{linear_id}=IFCLINEARPLACEMENT(#{},$,#1);", linear_id - 1),
    );
    assert!(content.contains("IFCLINEARPLACEMENT"), "the substitution must land");
    assert_two_orders_agree(&content, linear_id, links);
    assert_two_orders_agree(&content, 10 + links, links);
}

/// And through the `IfcGridPlacement` branch. Axis P runs +X through the origin
/// and axis Q runs +Y through it; offsetting Q by -1 along its left normal
/// `(-1, 0)` moves the intersection to (1, 0, 0), matching the +1.0 X of the
/// link it replaces.
#[test]
fn a_grid_placement_in_a_long_chain_resolves_the_same_cold_and_warm() {
    let links = MAX_PLACEMENT_DEPTH + 20;
    let grid_id = 10 + links / 2;
    let grid = format!(
        "#900=IFCCARTESIANPOINT((0.,0.));\n\
#901=IFCCARTESIANPOINT((10.,0.));\n\
#902=IFCPOLYLINE((#900,#901));\n\
#903=IFCGRIDAXIS('P',#902,.T.);\n\
#904=IFCCARTESIANPOINT((0.,10.));\n\
#905=IFCPOLYLINE((#900,#904));\n\
#906=IFCGRIDAXIS('Q',#905,.T.);\n\
#907=IFCVIRTUALGRIDINTERSECTION((#903,#906),(0.,-1.,0.));\n\
#{grid_id}=IFCGRIDPLACEMENT(#{},#907,$);",
        grid_id - 1
    );
    // `IFCGRIDPLACEMENT(PlacementRelTo, ...)` is the IFC4X1+ layout; the header
    // must say so, since IFC2X3/IFC4 read the record without that slot.
    let content = deep_placement_chain(links)
        .replace(&format!("#{grid_id}=IFCLOCALPLACEMENT(#{},#1);", grid_id - 1), &grid)
        .replace("FILE_SCHEMA(('IFC4'))", "FILE_SCHEMA(('IFC4X3'))");
    assert!(content.contains("IFCGRIDPLACEMENT") && content.contains("'IFC4X3'"), "the substitution must land");
    assert_two_orders_agree(&content, grid_id, links);
    assert_two_orders_agree(&content, 10 + links, links);
}

/// World X of `node_id` from a cold decoder and from one warmed by resolving
/// the leaf of the `links`-long chain first; both are `node_id - 9` links.
fn assert_two_orders_agree(content: &str, node_id: usize, links: usize) {
    let cold = x_of(node_id as u32, &mut EntityDecoder::new(content));
    assert_eq!(cold, (node_id - 9) as f64, "the substituted link contributes +1.0 X like its neighbours");
    let mut warmed = EntityDecoder::new(content);
    x_of((10 + links) as u32, &mut warmed);
    assert_eq!(cold, x_of(node_id as u32, &mut warmed), "#{node_id}: cold == warm");
}

const CYCLE: &str = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n\
FILE_NAME('t.ifc','2024-01-01T00:00:00',(''),(''),'','','');\n\
FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
#1=IFCAXIS2PLACEMENT3D(#2,$,$);\n\
#2=IFCCARTESIANPOINT((1.,0.,0.));\n\
#10=IFCLOCALPLACEMENT(#11,#1);\n\
#11=IFCLOCALPLACEMENT(#10,#1);\n\
#12=IFCLOCALPLACEMENT(#12,#1);\n\
#13=IFCLOCALPLACEMENT(#10,#1);\n\
ENDSEC;\nEND-ISO-10303-21;\n";

/// D27, §3.8: a cycle has no world transform. It is refused (base composed 101
/// links of garbage and drew the element displaced), the same from either
/// start node and for a descendant, counted per distinct record, and never
/// memoised.
#[test]
fn a_placement_cycle_is_refused_counted_and_not_memoised() {
    let mut decoder = EntityDecoder::new(CYCLE);
    for id in [10, 11, 12, 13] {
        let node = decoder.decode_by_id(id).expect("placement");
        assert!(
            matches!(resolve_chain(&node, &mut decoder), Err(PlacementError::Cyclic { .. })),
            "#{id} sits on or below a cycle"
        );
        assert!(decoder.get_placement_transform_cached(id).is_none(), "#{id} must not be memoised");
    }
    // #10 and #11 are one cycle (detected at the revisited node), #12 its own.
    assert!(decoder.refused_records() >= 2, "counted: {}", decoder.refused_records());
    let before = decoder.refused_records();
    let node = decoder.decode_by_id(10).unwrap();
    assert!(resolve_chain(&node, &mut decoder).is_err());
    assert_eq!(decoder.refused_records(), before, "one record is counted once");
}

#[test]
fn the_router_refuses_a_cyclic_placement() {
    let mut decoder = EntityDecoder::new(CYCLE);
    let node = decoder.decode_by_id(11).unwrap();
    assert!(GeometryRouter::new().resolve_scaled_placement(&node, &mut decoder).is_ok(), "no ObjectPlacement attr is identity");
    let product = "#20=IFCWALL('0000000000000000000000',$,$,$,$,#11,$,$,$);\n";
    let content = CYCLE.replacen("ENDSEC;\nEND-ISO", &format!("{product}ENDSEC;\nEND-ISO"), 1);
    let mut decoder = EntityDecoder::new(&content);
    let wall = decoder.decode_by_id(20).unwrap();
    assert!(GeometryRouter::new().resolve_scaled_placement_strict(&wall, &mut decoder).is_err());
    assert_eq!(decoder.refused_records(), 1);
}

#[test]
fn chain_lists_the_links_leaf_first() {
    let content = deep_placement_chain(3);
    let mut decoder = EntityDecoder::new(&content);
    let leaf = decoder.decode_by_id(13).unwrap();
    let links = chain(&leaf, &mut decoder).unwrap();
    assert_eq!(links.iter().map(|l| l.id).collect::<Vec<_>>(), vec![13, 12, 11, 10]);
    assert!(links.iter().all(|l| l.kind == LinkKind::Local));
    assert!(decoder.get_placement_transform_cached(13).is_none(), "chain() composes and memoises nothing");
    let mut decoder = EntityDecoder::new(CYCLE);
    let node = decoder.decode_by_id(10).unwrap();
    assert!(matches!(chain(&node, &mut decoder), Err(PlacementError::Cyclic { .. })));
}

#[test]
fn resolve_object_placement_is_none_only_for_a_missing_placement() {
    let content = format!(
        "{}#20=IFCWALL('0000000000000000000000',$,$,$,$,$,$,$,$);\n#21=IFCWALL('0000000000000000000001',$,$,$,$,#12,$,$,$);\nENDSEC;",
        deep_placement_chain(3).replace("ENDSEC;\nEND-ISO-10303-21;\n", "")
    );
    let mut decoder = EntityDecoder::new(&content);
    let bare = decoder.decode_by_id(20).unwrap();
    assert!(resolve_object_placement(&bare, &mut decoder).unwrap().is_none());
    let placed = decoder.decode_by_id(21).unwrap();
    let m = resolve_object_placement(&placed, &mut decoder).unwrap().expect("placed");
    assert_eq!(m.column(3)[0], 3.0);
}

#[test]
fn validate_chain_applies_the_consumers_policy() {
    let local_only = ChainPolicy::default();
    let content = deep_placement_chain(2);
    let mut decoder = EntityDecoder::new(&content);
    let leaf = decoder.decode_by_id(12).unwrap();
    validate_chain(&leaf, &mut decoder, &local_only).unwrap();
    validate_chain(&leaf, &mut decoder, &ChainPolicy { strict_spatial: true, ..local_only }).unwrap();

    // Linear links are a policy decision, not bad input.
    let linear = content.replace("#11=IFCLOCALPLACEMENT(#10,#1);", "#11=IFCLINEARPLACEMENT(#10,$,#1);");
    let mut decoder = EntityDecoder::new(&linear);
    let leaf = decoder.decode_by_id(12).unwrap();
    assert!(matches!(validate_chain(&leaf, &mut decoder, &local_only), Err(PlacementError::Policy { at: 11, .. })));
    validate_chain(&leaf, &mut decoder, &ChainPolicy { linear: true, ..local_only }).unwrap();

    // strict_spatial: 2 coordinates, a zero direction and parallel axes are refused.
    let strict = ChainPolicy { strict_spatial: true, ..local_only };
    for (replacement, bad) in [
        ("#2=IFCCARTESIANPOINT((1.,0.));", "exactly 3"),
        ("#2=IFCCARTESIANPOINT((1.,0.,0.));#3=IFCDIRECTION((0.,0.,0.));#1=IFCAXIS2PLACEMENT3D(#2,#3,$);", "zero"),
        ("#2=IFCCARTESIANPOINT((1.,0.,0.));#3=IFCDIRECTION((0.,0.,1.));#1=IFCAXIS2PLACEMENT3D(#2,#3,#3);", "parallel"),
    ] {
        let mutated = content
            .replace("#1=IFCAXIS2PLACEMENT3D(#2,$,$);", if bad == "exactly 3" { "#1=IFCAXIS2PLACEMENT3D(#2,$,$);" } else { "" })
            .replace("#2=IFCCARTESIANPOINT((1.,0.,0.));", replacement);
        let mut decoder = EntityDecoder::new(&mutated);
        let leaf = decoder.decode_by_id(12).unwrap();
        let err = validate_chain(&leaf, &mut decoder, &strict).expect_err(bad);
        assert!(err.to_string().contains(bad), "{bad}: {err}");
        validate_chain(&leaf, &mut decoder, &local_only).expect("the lenient policy accepts it");
    }
}
