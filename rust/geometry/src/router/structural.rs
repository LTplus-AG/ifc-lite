// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Structural analysis element representations (#4206 layer 4). Deliberately
//! not folded into [`super::rep_filter::is_body_representation`]: an
//! `IfcStructuralCurveMember`'s `'Edge'` representation is a topological
//! curve, not a body/surface, and must not become eligible for RTC-offset
//! sampling, void probing, or material-layer slicing (see that function's
//! doc comment for why those three share one gate). Mirrors
//! `super::annotation::accepts`, the same OR-escape-hatch pattern used for
//! `IfcAnnotation` fills.

use ifc_lite_core::{DecodedEntity, IfcType};

/// Whether `element`'s `rep_type` should be meshed as a structural curve
/// member's edge geometry.
///
/// Only `IfcStructuralCurveMember` (and its `IfcStructuralCurveMemberVarying`
/// subtype) with representation type `'Edge'` are accepted. The fixture that
/// motivated this (`tests/models/ifcopenshell/structural_analysis_curve.ifc`)
/// also carries `'Vertex'`-typed `IfcTopologyRepresentation`s, but those
/// belong to `IfcStructuralPointConnection`, a different element that never
/// reaches this predicate with a curve member — so `'Vertex'` is
/// intentionally NOT accepted here; point-connection geometry is out of
/// scope for this PR.
pub(super) fn accepts(element: &DecodedEntity, rep_type: &str) -> bool {
    element
        .ifc_type
        .is_subtype_of(IfcType::IfcStructuralCurveMember)
        && rep_type == "Edge"
}
