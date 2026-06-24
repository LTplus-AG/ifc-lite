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
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use nalgebra::Matrix4;
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
        let collection = match self.process_element_with_material_layers(element, decoder, buildup, voids) {
            Ok(Some(c)) => c,
            Ok(None) => return None,
            Err(_e) => {
                // A sliceable wall whose base-mesh build errored falls back to a
                // single solid. Record for the browser; eprintln for native.
                self.push_layer_slice_diag(element.id, "skip:base-mesh-error");
                eprintln!("[material-layers] #{}: sliceable but slicing errored", element.id);
                return None;
            }
        };
        if collection.sub_meshes.len() < 2 {
            eprintln!(
                "[material-layers] #{}: sliceable but produced {} sub-mesh(es) (<2) — keeping single solid",
                element.id,
                collection.sub_meshes.len()
            );
            return None;
        }
        eprintln!(
            "[material-layers] #{}: sliced into {} layer sub-meshes",
            element.id,
            collection.sub_meshes.len()
        );
        // Mesh hygiene: slicing the base mesh by layer-interface planes can
        // introduce zero-area/collinear slivers at the cut, and this layered
        // path early-returns to its callers (process_element_with_submeshes /
        // _and_voids) BEFORE their own cleanup loop runs — so clean here, the
        // single gateway both layered call sites share. See clean_degenerate.
        let mut collection = collection;
        for sub in &mut collection.sub_meshes {
            sub.mesh.clean_degenerate();
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
            self.push_layer_slice_diag(element.id, "skip:fewer-than-2-layers");
            return Ok(None);
        }

        // Bail when the representation isn't a single item with identity
        // Position — otherwise layer planes (built from element placement
        // only) would be in a different frame than the mesh. Callers fall
        // through to the unsliced path in that case.
        if !element_is_single_unshifted_item(element, decoder) {
            self.push_layer_slice_diag(element.id, "skip:not-single-unshifted-item");
            return Ok(None);
        }

        // Merge sub-mm layers into their thick neighbours before any
        // geometry work so cutting planes never sit on degenerate
        // interfaces. When everything collapses to one visual layer there
        // is nothing to slice.
        let visual_layers = merge_thin_layers(layers, self.unit_scale);
        if visual_layers.len() < 2 {
            self.push_layer_slice_diag(element.id, "skip:thin-layers-collapsed-to-1");
            return Ok(None);
        }

        // Void subtraction happens on the merged mesh (cheap + topology-safe).
        let base_mesh = self.process_element_with_voids(element, decoder, void_index)?;
        if base_mesh.is_empty() {
            self.push_layer_slice_diag(element.id, "skip:empty-base-mesh");
            return Ok(None);
        }

        // Build the interface planes in the SAME frame as `base_mesh` (world −
        // rtc − per-element local origin). Returns None when we can't resolve the
        // element's placement — fall back.
        let planes = match self.build_layer_planes(
            element,
            decoder,
            &visual_layers,
            axis,
            direction_sense,
            offset,
            base_mesh.origin,
        ) {
            Some(p) => p,
            None => {
                self.push_layer_slice_diag(element.id, "skip:placement-unresolved");
                return Ok(None);
            }
        };
        if planes.is_empty() {
            self.push_layer_slice_diag(element.id, "skip:no-interface-planes");
            return Ok(None);
        }

        let collection = slice_mesh_into_layers(&base_mesh, &visual_layers, &planes);
        self.push_layer_slice_diag(
            element.id,
            if collection.sub_meshes.len() >= 2 { "ok:sliced" } else { "skip:cut-produced-<2" },
        );
        Ok(Some(collection))
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
        visual_layers: &[VisualLayer],
        axis: LayerAxis,
        direction_sense: f64,
        offset: f64,
        // Per-element local-frame origin the base mesh was relativized by
        // (#1114; `[0,0,0]` when local frame is off). The mesh stores vertices as
        // `world - rtc - origin`, so the planes must subtract it too or they'd
        // sit a whole building-placement away from the relativized mesh and slice
        // nothing.
        mesh_origin: [f64; 3],
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

        let mut planes = Vec::with_capacity(visual_layers.len().saturating_sub(1));
        let mut cumulative_m = 0.0_f64;
        for (i, layer) in visual_layers.iter().enumerate() {
            cumulative_m += layer.thickness_m;
            // Skip the last layer — there are only N-1 interfaces.
            if i + 1 == visual_layers.len() {
                break;
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
            // Match the mesh frame: world − rtc − per-element local origin.
            let frame_origin = Point3::new(
                world_origin.x - rtc.0 - mesh_origin[0],
                world_origin.y - rtc.1 - mesh_origin[1],
                world_origin.z - rtc.2 - mesh_origin[2],
            );
            planes.push(Plane::new(frame_origin, world_normal));
        }

        Some(planes)
    }
}

/// A collapsed view of the layer stack after merging sub-mm layers into
/// their thick neighbours. Each entry represents one slab that will be
/// emitted as a sub-mesh.
#[derive(Debug, Clone)]
pub(crate) struct VisualLayer {
    /// `IfcMaterial` id that colours the slab. Taken from the dominant
    /// (thickest) source layer in the merge group so thin vapour barriers
    /// don't hijack the slab's colour.
    pub(crate) material_id: u32,
    /// Total thickness of the slab in meters (sum of merged source layers).
    pub(crate) thickness_m: f64,
}

/// Fold sub-mm layers into an adjacent visible layer so every emitted
/// cutting plane sits on a real interface between two slabs that are
/// both thick enough for stable clipping.
///
/// Strategy: start with one slab per source layer. Repeatedly pick the
/// thinnest slab that is still below the clip-stable threshold and fold
/// its thickness into the thicker of its two neighbours (the thicker
/// neighbour's material wins because it dominates the merged slab's
/// appearance). Stops once every slab is above threshold or only one slab
/// remains.
pub(crate) fn merge_thin_layers(layers: &[LayerInfo], unit_scale: f64) -> Vec<VisualLayer> {
    let thresh = MIN_SLICEABLE_THICKNESS_M;
    let mut slabs: Vec<VisualLayer> = layers
        .iter()
        .map(|l| VisualLayer {
            material_id: l.material_id,
            thickness_m: l.thickness * unit_scale,
        })
        .collect();

    loop {
        if slabs.len() <= 1 {
            break;
        }
        // Find the thinnest sub-threshold slab.
        let mut victim: Option<usize> = None;
        let mut victim_thickness = thresh;
        for (i, s) in slabs.iter().enumerate() {
            if s.thickness_m < victim_thickness {
                victim = Some(i);
                victim_thickness = s.thickness_m;
            }
        }
        let Some(v) = victim else { break };

        // Fold into the thicker neighbour; its material dominates the slab.
        let prev = if v > 0 { Some(v - 1) } else { None };
        let next = if v + 1 < slabs.len() {
            Some(v + 1)
        } else {
            None
        };
        let target = match (prev, next) {
            (Some(p), Some(n)) => {
                if slabs[p].thickness_m >= slabs[n].thickness_m {
                    p
                } else {
                    n
                }
            }
            (Some(p), None) => p,
            (None, Some(n)) => n,
            (None, None) => break,
        };
        slabs[target].thickness_m += slabs[v].thickness_m;
        // Adjust target index when removing a slab that preceded it.
        slabs.remove(v);
    }

    slabs
}

/// True when the element's Body representation has exactly one item and
/// that item carries no additional transform relative to the element's
/// own placement. Only in that case do the layer planes (built from the
/// element placement alone) sit in the same frame as the generated mesh.
///
/// We walk the IfcProductDefinitionShape → IfcShapeRepresentation tree,
/// looking at the first representation that will actually contribute to
/// the Body mesh. Any MappedItem, multi-item list, or item with a
/// non-identity `Position` disqualifies the element from layer slicing.
fn element_is_single_unshifted_item(
    element: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> bool {
    // Element attr 6 = Representation (IfcProductDefinitionShape).
    let rep_attr = match element.get(6) {
        Some(a) if !a.is_null() => a,
        _ => return false,
    };
    let rep = match decoder.resolve_ref(rep_attr) {
        Ok(Some(r)) => r,
        _ => return false,
    };
    if rep.ifc_type != IfcType::IfcProductDefinitionShape {
        return false;
    }
    // attr 2 = Representations (list of IfcShapeRepresentation).
    let reps_attr = match rep.get(2) {
        Some(a) => a,
        None => return false,
    };
    let reps = match decoder.resolve_ref_list(reps_attr) {
        Ok(r) => r,
        Err(_) => return false,
    };

    for shape_rep in &reps {
        if shape_rep.ifc_type != IfcType::IfcShapeRepresentation {
            continue;
        }
        // Only inspect body-style representations — axis/curve/footprint
        // don't contribute to the sliced mesh.
        let is_body = shape_rep
            .get(2)
            .and_then(|a| a.as_string())
            .map(|s| {
                matches!(
                    s,
                    "Body"
                        | "SweptSolid"
                        | "SolidModel"
                        | "Brep"
                        | "CSG"
                        | "Clipping"
                        | "SurfaceModel"
                        | "Tessellation"
                        | "AdvancedSweptSolid"
                        | "AdvancedBrep"
                )
            })
            .unwrap_or(false);
        if !is_body {
            continue;
        }

        // attr 3 = Items.
        let items = match shape_rep.get(3).and_then(|a| a.as_list()) {
            Some(l) => l,
            None => return false,
        };
        if items.len() != 1 {
            return false;
        }
        let item_id = match items.first().and_then(|v| v.as_entity_ref()) {
            Some(id) => id,
            None => return false,
        };
        let item = match decoder.decode_by_id(item_id) {
            Ok(e) => e,
            Err(_) => return false,
        };

        return item_has_identity_position(&item, decoder);
    }

    // No body-style representation found — nothing to slice.
    false
}

/// True when the representation item carries no Position transform (or the
/// Position is the identity). Supports the item types that actually show
/// up with IfcMaterialLayerSetUsage in practice (extrusions, revolved /
/// advanced swept solids, boolean clipping on top of those). Anything
/// exotic returns false so we bail safely.
fn item_has_identity_position(item: &DecodedEntity, decoder: &mut EntityDecoder) -> bool {
    match item.ifc_type {
        // Solid primitives with a Position at attribute 1.
        IfcType::IfcExtrudedAreaSolid
        | IfcType::IfcRevolvedAreaSolid
        | IfcType::IfcSurfaceCurveSweptAreaSolid
        | IfcType::IfcFixedReferenceSweptAreaSolid => {
            attribute_placement_is_identity(item, 1, decoder)
        }
        // Boolean results wrap another operand; recurse on the first
        // operand which carries the visible geometry.
        IfcType::IfcBooleanClippingResult | IfcType::IfcBooleanResult => {
            let first_operand_id = match item.get_ref(1) {
                Some(id) => id,
                None => return false,
            };
            match decoder.decode_by_id(first_operand_id) {
                Ok(inner) => item_has_identity_position(&inner, decoder),
                Err(_) => false,
            }
        }
        // MappedItem applies a target transform by definition — always bail.
        IfcType::IfcMappedItem => false,
        // Tessellated / Brep / surface-model items have no Position
        // attribute; the mesh already sits in the element's local frame.
        IfcType::IfcFacetedBrep
        | IfcType::IfcFacetedBrepWithVoids
        | IfcType::IfcAdvancedBrep
        | IfcType::IfcAdvancedBrepWithVoids
        | IfcType::IfcTriangulatedFaceSet
        | IfcType::IfcTriangulatedIrregularNetwork
        | IfcType::IfcPolygonalFaceSet
        | IfcType::IfcFaceBasedSurfaceModel
        | IfcType::IfcShellBasedSurfaceModel => true,
        _ => false,
    }
}

/// Resolve a placement attribute and compare the resulting 4×4 to the
/// identity matrix within a small tolerance. Returns true when the
/// attribute is absent (treated as implicit identity).
fn attribute_placement_is_identity(
    entity: &DecodedEntity,
    attr_index: usize,
    decoder: &mut EntityDecoder,
) -> bool {
    let attr = match entity.get(attr_index) {
        Some(a) => a,
        None => return true,
    };
    if attr.is_null() {
        return true;
    }
    let placement_id = match attr.as_entity_ref() {
        Some(id) => id,
        None => return false,
    };
    match crate::transform::parse_axis2_placement_3d_from_id(placement_id, decoder) {
        Ok(m) => matrix_is_identity(&m),
        Err(_) => false,
    }
}

#[inline]
fn matrix_is_identity(m: &Matrix4<f64>) -> bool {
    const EPS: f64 = 1e-9;
    let id = Matrix4::<f64>::identity();
    for i in 0..4 {
        for j in 0..4 {
            if (m[(i, j)] - id[(i, j)]).abs() > EPS {
                return false;
            }
        }
    }
    true
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
    visual_layers: &[VisualLayer],
    planes: &[Plane],
) -> SubMeshCollection {
    debug_assert_eq!(planes.len() + 1, visual_layers.len());

    let clipper = ClippingProcessor::new();
    let mut out = SubMeshCollection::new();

    // Carve each layer's band off a running REMAINDER at the interface planes,
    // and DO NOT cap the cut. Two design choices, one fix:
    //
    //  - No cap. Capping closed every slab, so each SHARED interface became a
    //    doubled, coincident, oppositely-wound full-cross-section sheet: the wall
    //    rendered solid (the interior caps are backface-culled) but the emitted
    //    mesh was non-watertight (degree-4 interface edges) and ~3x the triangles
    //    — the "ghost face" on opening-cut layered walls. Uncapped, each band is
    //    the wall's outer skin within its layer range; the union of the bands is
    //    exactly the wall's watertight outer shell, partitioned per material. The
    //    interface is no longer a 3D sheet; the 2D section re-closes each band's
    //    open contour at the interface chord (its loop builder is bidirectional,
    //    see `drawing-2d` `PolygonBuilder`), so per-layer section fills are intact.
    //
    //  - Progressive carve, not a fresh clone per band. Both sides of every
    //    interface are produced by the SAME clip of the SAME remainder, so their
    //    cut tessellations are identical and the bands weld edge-for-edge (no
    //    T-junctions, no hairline cracks). Clipping independent clones instead let
    //    a twice-clipped middle band diverge from its neighbour at the second
    //    interface, leaving open T-junction edges.
    //
    // `clip_mesh` keeps the half-space the plane normal points INTO and builds a
    // fresh `Mesh` (origin [0,0,0]); the input mesh + planes are in the element's
    // local frame (#1114), so the origin is restored on each band below.
    let mut remainder = mesh.clone();

    for (i, layer) in visual_layers.iter().enumerate() {
        let before_next: Option<&Plane> = if i + 1 == visual_layers.len() {
            None
        } else {
            planes.get(i)
        };

        let mut slab = match before_next {
            Some(plane) => {
                let flipped = Plane::new(plane.point, -plane.normal);
                // band = remainder below the interface; remainder = above it.
                match (
                    clipper.clip_mesh(&remainder, &flipped),
                    clipper.clip_mesh(&remainder, plane),
                ) {
                    (Ok(band), Ok(rest)) => {
                        remainder = rest;
                        band
                    }
                    // Degenerate interface clip: emit the whole remainder for this
                    // layer rather than dropping geometry, and stop carving.
                    _ => std::mem::take(&mut remainder),
                }
            }
            // Last layer: everything left in the remainder.
            None => std::mem::take(&mut remainder),
        };

        slab.origin = mesh.origin;

        if !slab.is_empty() {
            out.sub_meshes.push(SubMesh::new(layer.material_id, slab));
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn li(material: u32, thickness: f64) -> LayerInfo {
        LayerInfo { material_id: material, thickness }
    }

    #[test]
    fn thin_middle_layer_folded_into_thicker_neighbour() {
        // 100 mm core, 1 mm vapour barrier, 50 mm insulation — unit_scale
        // = 0.001 so values are in meters after scaling.
        let layers = vec![li(1, 100.0), li(2, 1.0), li(3, 50.0)];
        let merged = merge_thin_layers(&layers, 0.001);
        assert_eq!(merged.len(), 2, "3-layer stack with a sub-mm middle should collapse to 2 slabs");
        // First slab absorbed the 1 mm barrier; thicker contributor keeps its material.
        assert_eq!(merged[0].material_id, 1);
        assert!((merged[0].thickness_m - 0.101).abs() < 1e-9);
        assert_eq!(merged[1].material_id, 3);
        assert!((merged[1].thickness_m - 0.050).abs() < 1e-9);
    }

    #[test]
    fn all_thick_layers_stay_separate() {
        let layers = vec![li(1, 50.0), li(2, 80.0), li(3, 30.0)];
        let merged = merge_thin_layers(&layers, 0.001);
        assert_eq!(merged.len(), 3);
        assert_eq!(merged[0].material_id, 1);
        assert_eq!(merged[1].material_id, 2);
        assert_eq!(merged[2].material_id, 3);
    }

    #[test]
    fn trailing_thin_layer_folds_into_previous_slab() {
        let layers = vec![li(1, 50.0), li(2, 80.0), li(3, 1.0)];
        let merged = merge_thin_layers(&layers, 0.001);
        assert_eq!(merged.len(), 2, "sub-mm trailing layer merges into the previous slab");
        assert_eq!(merged[1].material_id, 2);
        assert!((merged[1].thickness_m - 0.081).abs() < 1e-9);
    }

    #[test]
    fn leading_thin_layer_folds_into_next_slab() {
        let layers = vec![li(1, 1.0), li(2, 80.0), li(3, 50.0)];
        let merged = merge_thin_layers(&layers, 0.001);
        assert_eq!(merged.len(), 2);
        // First emitted slab is dominated by layer 2 (thicker than the 1 mm lead-in).
        assert_eq!(merged[0].material_id, 2);
        assert!((merged[0].thickness_m - 0.081).abs() < 1e-9);
        assert_eq!(merged[1].material_id, 3);
    }
}
