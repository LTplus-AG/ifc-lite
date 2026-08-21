// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Bounds on walks over file-supplied entity references.
//!
//! A cap bounds one path's LENGTH only. A walk that can revisit also needs a
//! cycle guard, and one that fans out over a DAG also needs a work budget; the
//! three are not interchangeable and choosing wrongly fails silently in both
//! directions. The rule for picking, and the scope rule for the visited set,
//! are in AGENTS.md under "Bounding walks over file-supplied references" —
//! there rather than here, because whoever needs it is adding a NEW walk
//! somewhere else and will not open this file.

/// Maximum `IfcMappedItem` → `IfcRepresentationMap` → `MappedRepresentation.Items`
/// nesting any walk in this workspace will follow.
///
/// Shared because three crates walk the SAME chain and their bounds must agree:
/// `ifc_lite_processing::element`, `ifc_lite_geometry::router::processing` and
/// `ifc-lite-wasm`'s styling colour resolver.
///
/// Disagreement fails SILENTLY, which is why it is worth making structural. A
/// mid-review revision of #2864 held 16 against the router's 32: an element
/// whose chain was 17 to 32 links long would have rendered its geometry and
/// quietly lost its authored colour. That was caught before merge and never
/// shipped — the point is that nothing except a reviewer's attention was
/// stopping it.
///
/// `ifc_lite_processing::symbolic::item_walk::MAX_ITEM_DEPTH` also walks this
/// chain and asserts equality with this constant, but deliberately keeps its
/// own name: it charges `depth + 1` for `IfcGeometricSet` elements and
/// `IfcCompositeCurve` segments as well, so an equal number does not mean equal
/// reach. It is never more permissive than this one.
///
/// A walk over this chain also needs a cycle guard; the cap alone is not
/// sufficient (see the module docs above for which kind).
pub const MAX_MAPPED_ITEM_DEPTH: u32 = 32;

#[cfg(test)]
mod tests {
    use super::*;

    /// The documented contract. This pins the VALUE; the constant being shared
    /// is what pins agreement between the three walks, and that is now
    /// structural rather than asserted.
    #[test]
    fn mapped_item_depth_is_the_documented_32() {
        assert_eq!(MAX_MAPPED_ITEM_DEPTH, 32);
    }
}
