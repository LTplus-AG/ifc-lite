// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The `IfcLocalPlacement.PlacementRelTo` walk is implemented twice — once in
//! `router::transforms` (mesh path) and once in `profile_extractor` (2D drawing
//! path) — and both bound it with a depth cap whose exceed-branch returns the
//! IDENTITY. Two caps over one chain therefore do not disagree loudly: they
//! disagree by putting the same element in two different places, with no error
//! on either side. #2873
//!
//! These tests pin (a) each site's cap IS `ifc_lite_core::limits::MAX_PLACEMENT_DEPTH`
//! and (b) the two walks agree on a chain deeper than that cap. (a) alone is not
//! enough: a private `const MAX_PLACEMENT_DEPTH` shadows the import and nothing
//! else notices, which is exactly how #2955's mapped-item family failed.

use super::*;
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

/// World X of the leaf of a `links`-long chain, from each of the two walks.
/// Each walk gets its OWN decoder: the router memoises composed placements on
/// the decoder, and sharing one would let the first walk's answer be handed to
/// the second, which is the one thing this test must not do.
fn both_walks(links: usize) -> (f64, f64) {
    let content = deep_placement_chain(links);
    let leaf_id = (10 + links) as u32;

    let mut router_decoder = EntityDecoder::new(&content);
    let leaf = router_decoder.decode_by_id(leaf_id).expect("leaf placement");
    let router = GeometryRouter::new();
    let router_x = router
        .get_placement_transform(&leaf, &mut router_decoder)
        .expect("router placement transform")
        .column(3)[0];

    let mut extractor_decoder = EntityDecoder::new(&content);
    let leaf = extractor_decoder
        .decode_by_id(leaf_id)
        .expect("leaf placement");
    let extractor_x =
        crate::profile_extractor::get_placement_recursive(&leaf, &mut extractor_decoder, 0)
            .column(3)[0];

    (router_x, extractor_x)
}

/// A chain the walk composes in full: both must report every link, which also
/// proves the fixture measures what it claims before the truncation cases use it.
#[test]
fn both_walks_compose_a_chain_inside_the_cap_identically() {
    let links = MAX_PLACEMENT_DEPTH / 2;
    let (router_x, extractor_x) = both_walks(links);
    let expected = (links + 1) as f64;
    assert_eq!(
        router_x, expected,
        "the router must compose all {} placements of an in-cap chain",
        links + 1
    );
    assert_eq!(
        extractor_x, expected,
        "the extractor must compose all {} placements of an in-cap chain",
        links + 1
    );
}

/// THE divergence. A chain longer than the shared cap is truncated by both
/// walks, and truncation is silent on both — so the only thing that can make
/// the mesh path and the 2D path put an element in the same place is the two
/// caps being equal. With the router at 32 and the extractor at 100 this
/// returned 33.0 and 41.0 for a 40-link chain: same file, same element, two
/// positions, no error.
#[test]
fn both_walks_truncate_a_chain_beyond_the_cap_at_the_same_link() {
    let links = MAX_PLACEMENT_DEPTH + 8;
    let (router_x, extractor_x) = both_walks(links);
    assert_eq!(
        router_x, extractor_x,
        "the mesh path and the 2D drawing path must place a {}-link chain \
         identically; they differ by {} links of translation, and neither \
         reports an error",
        links + 1,
        (router_x - extractor_x).abs()
    );
    assert_eq!(
        router_x,
        (MAX_PLACEMENT_DEPTH + 1) as f64,
        "the cap admits depths 0..=MAX_PLACEMENT_DEPTH, i.e. MAX_PLACEMENT_DEPTH + 1 placements"
    );
}

/// Site 1 of 2. Sharing the constant removes today's drift; this stops a
/// private copy from reintroducing it. #2955 proved the need by mutation: a
/// local `const` shadowed the import and 800 tests stayed green.
#[test]
fn the_router_cap_is_the_shared_cap() {
    assert_eq!(
        GeometryRouter::MAX_PLACEMENT_DEPTH,
        MAX_PLACEMENT_DEPTH,
        "router::transforms must bound PlacementRelTo with ifc_lite_core::limits::MAX_PLACEMENT_DEPTH"
    );
}

/// Site 2 of 2. See above.
#[test]
fn the_profile_extractor_cap_is_the_shared_cap() {
    assert_eq!(
        crate::profile_extractor::MAX_PLACEMENT_DEPTH,
        MAX_PLACEMENT_DEPTH,
        "profile_extractor must bound PlacementRelTo with ifc_lite_core::limits::MAX_PLACEMENT_DEPTH"
    );
}

/// #3012. The router memoises composed placements per decoder. A walk that hits
/// the depth cap returns the identity for the node ABOVE the cap, and the node
/// AT the cap then composes `identity * local` — a truncated transform — and
/// wrote it to the memo — as did every node above it, each composing on a
/// truncated parent. Later queries for those nodes were served the truncated
/// values, so the same placement resolved to two different positions depending
/// on whether a deeper element had been resolved first.
///
/// Resolving the leaf of a `MAX_PLACEMENT_DEPTH + 20` chain truncates at
/// `#(10 + links - MAX_PLACEMENT_DEPTH)`. Every node from there up to
/// `#(10 + MAX_PLACEMENT_DEPTH)` still has a chain the cap composes in full, so
/// each has one correct answer both orders must produce. Checking the whole span
/// rather than only the first node is what makes the poisoning of the nodes
/// ABOVE the cap visible too.
#[test]
fn a_truncated_walk_does_not_poison_the_placement_memo() {
    let links = MAX_PLACEMENT_DEPTH + 20;
    let content = deep_placement_chain(links);
    let leaf_id = (10 + links) as u32;
    // The node the leaf's walk reaches AT the cap: its parent is the first
    // lookup the depth guard refuses.
    let capped_id = (10 + links - MAX_PLACEMENT_DEPTH) as u32;
    // The last node whose OWN chain still fits the cap, so its cold answer is
    // complete; above this every walk truncates in both orders.
    let last_in_cap_id = (10 + MAX_PLACEMENT_DEPTH) as u32;
    let router = GeometryRouter::new();

    // One decoder, warmed by resolving the leaf — the walk that truncates.
    let mut warmed = EntityDecoder::new(&content);
    let leaf = warmed.decode_by_id(leaf_id).expect("leaf placement");
    router
        .get_placement_transform(&leaf, &mut warmed)
        .expect("leaf placement transform");

    for id in capped_id..=last_in_cap_id {
        // Each cold reading gets its own decoder, so no earlier answer of ours
        // can stand in for the walk this one must perform.
        let mut cold = EntityDecoder::new(&content);
        let node = cold.decode_by_id(id).expect("node placement");
        let cold_x = router
            .get_placement_transform(&node, &mut cold)
            .expect("cold placement transform")
            .column(3)[0];
        assert_eq!(
            cold_x,
            f64::from(id - 9),
            "#{id}'s chain fits the cap, so a cold walk must compose all {} of \
             its placements — otherwise the two orders agree for the wrong reason",
            id - 9
        );

        let node = warmed.decode_by_id(id).expect("node placement");
        let warm_x = router
            .get_placement_transform(&node, &mut warmed)
            .expect("warmed placement transform")
            .column(3)[0];
        assert_eq!(
            cold_x, warm_x,
            "#{id} must resolve identically whether or not a deeper element was \
             resolved first; the warmed answer is the depth-truncated composition \
             served from the memo"
        );
    }
}

/// The same order-dependence driven through the `IfcLinearPlacement` branch of
/// the walk: it composes `PlacementRelTo` exactly like `IfcLocalPlacement`, so it
/// inherits its parent's truncation and must not memoise a truncated result
/// either. The capped node becomes a linear placement whose authored
/// `CartesianPosition` is the same +1.0 X as every other link, which keeps the
/// chain's expected values unchanged.
#[test]
fn a_truncated_linear_placement_walk_does_not_poison_the_placement_memo() {
    let links = MAX_PLACEMENT_DEPTH + 20;
    let capped_id = 10 + links - MAX_PLACEMENT_DEPTH;
    let content = deep_placement_chain(links).replace(
        &format!("#{capped_id}=IFCLOCALPLACEMENT(#{},#1);", capped_id - 1),
        // RelativePlacement absent; CartesianPosition #1 is the +1.0 X origin.
        &format!("#{capped_id}=IFCLINEARPLACEMENT(#{},$,#1);", capped_id - 1),
    );
    assert!(
        content.contains("IFCLINEARPLACEMENT"),
        "the substitution must land, or this test re-runs the IfcLocalPlacement case"
    );
    assert_two_orders_agree(&content, capped_id, links);
}

/// And through the `IfcGridPlacement` branch, which composes `PlacementRelTo` the
/// same way and carries the same obligation. Axis P runs +X through the origin
/// and axis Q runs +Y through it; offsetting Q by -1 along its left normal
/// `(-1, 0)` moves the intersection to (1, 0, 0), matching the +1.0 X of the link
/// it replaces.
#[test]
fn a_truncated_grid_placement_walk_does_not_poison_the_placement_memo() {
    let links = MAX_PLACEMENT_DEPTH + 20;
    let capped_id = 10 + links - MAX_PLACEMENT_DEPTH;
    let grid = format!(
        "#900=IFCCARTESIANPOINT((0.,0.));\n\
#901=IFCCARTESIANPOINT((10.,0.));\n\
#902=IFCPOLYLINE((#900,#901));\n\
#903=IFCGRIDAXIS('P',#902,.T.);\n\
#904=IFCCARTESIANPOINT((0.,10.));\n\
#905=IFCPOLYLINE((#900,#904));\n\
#906=IFCGRIDAXIS('Q',#905,.T.);\n\
#907=IFCVIRTUALGRIDINTERSECTION((#903,#906),(0.,-1.,0.));\n\
#{capped_id}=IFCGRIDPLACEMENT(#{},#907,$);",
        capped_id - 1
    );
    let content = deep_placement_chain(links).replace(
        &format!("#{capped_id}=IFCLOCALPLACEMENT(#{},#1);", capped_id - 1),
        &grid,
    );
    assert!(
        content.contains("IFCGRIDPLACEMENT"),
        "the substitution must land, or this test re-runs the IfcLocalPlacement case"
    );
    assert_two_orders_agree(&content, capped_id, links);
}

/// World X of `node_id` from a cold decoder and from one warmed by resolving the
/// leaf of the `links`-long chain first. Both must equal the full composition of
/// `node_id`'s own chain, which is `node_id - 9` links of +1.0 X.
fn assert_two_orders_agree(content: &str, node_id: usize, links: usize) {
    let router = GeometryRouter::new();

    let mut cold = EntityDecoder::new(content);
    let node = cold.decode_by_id(node_id as u32).expect("capped node");
    let cold_x = router
        .get_placement_transform(&node, &mut cold)
        .expect("cold placement transform")
        .column(3)[0];
    assert_eq!(
        cold_x,
        (node_id - 9) as f64,
        "the substituted placement must contribute the same +1.0 X as the links \
         below it, or the two orders could agree for the wrong reason"
    );

    let mut warmed = EntityDecoder::new(content);
    let leaf = warmed.decode_by_id((10 + links) as u32).expect("leaf");
    router
        .get_placement_transform(&leaf, &mut warmed)
        .expect("leaf placement transform");
    let node = warmed.decode_by_id(node_id as u32).expect("capped node");
    let warm_x = router
        .get_placement_transform(&node, &mut warmed)
        .expect("warmed placement transform")
        .column(3)[0];

    assert_eq!(
        cold_x, warm_x,
        "#{node_id} must resolve identically whether or not a deeper element was \
         resolved first"
    );
}

/// #3043 follow-up. The depth guard used to run BEFORE the memo lookup, so a
/// node whose complete transform was already memoised got refused at the cap and
/// the caller was handed a shorter chain instead — a complete answer discarded in
/// favour of a truncated one.
///
/// On a `MAX_PLACEMENT_DEPTH + 8` chain the walk from the leaf reaches
/// `#(10 + links - MAX_PLACEMENT_DEPTH - 1)` at depth `MAX_PLACEMENT_DEPTH + 1`,
/// the first depth the guard refuses. Warm that one node and the leaf's answer
/// goes from `MAX_PLACEMENT_DEPTH + 1` links to the whole chain — but only if the
/// memo is consulted first. Guard-first, the warmed decoder still reports the
/// truncated 101.
///
/// The swap costs no stack: a memo hit returns instead of recursing, so it
/// replaces the rejected frame rather than adding one. Measured with an atomic
/// max-depth probe on the recursion, max depth is `MAX_PLACEMENT_DEPTH + 1` in
/// both the cold and the warmed case.
#[test]
fn a_memoised_ancestor_at_the_cap_is_served_rather_than_refused() {
    let links = MAX_PLACEMENT_DEPTH + 8;
    let content = deep_placement_chain(links);
    let leaf_id = (10 + links) as u32;
    // The node the leaf's walk reaches at depth MAX_PLACEMENT_DEPTH + 1 — the
    // first lookup the guard refuses, and so the one a memo hit must rescue.
    let refused_id = (10 + links - MAX_PLACEMENT_DEPTH - 1) as u32;
    let router = GeometryRouter::new();

    // Cold: the guard stops the walk, and the truncated result must not be
    // memoised — the direction #3012 fixed, re-pinned here because a fix that
    // widened what the memo serves would reintroduce it.
    let mut cold = EntityDecoder::new(&content);
    let leaf = cold.decode_by_id(leaf_id).expect("leaf placement");
    let cold_x = router
        .get_placement_transform(&leaf, &mut cold)
        .expect("cold placement transform")
        .column(3)[0];
    assert_eq!(
        cold_x,
        (MAX_PLACEMENT_DEPTH + 1) as f64,
        "a cold walk of a {}-placement chain composes only the {} the cap admits",
        links + 1,
        MAX_PLACEMENT_DEPTH + 1
    );
    assert!(
        cold.get_placement_transform_cached(leaf_id).is_none(),
        "the truncated leaf transform must never reach the memo"
    );
    assert!(
        cold.get_placement_transform_cached(refused_id + 1).is_none(),
        "nor may the node AT the cap, whose composition is `identity * local`"
    );

    // Warmed at the refused node, whose own chain fits the cap and so has one
    // complete answer.
    let mut warmed = EntityDecoder::new(&content);
    let refused = warmed.decode_by_id(refused_id).expect("refused placement");
    let refused_x = router
        .get_placement_transform(&refused, &mut warmed)
        .expect("refused placement transform")
        .column(3)[0];
    assert_eq!(
        refused_x,
        f64::from(refused_id - 9),
        "#{refused_id}'s own chain fits the cap, so warming it memoises a COMPLETE \
         transform — otherwise this test would only prove the memo serves junk"
    );

    let leaf = warmed.decode_by_id(leaf_id).expect("leaf placement");
    let warm_x = router
        .get_placement_transform(&leaf, &mut warmed)
        .expect("warmed placement transform")
        .column(3)[0];
    assert_eq!(
        warm_x,
        (links + 1) as f64,
        "with #{refused_id} memoised the walk composes the whole {}-placement \
         chain: the hit is a return, not a frame, so the cap has nothing to \
         refuse. Checking the depth guard before the memo drops that cached \
         transform and reports {cold_x} instead",
        links + 1
    );
}

/// Two placements pointing at each other — far likelier in a malformed file than
/// a 101-link chain, and the case that first drove a partial product into the
/// memo for every node on the cycle.
///
/// A cycle has no correct world transform, so the property that exists is
/// order-independence: `#11` must resolve the same whether or not `#10` was
/// resolved first. Before #3012 it did not — the first query wrote its partial
/// composition for both nodes, and the second was served it.
#[test]
fn a_placement_cycle_resolves_the_same_in_either_order() {
    let content = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n\
FILE_NAME('t.ifc','2024-01-01T00:00:00',(''),(''),'','','');\n\
FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
#1=IFCAXIS2PLACEMENT3D(#2,$,$);\n\
#2=IFCCARTESIANPOINT((1.,0.,0.));\n\
#10=IFCLOCALPLACEMENT(#11,#1);\n\
#11=IFCLOCALPLACEMENT(#10,#1);\n\
ENDSEC;\nEND-ISO-10303-21;\n";
    let router = GeometryRouter::new();
    let expected = (MAX_PLACEMENT_DEPTH + 1) as f64;

    let mut alone = EntityDecoder::new(content);
    let n11 = alone.decode_by_id(11).expect("#11");
    let alone_x = router
        .get_placement_transform(&n11, &mut alone)
        .expect("#11 alone")
        .column(3)[0];
    assert_eq!(
        alone_x, expected,
        "the cap admits depths 0..=MAX_PLACEMENT_DEPTH, so a cycle composes \
         {expected} links of +1.0 X before it stops"
    );

    let mut after = EntityDecoder::new(content);
    let n10 = after.decode_by_id(10).expect("#10");
    router
        .get_placement_transform(&n10, &mut after)
        .expect("#10 first");
    let n11 = after.decode_by_id(11).expect("#11");
    let after_x = router
        .get_placement_transform(&n11, &mut after)
        .expect("#11 after #10")
        .column(3)[0];
    assert_eq!(
        alone_x, after_x,
        "#11 must resolve identically whether or not #10 was resolved first; \
         the differing answer is #10's partial composition served from the memo"
    );

    assert!(
        alone.get_placement_transform_cached(11).is_none()
            && alone.get_placement_transform_cached(10).is_none(),
        "every node on a cycle is reached through a truncated walk, so none of \
         them may be memoised"
    );
}
