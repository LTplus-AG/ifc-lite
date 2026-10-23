// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Ordered layer stages: lazy eligibility, actual voided host, late frame,
//! then slicing. Each stage owns its parameters and geometry; source services
//! are touched only where a stage takes the decoder.
use super::stack::{merge_thin_layers, VisualLayer};
use super::{planes, slice, source};
use crate::material_layer_index::{LayerAxis, LayerBuildup};
use crate::{GeometryRouter, Mesh, SubMeshCollection};
use ifc_lite_core::{DecodedEntity, EntityDecoder};

/// Admitted layer parameters. Nothing has touched the host yet.
pub(crate) struct LayerProgram {
    layers: Vec<VisualLayer>,
    axis: LayerAxis,
    direction_sense: f64,
    offset: f64,
}

/// Why a sliceable element keeps its single solid; `reason` is the recorded
/// diagnostic string.
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
    /// Eligibility, evaluated before any host callback runs. `Ok(None)` means
    /// the buildup is not sliceable at all (no diagnostic).
    pub(crate) fn admit(
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
        buildup: &LayerBuildup,
        unit_scale: f64,
    ) -> Result<Option<Self>, LayerSkip> {
        let LayerBuildup::Sliceable {
            layers,
            axis,
            direction_sense,
            offset_from_reference_line,
        } = buildup
        else {
            return Ok(None);
        };
        if layers.len() < 2 {
            return Err(LayerSkip::TooFewLayers);
        }
        // Layer planes are built from the element placement alone, so the
        // representation must be one item with identity Position.
        if !source::element_is_single_unshifted_item(element, decoder) {
            return Err(LayerSkip::ShiftedOrMultipleItems);
        }
        // Merge sub-mm layers before any geometry work so planes never sit on
        // degenerate interfaces.
        let layers = merge_thin_layers(layers, unit_scale);
        if layers.len() < 2 {
            return Err(LayerSkip::ThinLayersCollapsed);
        }
        Ok(Some(Self {
            layers,
            axis: *axis,
            direction_sense: *direction_sense,
            offset: *offset_from_reference_line,
        }))
    }

    /// Take ownership of the actual (opening-cut) host. An empty host skips.
    pub(crate) fn accept_host(self, host: Mesh) -> Result<LayerPlaneRequest, LayerSkip> {
        if host.is_empty() {
            return Err(LayerSkip::EmptyHost);
        }
        Ok(LayerPlaneRequest {
            program: self,
            host,
        })
    }
}

/// Exists only after the original host succeeded and is nonempty. It owns the
/// host, whose origin determines the layer frame.
pub(crate) struct LayerPlaneRequest {
    program: LayerProgram,
    host: Mesh,
}

impl LayerPlaneRequest {
    /// Placement admission happens only after the host, so a host callback
    /// that updates the decoder is observed rather than a stale read.
    pub(crate) fn admit_frame(
        self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
        router: &GeometryRouter,
    ) -> Result<ReadyLayerPlanes, LayerSkip> {
        let frame =
            source::admit_frame(element, decoder, router).ok_or(LayerSkip::PlacementUnresolved)?;
        Ok(ReadyLayerPlanes {
            request: self,
            frame,
        })
    }
}

pub(crate) struct ReadyLayerPlanes {
    request: LayerPlaneRequest,
    frame: planes::LayerFrame,
}

impl ReadyLayerPlanes {
    /// Decoder-free: evaluate the interface planes in the host's mesh frame.
    pub(crate) fn execute(self) -> Result<ReadyLayerSlice, LayerSkip> {
        let LayerPlaneRequest { program, host } = self.request;
        let planes = self
            .frame
            .evaluate(
                &program.layers,
                program.axis,
                program.direction_sense,
                program.offset,
                host.origin,
            )
            .ok_or(LayerSkip::PlacementUnresolved)?;
        if planes.is_empty() {
            return Err(LayerSkip::NoPlanes);
        }
        Ok(ReadyLayerSlice {
            host,
            layers: program.layers,
            planes,
        })
    }
}

/// Complete numerical input; no decoder or router is retained.
pub(crate) struct ReadyLayerSlice {
    host: Mesh,
    layers: Vec<VisualLayer>,
    pub(super) planes: Vec<crate::csg::Plane>,
}

impl ReadyLayerSlice {
    pub(crate) fn execute(self) -> LayerSliceResult {
        LayerSliceResult {
            collection: slice::slice_mesh_into_layers(&self.host, &self.layers, &self.planes),
        }
    }
}

/// Unpublished result; the diagnostic is recorded only by `publish`.
pub(crate) struct LayerSliceResult {
    collection: SubMeshCollection,
}

impl LayerSliceResult {
    pub(crate) fn publish(self, router: &GeometryRouter, element_id: u32) -> SubMeshCollection {
        router.push_layer_slice_diag(
            element_id,
            if self.collection.sub_meshes.len() >= 2 {
                "ok:sliced"
            } else {
                "skip:cut-produced-<2"
            },
        );
        self.collection
    }
}
