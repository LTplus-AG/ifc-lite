// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The router's view of the `IfcObjectPlacement` chain. The walk itself is
//! [`crate::placement::resolve_chain`]: iterative, visited-set bounded and
//! memoised per decoder; this only maps its errors into the router's.

use super::super::GeometryRouter;
use crate::placement;
use crate::Result;
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use nalgebra::Matrix4;

impl GeometryRouter {
    /// The unscaled world transform of `placement` (file units).
    pub(super) fn get_placement_transform(
        &self,
        placement: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Matrix4<f64>> {
        Ok(placement::resolve_chain(placement, decoder)?)
    }
}
