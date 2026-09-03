// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! [`SkippedProfile`] — split out of `profile_extractor.rs` to keep that
//! module under its size ratchet.
//!
//! It is the production-reaching counterpart of the `diag_debug!` trace at
//! each profile-extraction drop site in `profile_extractor.rs`: those macros
//! compile to nothing unless the crate is built with `debug_geometry` or
//! `observability` (neither is a default feature, and the shipped wasm build
//! enables neither — see `scripts/build-wasm.sh`), so without this struct a
//! real extraction failure was invisible end to end.

/// A building element whose construction-projection profile was dropped —
/// its `IfcExtrudedAreaSolid` (direct or via `IfcMappedItem`) is present but
/// could not be turned into 2D drawing geometry, or the mapped-item chain
/// was too deep. Never an element the extractor deliberately excludes (a
/// non-`IfcExtrudedAreaSolid` representation, an `IfcFeatureElement`).
#[derive(Debug, Clone)]
pub struct SkippedProfile {
    /// Express ID of the building element whose profile was dropped.
    pub express_id: u32,
    /// IFC type name (e.g., `"IfcWall"`).
    pub ifc_type: String,
    /// Short, stable reason string (not user-facing prose): the geometry
    /// error text, or `"max mapped item depth exceeded"`.
    pub reason: String,
}
