// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Conservative, geometry-free routing for documented Reference openings.
use crate::GeometryRouter;
use ifc_lite_core::EntityDecoder;

impl GeometryRouter {
    /// Whether an opening must retain the canonical cutter path. Only a proven
    /// Reference-only opening (optionally with BoundingBox) returns false.
    /// Unknown, malformed, empty and over-budget representation data returns true
    /// so ordinary cutter/error handling remains authoritative (#4440).
    pub fn opening_requires_subtraction(&self, id:u32, decoder:&mut EntityDecoder<'_>)->bool {
        crate::representation::reference_only_opening(id, decoder) != Some(true)
    }
}
