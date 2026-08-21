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

