// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/// `MAX_MAPPED_ITEM_DEPTH` must be the one in `ifc_lite_core::limits`, not
/// a private copy that happens to hold the same number today.
///
/// This is not redundant with the constant being shared. Sharing removes
/// the drift that EXISTS; it does not stop anyone reintroducing a local
/// `const MAX_MAPPED_ITEM_DEPTH` that shadows the import. Verified by
/// mutation: with the import replaced by a private `= 16`, 800 tests stayed
/// green until this test existed. A mid-review revision of #2864 held
/// exactly that value against the router's 32, so the shadow is not a
/// hypothetical shape.
///
/// The assertion is on the VALUE, not on identity, so a private copy
/// holding the same 32 still passes. That is the honest ceiling: Rust has
/// no cheap const-identity check, and a same-value shadow is harmless until
/// the shared value is next tuned, at which point this fires.
#[test]
fn mapped_item_depth_is_the_shared_constant() {
    assert_eq!(
        super::MAX_MAPPED_ITEM_DEPTH,
        ifc_lite_core::MAX_MAPPED_ITEM_DEPTH,
        "use the shared cap from ifc_lite_core::limits, not a private copy"
    );
}
