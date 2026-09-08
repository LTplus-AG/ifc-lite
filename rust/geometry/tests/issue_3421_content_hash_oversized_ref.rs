// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression for #3421 at the site where a wrapped express-id REFERENCE stops
//! being untidy and becomes a wrong picture: the geometry content-dedup hash.
//!
//! #3740 fixed the hash itself and pinned it at the unit level
//! (`content_hash_tests.rs`: an oversized child ref hashes like a missing one
//! and unlike the real entity it would wrap onto). This file guards the
//! CONSEQUENCE that made it worth fixing, which a signature comparison cannot
//! show: what the two caches keyed on that signature then do.
//!
//! `sig_walk_bytes` used to accumulate a `#<digits>` reference with
//! `wrapping_mul`/`wrapping_add`. `#4294967303` is `2^32 + 7`, so it wrapped to
//! `7` and the walk recursed into the REAL entity `#7` — the signature of a
//! profile naming a nonexistent entity became, bit for bit, the signature of a
//! profile naming `#7`. That signature is the key of:
//!
//! * `GeometryRouter::geometry_routing_key`, which a host uses to send
//!   byte-identical geometry to the same worker, and
//! * `item_dedup_cache`, consulted BEFORE meshing, whose hit returns the
//!   earlier item's mesh AND its instancing `rep_identity`.
//!
//! So the collision produced a mis-instancing, not a mis-parse. Run against the
//! parent of #3740 the third test below reports it directly: the item whose
//! profile names nothing is handed the other item's 200x300x1000 box.
//!
//! The oversized reference sits one level DOWN, in the profile, because that is
//! the only place it can sit and still be reached. `rust/core`'s tokenizer
//! refuses the whole record when the reference is a direct attribute of the
//! item being decoded (#3395/#3432), so such an item never reaches the router.
//! The dedup hash, by contrast, walks the subtree from RAW BYTES and never
//! decodes it — which is exactly why its own accumulator had to be fixed
//! separately, and why a fix confined to `rust/core` left this hole open.
//!
//! Both directions run through the SAME shape, so nothing separates them but
//! the bound: `#4294967295` is `u32::MAX`, a legal express id, and this model
//! defines a real entity under it; `#4294967303` is one bound too far and
//! defines nothing.

use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::GeometryRouter;

/// `2^32 + 7` — wraps onto the real 2D placement `#7` in a `u32` accumulator,
/// and names no entity in any store that can hold an express id.
const WRAPS_ONTO_SEVEN: &str = "4294967303";

/// `u32::MAX`. The model below DEFINES this entity, byte-identical to `#7`, so
/// a reader that still binds it hashes the same subtree `#7` does, and a reader
/// that refuses it does not.
const AT_THE_BOUND: &str = "4294967295";

/// A model with three extrusions whose profiles are byte-identical except for
/// the express id of the profile's `Position` reference:
///
/// * `#10` names the real `#7`, extruded by `#20`, worn by wall `#50`.
/// * `#11` names `position_ref_b`, extruded by `#21`, worn by wall `#51`.
/// * `#12` names the real `#7` again, extruded by `#22`, worn by wall `#52` —
///   the control, proving the assertions below can tell "same" from
///   "different" rather than reporting "different" for everything.
///
/// `#4294967295` is defined as a byte-identical twin of `#7`, so a reference to
/// it and a reference to `#7` MUST hash alike: the signature is renumbering-
/// invariant by design (it folds the resolved subtree, never the id).
fn model_with(position_ref_b: &str) -> String {
    format!(
        "ISO-10303-21;\n\
         HEADER;\n\
         FILE_DESCRIPTION((''),'2;1');\n\
         FILE_NAME('','',(''),(''),'','','');\n\
         FILE_SCHEMA(('IFC4'));\n\
         ENDSEC;\n\
         DATA;\n\
         #1=IFCCARTESIANPOINT((0.,0.,0.));\n\
         #2=IFCDIRECTION((0.,0.,1.));\n\
         #3=IFCDIRECTION((1.,0.,0.));\n\
         #4=IFCAXIS2PLACEMENT3D(#1,#2,#3);\n\
         #5=IFCCARTESIANPOINT((17.,-4.));\n\
         #6=IFCDIRECTION((0.,1.));\n\
         #7=IFCAXIS2PLACEMENT2D(#5,#6);\n\
         #4294967295=IFCAXIS2PLACEMENT2D(#5,#6);\n\
         #10=IFCRECTANGLEPROFILEDEF(.AREA.,'P',#7,200.,300.);\n\
         #11=IFCRECTANGLEPROFILEDEF(.AREA.,'P',#{position_ref_b},200.,300.);\n\
         #12=IFCRECTANGLEPROFILEDEF(.AREA.,'P',#7,200.,300.);\n\
         #20=IFCEXTRUDEDAREASOLID(#10,#4,#2,1000.);\n\
         #21=IFCEXTRUDEDAREASOLID(#11,#4,#2,1000.);\n\
         #22=IFCEXTRUDEDAREASOLID(#12,#4,#2,1000.);\n\
         #30=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#20));\n\
         #31=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#21));\n\
         #32=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#22));\n\
         #40=IFCPRODUCTDEFINITIONSHAPE($,$,(#30));\n\
         #41=IFCPRODUCTDEFINITIONSHAPE($,$,(#31));\n\
         #42=IFCPRODUCTDEFINITIONSHAPE($,$,(#32));\n\
         #50=IFCWALL('0GUIDwallAAAAAAAAAAAAA',$,'W',$,$,$,#40,$);\n\
         #51=IFCWALL('0GUIDwallBBBBBBBBBBBBB',$,'W',$,$,$,#41,$);\n\
         #52=IFCWALL('0GUIDwallCCCCCCCCCCCCC',$,'W',$,$,$,#42,$);\n\
         ENDSEC;\n\
         END-ISO-10303-21;\n"
    )
}

/// The routing keys of walls `#50` (real `#7`), `#51` (`position_ref_b`) and
/// `#52` (real `#7`), in that order.
fn routing_keys(content: &str) -> [Option<u128>; 3] {
    let bytes = content.as_bytes();
    let mut decoder = EntityDecoder::with_index(bytes, build_entity_index(bytes));
    let router = GeometryRouter::with_units(bytes, &mut decoder);
    [50u32, 51, 52].map(|wall| {
        let element = decoder
            .decode_by_id(wall)
            .unwrap_or_else(|e| panic!("decode wall #{wall}: {e}"));
        router.geometry_routing_key(&element, &mut decoder)
    })
}

#[test]
fn an_oversized_reference_does_not_collide_with_the_entity_it_wraps_onto() {
    let [a, b, c] = routing_keys(&model_with(WRAPS_ONTO_SEVEN));

    // The control pair: two items whose subtrees name the SAME real placement
    // must still share a key. Without this, "a != b" below would also pass if
    // the hash had simply stopped deduping everything.
    assert_eq!(
        a, c,
        "two byte-identical items must still share a content-dedup key"
    );
    assert!(a.is_some(), "a wall with geometry must have a routing key");

    assert_ne!(
        a, b,
        "#{WRAPS_ONTO_SEVEN} is 2^32+7 and names no entity, but a wrapping \
         accumulator resolved it to the real #7 — giving the two items one \
         dedup key, so the second is served the first's mesh and collated into \
         its instance template (#3421)"
    );
}

#[test]
fn a_reference_at_exactly_u32_max_still_binds_to_its_entity() {
    // The other direction, through the same shape. u32::MAX is a LEGAL express
    // id and this model defines it, so refusing it would trade the #3421
    // collision for a lost reference — geometry that silently stops deduping,
    // or resolves to nothing at all.
    let [a, b, c] = routing_keys(&model_with(AT_THE_BOUND));
    assert_eq!(a, c, "the control pair must still share a key");
    assert_eq!(
        a, b,
        "#{AT_THE_BOUND} is u32::MAX, a legal express id, and names an entity \
         byte-identical to #7; the signature folds the resolved subtree rather \
         than the id, so binding it must produce the same key (#3421)"
    );
}

#[test]
fn the_dedup_cache_does_not_serve_a_wrapped_reference_the_other_item_s_mesh() {
    // End-to-end through the cache the key feeds, not just the key: mesh the
    // real item first so it lands in `item_dedup_cache`, then ask for the item
    // whose profile position reference is 2^32+7. Pre-fix the cache answered
    // with the first item's mesh before the mesher was ever consulted.
    let content = model_with(WRAPS_ONTO_SEVEN);
    let bytes = content.as_bytes();
    let mut decoder = EntityDecoder::with_index(bytes, build_entity_index(bytes));
    let router = GeometryRouter::with_units(bytes, &mut decoder);

    let real = decoder.decode_by_id(20).expect("decode #20");
    let real_mesh = router
        .process_representation_item(&real, &mut decoder)
        .expect("the real extrusion meshes");
    assert!(
        !real_mesh.positions.is_empty(),
        "the control item must produce geometry, or the cache is never \
         populated and this test proves nothing"
    );

    let cached_after_real = router.dedup_unique_count();
    assert_eq!(cached_after_real, 1, "the control item must populate the cache");

    let oversized = decoder.decode_by_id(21).expect("decode #21");
    match router.process_representation_item(&oversized, &mut decoder) {
        // Refusing to mesh an item whose profile names no entity is the honest
        // outcome; being handed SOMEONE ELSE'S geometry is not.
        Err(_) => {}
        Ok(mesh) => {
            // Ask the cache, not the vertices. A hit is precisely "no new entry
            // was inserted", which is what a colliding key causes; comparing
            // positions only infers it, and would infer it WRONGLY if the mesher
            // ever resolved `#11` to something that happened to mesh like `#10`.
            // `#7` is deliberately a translated, rotated placement rather than
            // the identity for the same reason.
            assert_eq!(
                router.dedup_unique_count(),
                2,
                "an item whose profile reference names no entity was served an \
                 unrelated item's mesh out of the content-dedup cache: no new \
                 entry was inserted, so the key collided (#3421)"
            );
            assert_ne!(
                mesh.positions, real_mesh.positions,
                "and its geometry is the other item's, vertex for vertex (#3421)"
            );
        }
    }

    // The control still dedups: a third item byte-identical to #20 must hit.
    let twin = decoder.decode_by_id(22).expect("decode #22");
    let twin_mesh = router
        .process_representation_item(&twin, &mut decoder)
        .expect("the twin extrusion meshes");
    assert_eq!(
        twin_mesh.positions, real_mesh.positions,
        "byte-identical items must still dedup to the same mesh"
    );
}
