// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Material-layer slicing.
//!
//! Produces one sub-mesh per [`LayerInfo`][crate::LayerInfo] for elements
//! whose geometry is a single swept solid but whose buildup is described by
//! an `IfcMaterialLayerSetUsage`. The sub-mesh `geometry_id` is set to the
//! layer's `IfcMaterial` entity ID so the styling layer can resolve colour
//! through the existing material-style index.
//!
//! Flow (the common program's layer control, `program/layers.rs`):
//!   1. Admit the buildup, then build the host through the canonical void
//!      program ([`GeometryRouter::process_element_with_voids`]). Subtracting
//!      voids FIRST and slicing AFTER is cheaper than slicing first and
//!      subtracting per-slab: layer planes don't affect opening topology.
//!   2. Transform each layer-interface plane from the element's local frame
//!      into the same world-RTC frame the mesh lives in.
//!   3. Cut the base mesh into N slabs with N-1 planes using the shared
//!      [`ClippingProcessor`][crate::csg::ClippingProcessor].

mod planes;
mod slice;
mod source;
mod stack;
mod stages;

use super::GeometryRouter;
use crate::material_layer_index::LayerBuildup;
use crate::{Result, SubMeshCollection};
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use rustc_hash::FxHashMap;
pub(crate) use stages::{
    LayerPlaneRequest, LayerProgram, LayerSkip, LayerSliceResult, ReadyLayerPlanes, ReadyLayerSlice,
};

impl GeometryRouter {
    /// Process an element into per-layer sub-meshes, subtracting any
    /// openings first.
    ///
    /// Returns `Ok(None)` when the buildup isn't sliceable (single material,
    /// constituent set, profile set, degenerate) so the caller can fall back
    /// to the existing sub-mesh-voids path without duplicating work.
    ///
    /// Each emitted [`SubMesh`][crate::SubMesh] carries the layer's
    /// `IfcMaterial` entity ID as its `geometry_id` — callers key colour
    /// lookup on that.
    pub fn process_element_with_material_layers(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
        buildup: &LayerBuildup,
        void_index: &FxHashMap<u32, Vec<u32>>,
    ) -> Result<Option<SubMeshCollection>> {
        let ids = void_index.get(&element.id).map(Vec::as_slice).unwrap_or_default();
        crate::program::GeometryProgram::material_layers(element, buildup, ids).drain_layers(self, decoder)
    }
}

#[cfg(test)]
#[path = "layers_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "layers_cycle_tests.rs"]
mod layers_cycle_tests;

#[cfg(test)]
mod boundary_tests;
#[cfg(test)]
mod geometry_tests;
