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
//! Flow:
//!   1. Build the base mesh via [`GeometryRouter::process_element_with_voids`].
//!      Subtracting voids FIRST and slicing AFTER is cheaper than slicing first
//!      and subtracting per-slab: layer planes don't affect opening topology.
//!   2. Transform each layer-interface plane from the element's local frame
//!      into the same world-RTC frame the mesh lives in.
//!   3. Cut the base mesh into N slabs with N-1 planes using the shared
//!      [`ClippingProcessor`][crate::csg::ClippingProcessor].

use super::GeometryRouter;
use crate::csg::{ClippingProcessor, Plane};
use crate::material_layer_index::{LayerAxis, LayerBuildup, LayerInfo};
use crate::mesh::{SubMesh, SubMeshCollection};
use crate::{Mesh, Point3, Result, Vector3};
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use rustc_hash::FxHashMap;

/// Minimum layer thickness (in meters) below which slicing is skipped for
/// that interface. Sub-millimetre layers (vapor barriers etc.) destabilise
/// the triangle clipper and aren't visible at typical render scales.
const MIN_SLICEABLE_THICKNESS_M: f64 = 0.002;

impl GeometryRouter {
    /// Helper that consults the attached [`MaterialLayerIndex`][crate::MaterialLayerIndex]
    /// (if any) and returns per-layer sub-meshes for elements whose buildup
    /// is sliceable. Used internally by `process_element_with_submeshes` and
    /// `process_element_with_submeshes_and_voids` — with `void_index = None`
    /// the sliced mesh is built without void subtraction.
    ///
    /// Returns `None` when the router has no layer index, the element has no
    /// recorded buildup, the buildup is not sliceable, or slicing produced
    /// fewer than two non-empty sub-meshes (in which case callers should
    /// fall through to their single-mesh / multi-item paths).
    pub(crate) fn try_layered_sub_meshes(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
        void_index: Option<&FxHashMap<u32, Vec<u32>>>,
    ) -> Option<SubMeshCollection> {
        let index = self.material_layer_index()?;
        let buildup = index.get(element.id)?;
        if !buildup.is_sliceable() {
            return None;
        }
        let empty: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
        let voids = void_index.unwrap_or(&empty);
        let collection = self
            .process_element_with_material_layers(element, decoder, buildup, voids)
            .ok()
            .flatten()?;
        if collection.sub_meshes.len() < 2 {
            return None;
        }
        Some(collection)
    }

    /// Process an element into per-layer sub-meshes, subtracting any
    /// openings first.
    ///
    /// Returns `Ok(None)` when the buildup isn't sliceable (single material,
    /// constituent set, profile set, degenerate) so the caller can fall back
    /// to the existing sub-mesh-voids path without duplicating work.
    ///
    /// Each emitted [`SubMesh`] carries the layer's `IfcMaterial` entity ID
    /// as its `geometry_id` — callers key colour lookup on that.
    pub fn process_element_with_material_layers(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
        buildup: &LayerBuildup,
        void_index: &FxHashMap<u32, Vec<u32>>,
    ) -> Result<Option<SubMeshCollection>> {
        let (layers, axis, direction_sense, offset) = match buildup {
            LayerBuildup::Sliceable {
                layers,
                axis,
                direction_sense,
                offset_from_reference_line,
            } => (layers, *axis, *direction_sense, *offset_from_reference_line),
            LayerBuildup::NotSliceable => return Ok(None),
        };

        if layers.len() < 2 {
            return Ok(None);
        }

        // Void subtraction happens on the merged mesh (cheap + topology-safe).
        let base_mesh = self.process_element_with_voids(element, decoder, void_index)?;
        if base_mesh.is_empty() {
            return Ok(None);
        }

        // Build the interface planes in world-RTC coordinates. Returns None
        // when we can't resolve the element's placement — fall back.
        let planes = match self.build_layer_planes(
            element,
            decoder,
            &layers,
            axis,
            direction_sense,
            offset,
        ) {
            Some(p) => p,
            None => return Ok(None),
        };
        if planes.is_empty() {
            // Single visible layer after thin-layer filtering — fall back.
            return Ok(None);
        }

        Ok(Some(slice_mesh_into_layers(&base_mesh, &layers, &planes)))
    }

    /// Convert layer thicknesses + axis/offset into N-1 world-space planes
    /// aligned with the layer interfaces.
    ///
    /// All plane normals point in the `direction_sense` direction so
    /// slicing logic is uniform: "keep front of plane i" = "beyond interface
    /// i, deeper into the stack".
    fn build_layer_planes(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
        layers: &[LayerInfo],
        axis: LayerAxis,
        direction_sense: f64,
        offset: f64,
    ) -> Option<Vec<Plane>> {
        // Use the same placement the mesh was built with: placement ×
        // scale_transform (scales translation only).
        let mut placement = self.get_placement_transform_from_element(element, decoder).ok()?;
        self.scale_transform(&mut placement);

        let scale = self.unit_scale;
        let rtc = self.rtc_offset;

        // Axis unit vector in local coordinates.
        let axis_local = {
            let v = axis.unit_vector();
            Vector3::new(v[0], v[1], v[2])
        };

        // World-space normal (rotation only; translation irrelevant for directions).
        // Direction sense flips the normal so "front" always means "deeper
        // into the layer stack".
        let rotation = placement.fixed_view::<3, 3>(0, 0);
        let world_normal = (rotation * axis_local)
            .try_normalize(1e-12)?
            * direction_sense;

        let offset_m = offset * scale;

        let mut planes = Vec::with_capacity(layers.len().saturating_sub(1));
        let mut cumulative_m = 0.0_f64;
        for (i, layer) in layers.iter().enumerate() {
            let thickness_m = layer.thickness * scale;
            cumulative_m += thickness_m;
            // Skip the last layer — there are only N-1 interfaces.
            if i + 1 == layers.len() {
                break;
            }
            // Guard against sub-mm layers triggering degenerate slicing.
            let next_thickness_m = layers[i + 1].thickness * scale;
            if thickness_m < MIN_SLICEABLE_THICKNESS_M
                || next_thickness_m < MIN_SLICEABLE_THICKNESS_M
            {
                // Record a plane anyway so indexing stays 1:1 with layers,
                // but flag it by using a zero normal — slicer will skip.
                planes.push(Plane::new(Point3::origin(), Vector3::zeros()));
                continue;
            }

            // Distance from reference line along the axis, in meters.
            let d = offset_m + direction_sense * cumulative_m;
            // Local-frame plane origin: the axis scaled to distance `d`.
            let local_origin = Point3::new(
                axis_local.x * d,
                axis_local.y * d,
                axis_local.z * d,
            );
            // Transform to world, then subtract RTC offset so the plane sits
            // in the same frame as the mesh (which already had RTC applied).
            let world_origin = placement.transform_point(&local_origin);
            let rtc_origin = Point3::new(
                world_origin.x - rtc.0,
                world_origin.y - rtc.1,
                world_origin.z - rtc.2,
            );
            planes.push(Plane::new(rtc_origin, world_normal));
        }

        Some(planes)
    }
}

/// Cut `mesh` into one slab per layer using the pre-computed interface
/// planes. Returns a [`SubMeshCollection`] where each entry's
/// `geometry_id` is the corresponding layer's `material_id` (0 if the
/// layer was an air gap / had no associated material).
///
/// Empty slabs (plane missed the mesh, or clipper returned nothing) are
/// dropped — callers should treat an empty result as "fall back to
/// unsliced mesh".
fn slice_mesh_into_layers(
    mesh: &Mesh,
    layers: &[LayerInfo],
    planes: &[Plane],
) -> SubMeshCollection {
    debug_assert_eq!(planes.len() + 1, layers.len());

    let clipper = ClippingProcessor::new();
    let mut out = SubMeshCollection::new();

    for (i, layer) in layers.iter().enumerate() {
        // Build the slab by intersecting "after previous plane" with
        // "before next plane".
        let after_prev: Option<&Plane> = if i == 0 { None } else { planes.get(i - 1) };
        let before_next: Option<&Plane> = if i + 1 == layers.len() {
            None
        } else {
            planes.get(i)
        };

        // Clone only when we actually need to clip (common case is two clips
        // per middle layer, one per boundary for the end layers).
        let mut slab = if after_prev.is_some() || before_next.is_some() {
            mesh.clone()
        } else {
            // No interfaces — single-layer buildup shouldn't reach here but
            // be defensive.
            mesh.clone()
        };

        if let Some(plane) = after_prev {
            if !is_degenerate_plane(plane) {
                if let Ok(clipped) = clipper.clip_mesh(&slab, plane) {
                    slab = clipped;
                }
            }
        }
        if let Some(plane) = before_next {
            if !is_degenerate_plane(plane) {
                // Flip the normal to keep the "before" side of the interface.
                let flipped = Plane::new(plane.point, -plane.normal);
                if let Ok(clipped) = clipper.clip_mesh(&slab, &flipped) {
                    slab = clipped;
                }
            }
        }

        if !slab.is_empty() {
            out.sub_meshes.push(SubMesh::new(layer.material_id, slab));
        }
    }

    out
}

#[inline]
fn is_degenerate_plane(plane: &Plane) -> bool {
    let n = plane.normal;
    n.x.abs() + n.y.abs() + n.z.abs() < 1e-9
}
