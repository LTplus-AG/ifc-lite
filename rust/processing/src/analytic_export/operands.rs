// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! IFC select membership for CSG references at the analytic boundary.

use ifc_lite_core::IfcType;

pub(super) fn is_boolean_operand(kind: &IfcType) -> bool {
    [
        IfcType::IfcBooleanResult,
        IfcType::IfcCsgPrimitive3D,
        IfcType::IfcHalfSpaceSolid,
        IfcType::IfcSolidModel,
        IfcType::IfcTessellatedFaceSet,
    ]
    .into_iter()
    .any(|base| kind.is_subtype_of(base))
}

pub(super) fn is_csg_select(kind: &IfcType) -> bool {
    [IfcType::IfcBooleanResult, IfcType::IfcCsgPrimitive3D]
        .into_iter()
        .any(|base| kind.is_subtype_of(base))
}
