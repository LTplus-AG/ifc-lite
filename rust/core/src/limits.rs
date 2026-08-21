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

/// Maximum `IfcLocalPlacement.PlacementRelTo` chain any walk in this workspace
/// will follow. A chain longer than this composes only its first
/// `MAX_PLACEMENT_DEPTH + 1` placements and the rest is dropped — silently, on
/// every site that uses it.
///
/// Shared because two walks follow the SAME attribute of the SAME entity and
/// their bounds must agree: `ifc_lite_geometry::router::transforms` (the mesh
/// path) and `ifc_lite_geometry::profile_extractor` (the 2D drawing path).
/// They disagreed — 32 against 100 — and because both exceed-branches return
/// the IDENTITY rather than an error, an element on a 33-to-101-link chain was
/// drawn in two different places by the two paths with nothing reported. #2873
///
/// ## Why 100 and not 32
///
/// The 32 carried the rationale "keep low for WASM — each frame uses ~2KB+ of
/// stack". The wasm bundles are linked with `-zstack-size=8388608`
/// (`.cargo/config.toml` and both extra bundles in `scripts/build-wasm.sh`), so
/// the budget is 8 MiB and the cap's own worst case is ~0.1% of it; native
/// hosts give the geometry pool 256 MiB (`rust/ffi`, `rust/python`). Measured
/// rather than assumed: see the frame figures in #2873. `PlacementRelTo` is a
/// single reference, so this walk has fan-out 1 and costs O(depth) — the
/// breadth blow-up that makes a depth cap the wrong instrument elsewhere (see
/// AGENTS.md) does not apply here.
///
/// The two candidates are not symmetric. Equalising UP lets the mesh path
/// compose chains it currently flattens; equalising DOWN would make the 2D path
/// start flattening chains it composes correctly today, silently. Across the
/// 111 fixtures in `tests/models` that contain placements the deepest chain is
/// 7 links, so neither value binds on any file in the corpus and the choice is
/// decided entirely by which failure is worse on a file that does exceed it.
///
/// This bounds one path's LENGTH only. A walk over a chain that can revisit
/// also needs a cycle guard; see the module docs above.
pub const MAX_PLACEMENT_DEPTH: usize = 100;

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

    /// The documented contract, pinned separately from the two sites that
    /// import it — those assert they ARE this constant, which cannot also pin
    /// its value.
    #[test]
    fn placement_depth_is_the_documented_100() {
        assert_eq!(MAX_PLACEMENT_DEPTH, 100);
    }
}
