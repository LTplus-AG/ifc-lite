// SPDX-License-Identifier: MPL-2.0
//! Ordered layer child: eligibility, actual voided host, late frame, then slicing.
//! Suspended values own parameters/geometry; source services are lexical only.
mod planes;
mod slice;
mod source;
mod stack;

use crate::material_layer_index::{LayerAxis, LayerBuildup};
use crate::{GeometryRouter, Mesh, Result, SubMeshCollection};
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use stack::{merge_thin_layers, VisualLayer};

pub(crate) struct LayerProgram {
    layers: Vec<VisualLayer>,
    axis: LayerAxis,
    direction_sense: f64,
    offset: f64,
}

pub(crate) enum LayerSkip {
    TooFewLayers,
    ShiftedOrMultipleItems,
    ThinLayersCollapsed,
    EmptyHost,
    PlacementUnresolved,
    NoPlanes,
}
impl LayerSkip {
    pub(crate) fn reason(&self) -> &'static str {
        match self {
            Self::TooFewLayers => "skip:fewer-than-2-layers",
            Self::ShiftedOrMultipleItems => "skip:not-single-unshifted-item",
            Self::ThinLayersCollapsed => "skip:thin-layers-collapsed-to-1",
            Self::EmptyHost => "skip:empty-base-mesh",
            Self::PlacementUnresolved => "skip:placement-unresolved",
            Self::NoPlanes => "skip:no-interface-planes",
        }
    }
}

impl LayerProgram {
    pub(crate) fn admit(element: &DecodedEntity, decoder: &mut EntityDecoder,
        buildup: &LayerBuildup, unit_scale: f64) -> std::result::Result<Option<Self>, LayerSkip> {
        let LayerBuildup::Sliceable { layers, axis, direction_sense,
            offset_from_reference_line } = buildup else { return Ok(None) };
        if layers.len() < 2 { return Err(LayerSkip::TooFewLayers) }
        if !source::element_is_single_unshifted_item(element, decoder) {
            return Err(LayerSkip::ShiftedOrMultipleItems);
        }
        let layers = merge_thin_layers(layers, unit_scale);
        if layers.len() < 2 { return Err(LayerSkip::ThinLayersCollapsed) }
        Ok(Some(Self { layers, axis: *axis, direction_sense: *direction_sense,
            offset: *offset_from_reference_line }))
    }

    pub(crate) fn accept_host(self, host: Mesh) -> std::result::Result<LayerPlaneRequest, LayerSkip> {
        if host.is_empty() { return Err(LayerSkip::EmptyHost) }
        Ok(LayerPlaneRequest { program: self, host })
    }
}

/// This continuation exists only after the original host (including openings)
/// succeeds. It owns that host, so neither a source retry nor a second execution
/// can accidentally replace the mesh whose origin determines the layer frame.
pub(crate) struct LayerPlaneRequest { program: LayerProgram, host: Mesh }
impl LayerPlaneRequest {
    /// This source admission is deliberately impossible before accept_host's
    /// successful nonempty gate. Capturing it earlier observes stale placement
    /// when a selected host callback mutates the decoder.
    pub(crate) fn admit_frame(self, element: &DecodedEntity, decoder: &mut EntityDecoder,
        router: &GeometryRouter) -> Result<std::result::Result<ReadyLayerPlanes, LayerSkip>> {
        crate::resource::check_current()?;
        let frame = source::admit_frame(element, decoder, router)?;
        crate::resource::check_current()?;
        Ok(frame.ok_or(LayerSkip::PlacementUnresolved)
            .map(|frame| ReadyLayerPlanes { request: self, frame }))
    }
}

pub(crate) struct ReadyLayerPlanes { request: LayerPlaneRequest, frame: planes::LayerFrame }
impl ReadyLayerPlanes {
    pub(crate) fn execute(self) -> std::result::Result<ReadyLayerSlice, LayerSkip> {
        let LayerPlaneRequest { program, host } = self.request;
        let planes = self.frame.evaluate(&program.layers, program.axis,
            program.direction_sense, program.offset, host.origin)
            .ok_or(LayerSkip::PlacementUnresolved)?;
        if planes.is_empty() { return Err(LayerSkip::NoPlanes) }
        Ok(ReadyLayerSlice { host, layers: program.layers, planes })
    }
}

/// Complete numerical input. No decoder/router or source callback is retained.
pub(crate) struct ReadyLayerSlice {
    host: Mesh,
    layers: Vec<VisualLayer>,
    planes: Vec<crate::csg::Plane>,
}
impl ReadyLayerSlice {
    pub(crate) fn execute(self) -> LayerSliceResult {
        LayerSliceResult { collection: slice::slice_mesh_into_layers(
            &self.host, &self.layers, &self.planes) }
    }
}

/// Numerical effects remain owned by the reply until authenticated acceptance.
pub(crate) struct LayerSliceResult { collection: SubMeshCollection }
impl LayerSliceResult {
    pub(crate) fn publish(self, router: &GeometryRouter, element_id: u32) -> Result<SubMeshCollection> {
        crate::resource::check_current()?;
        router.push_layer_slice_diag(element_id, if self.collection.sub_meshes.len() >= 2 {
            "ok:sliced"
        } else { "skip:cut-produced-<2" });
        Ok(self.collection)
    }
}


#[cfg(test)]
mod stack_tests;
#[cfg(test)]
mod source_tests;
#[cfg(test)]
mod geometry_tests;
#[cfg(test)]
mod boundary_tests;
