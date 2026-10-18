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
use rustc_hash::FxHashMap;
use stack::{merge_thin_layers, VisualLayer};

struct LayerProgram {
    layers: Vec<VisualLayer>,
    axis: LayerAxis,
    direction_sense: f64,
    offset: f64,
}

enum LayerSkip {
    TooFewLayers,
    ShiftedOrMultipleItems,
    ThinLayersCollapsed,
    EmptyHost,
    PlacementUnresolved,
    NoPlanes,
}
impl LayerSkip {
    fn reason(&self) -> &'static str {
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
    fn admit(element: &DecodedEntity, decoder: &mut EntityDecoder,
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

    fn accept_host(self, host: Mesh) -> std::result::Result<LayerPlaneRequest, LayerSkip> {
        if host.is_empty() { return Err(LayerSkip::EmptyHost) }
        Ok(LayerPlaneRequest { program: self, host })
    }
}

/// This continuation exists only after the original host (including openings)
/// succeeds. It owns that host, so neither a source retry nor a second execution
/// can accidentally replace the mesh whose origin determines the layer frame.
struct LayerPlaneRequest { program: LayerProgram, host: Mesh }
impl LayerPlaneRequest {
    fn accept_frame(self, frame: planes::LayerFrame)
        -> std::result::Result<ReadyLayerSlice, LayerSkip> {
        let planes = frame.evaluate(&self.program.layers, self.program.axis,
            self.program.direction_sense, self.program.offset, self.host.origin)
            .ok_or(LayerSkip::PlacementUnresolved)?;
        if planes.is_empty() { return Err(LayerSkip::NoPlanes) }
        Ok(ReadyLayerSlice { host: self.host, layers: self.program.layers, planes })
    }
}

/// Complete numerical input. No decoder/router or source callback is retained.
struct ReadyLayerSlice {
    host: Mesh,
    layers: Vec<VisualLayer>,
    planes: Vec<crate::csg::Plane>,
}
impl ReadyLayerSlice {
    fn evaluate(self) -> SubMeshCollection {
        slice::slice_mesh_into_layers(&self.host, &self.layers, &self.planes)
    }
}

/// Public borrowed methods and canonical product callers drive the same child.
/// Geometry callbacks run before frame admission; do not hoist placement lookup.
pub(crate) fn drive(router: &GeometryRouter, element: &DecodedEntity,
    decoder: &mut EntityDecoder, buildup: &LayerBuildup,
    void_index: &FxHashMap<u32, Vec<u32>>) -> Result<Option<SubMeshCollection>> {
    let program = match LayerProgram::admit(element, decoder, buildup, router.unit_scale()) {
        Ok(Some(program)) => program,
        Ok(None) => return Ok(None),
        Err(skip) => { router.push_layer_slice_diag(element.id, skip.reason()); return Ok(None) }
    };
    let host = router.process_element_with_voids(element, decoder, void_index)?;
    let request = match program.accept_host(host) {
        Ok(request) => request,
        Err(skip) => { router.push_layer_slice_diag(element.id, skip.reason()); return Ok(None) }
    };
    let ready = source::admit_frame(element, decoder, router)
        .ok_or(LayerSkip::PlacementUnresolved)
        .and_then(|frame| request.accept_frame(frame));
    let ready = match ready {
        Ok(ready) => ready,
        Err(skip) => { router.push_layer_slice_diag(element.id, skip.reason()); return Ok(None) }
    };
    let collection = ready.evaluate();
    router.push_layer_slice_diag(element.id,
        if collection.sub_meshes.len() >= 2 { "ok:sliced" } else { "skip:cut-produced-<2" });
    Ok(Some(collection))
}

#[cfg(test)]
mod stack_tests;
#[cfg(test)]
mod source_tests;
#[cfg(test)]
mod geometry_tests;
