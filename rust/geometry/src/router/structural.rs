// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Structural analysis element representations (#4206). Deliberately
//! not folded into [`super::rep_filter::is_body_representation`]: an
//! `IfcStructuralCurveMember`'s `'Edge'` and an `IfcStructuralSurfaceMember`'s
//! `'Face'` representation are reference topology, not body geometry, and
//! must not become eligible for RTC-offset sampling, void probing, or
//! material-layer slicing (see that function's
//! doc comment for why those three share one gate). Mirrors
//! `super::annotation::accepts`, the same OR-escape-hatch pattern used for
//! `IfcAnnotation` fills.

use ifc_lite_core::{DecodedEntity, IfcType};

/// Whether `element`'s `rep_type` should be meshed as structural reference
/// topology.
///
/// Accepts `IfcStructuralCurveMember` (including its varying subtype) with
/// representation type `'Edge'`, and `IfcStructuralSurfaceMember` with
/// representation type `'Face'`. Point and surface connections remain out of
/// scope.
pub(super) fn accepts(element: &DecodedEntity, rep_type: &str) -> bool {
    (element
        .ifc_type
        .is_subtype_of(IfcType::IfcStructuralCurveMember)
        && rep_type == "Edge")
        || (element
            .ifc_type
            .is_subtype_of(IfcType::IfcStructuralSurfaceMember)
            && rep_type == "Face")
}
