// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Core element processing: resolving representations, processing items, and caching.

use super::frame_parts::{
    frames_mergeable, merge_admitted, mesh_bounds, single_frame, union_bounds, FrameParts,
};
use super::transforms::instancing_enabled;
use super::GeometryRouter;
use crate::{InstanceMeta, Mesh, Result};
use crate::representation::MAX_WALK_LEVELS;

use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use std::rc::Rc;

/// Which source hygiene an element's meshes get before placement (#5313).
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum SourceHygiene {
    /// [`Mesh::clean_degenerate_watertight`]: drops slivers without opening a
    /// T-junction. The default for output meshes.
    Watertight,
    /// [`Mesh::clean_degenerate`]: drops slivers, indices only. For meshes that
    /// are about to be boolean operands (void hosts, opening cutters): moving
    /// those inputs changed the cut on ~20 void hosts of the public corpus, so
    /// it is a separate, measured change.
    IndexOnly,
    /// Boolean inputs also split exactly collinear cap seams at an existing
    /// same-face apex index, without changing vertex arrays (#7292).
    BooleanOperand,
}

impl SourceHygiene {
    /// `self`, downgraded to `IndexOnly` while the router is told to keep
    /// triangle order (see `GeometryRouter::set_preserve_triangle_order`).
    pub(crate) fn for_router(self, router: &GeometryRouter) -> Self {
        if router.preserve_triangle_order.get() { Self::IndexOnly } else { self }
    }

    pub(crate) fn apply(self, mesh: &mut Mesh) {
        match self {
            Self::Watertight => mesh.clean_degenerate_watertight(),
            Self::IndexOnly => mesh.clean_degenerate(),
            Self::BooleanOperand => mesh.clean_degenerate_exact_indexed(),
        }
    }
}

impl GeometryRouter {
    /// Process building element (IfcWall, IfcBeam, etc.) into mesh
    /// Follows the representation chain:
    /// Element → Representation → ShapeRepresentation → Items
    ///
    /// Errors when the items cannot share one f64 frame (#6349); use
    /// [`Self::process_element_parts`] to keep such products at full precision.
    #[inline]
    pub fn process_element(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Mesh> {
        single_frame(element.id, self.process_element_parts(element, decoder)?)
    }

    /// [`Self::process_element`] as frame parts: one mesh, unless body items lie
    /// in frames at least 1 km apart, which stay separate meshes (#6349).
    pub fn process_element_parts(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<Mesh>> {
        self.process_element_parts_with_hygiene(element, decoder, SourceHygiene::Watertight)
    }

    /// [`Self::process_element_parts`] with an explicit [`SourceHygiene`]; the
    /// void path passes `IndexOnly` for hosts and cutters.
    pub(crate) fn process_element_parts_with_hygiene(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
        hygiene: SourceHygiene,
    ) -> Result<Vec<Mesh>> {
        self.process_element_parts_with_budget(element, decoder, hygiene, MAX_WALK_LEVELS)
    }

    pub(super) fn process_element_parts_with_budget(
        &self, element: &DecodedEntity, decoder: &mut EntityDecoder,
        hygiene: SourceHygiene, allowance: u32,
    ) -> Result<Vec<Mesh>> {
        crate::resource::check_current()?;
        // IfcAlignment carries its directrix curve in a dedicated `Axis`
        // attribute (IFC4X1) instead of (or in addition to) a normal
        // IfcShapeRepresentation. Route those through the alignment
        // processor before the standard representation walk, since the
        // Representation is often `$` in practice.
        if element.ifc_type == IfcType::IfcAlignment {
            if let Some(mesh) = self.try_alignment_mesh(element, decoder)? {
                return Ok(vec![mesh]);
            }
        }

        let plan = self.admitted_product(element, decoder, allowance)?;
        if plan.representations.iter().all(|(_, items)| items.is_empty()) {
            return Ok(vec![Mesh::new()]);
        }

        // Process all representations and merge meshes
        let mut combined_mesh = Mesh::new();
        let mut rebased_mesh = Mesh::new();
        let mut captured_local_bounds: Option<[f32; 6]> = None;
        // #6349: items too far from `combined_mesh`'s frame, and the RTC-frame items' own bounds.
        let (mut far_parts, mut rebased_bounds) = (FrameParts::default(), None);

        // Instancing: an element is cleanly shareable only when its whole body is
        // exactly ONE representation item that itself carried instance metadata
        // (a mapped item). `Mesh::merge` does not propagate the side-channel, so we
        // capture the single item's metadata here and re-attach it below; any second
        // item disqualifies the element (left as None -> rendered flat).
        let mut single_instance_meta: Option<InstanceMeta> = None;
        let mut instanceable_item_count: usize = 0;

        // Body representations only ('Axis', 'FootPrint', 'Box' are skipped), and
        // a MappedRepresentation is skipped when direct geometry duplicates it.
        'items: for (shape_rep, items) in &plan.representations {
            let fill_only = super::annotation::is_fill_only_representation(element, shape_rep);

            // Process each representation item
            // A mapped item whose source mixes frames yields one mesh per frame (#6446).
            for item in items {
                plan.validate(self, decoder)?;
                let item_parts = if element.ifc_type == IfcType::IfcAnnotation
                    && item.ifc_type == IfcType::IfcAnnotationFillArea
                {
                    vec![self.process_annotation_fill(item, decoder)?]
                } else if fill_only {
                    continue; // symbolic annotation item, never meshed (#5389)
                } else if let Some(mesh) =
                    self.process_raw_item_for_element(item, element, decoder)?
                {
                    vec![mesh]
                } else {
                    self.process_representation_item_parts(item, decoder)?
                };
                for mesh in item_parts {
                    if mesh.positions.is_empty() {
                        continue; // Mesh::merge would ignore it too
                    }
                    let bounds = mesh.local_bounds.unwrap_or_else(|| mesh_bounds(&mesh));
                    if instancing_enabled() {
                        instanceable_item_count += 1;
                        single_instance_meta = if instanceable_item_count == 1 {
                            mesh.instance_meta.clone()
                        } else {
                            None
                        };
                    }
                    // #5684: early f64 processors and ordinary f32 processors can
                    // return different RTC frames. Merge only like frames until
                    // placement has brought both into the world/RTC frame.
                    if mesh.rtc_applied {
                        if !merge_admitted(&mut rebased_mesh, &mesh) {
                            break 'items;
                        }
                        union_bounds(&mut rebased_bounds, bounds);
                        continue;
                    } else if combined_mesh.positions.is_empty()
                        || frames_mergeable(combined_mesh.origin, mesh.origin)
                    {
                        if !merge_admitted(&mut combined_mesh, &mesh) {
                            break 'items;
                        }
                    } else {
                        far_parts.merge(&mesh, bounds);
                        continue;
                    }
                    union_bounds(&mut captured_local_bounds, bounds);
                }
            }
        }
        // A refused merge only records the account's sticky stop; surface it
        // before hygiene or placement run over partial output.
        if crate::resource::is_active() {
            crate::resource::check_current()?;
        }
        if combined_mesh.positions.is_empty() {
            std::mem::swap(&mut combined_mesh, &mut rebased_mesh);
            captured_local_bounds = rebased_bounds.take();
        }

        // Re-attach single-item instance metadata so apply_placement can fold the
        // element's world placement into `transform`.
        if instancing_enabled() {
            combined_mesh.instance_meta = single_instance_meta;
        }
        combined_mesh.local_bounds = captured_local_bounds;

        // Source-triangle hygiene before placement (rigid transforms preserve
        // degeneracy, while the element-local frame retains more f32 precision).
        // This is the merged-mesh router's choke point: downstream facet weld /
        // refinement passes canonicalize geometry but do not replace this input
        // cleanup or promise hygienic output. See `SourceHygiene` (#5313).
        // Cut-created candidates require separate, path-specific handling. See
        // #4797.
        hygiene.for_router(self).apply(&mut combined_mesh);

        // Apply placement transformation
        self.apply_placement(element, decoder, &mut combined_mesh)?;
        let rebased = (rebased_mesh, rebased_bounds);
        self.place_frame_parts(element, decoder, hygiene, combined_mesh, far_parts, rebased)
    }

    /// Run an `IfcAlignment` through the dedicated alignment processor, then
    /// apply the standard unit scale + placement transform. Returns `None`
    /// when the alignment has no recognisable directrix curve (the caller
    /// falls back to normal representation processing).
    fn try_alignment_mesh(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Option<Mesh>> {
        crate::resource::check_current()?;
        let processor = match self.processor_for(&IfcType::IfcAlignment) {
            Some(p) => Rc::clone(p),
            None => return Ok(None),
        };
        let mut mesh =
            match processor.process(element, decoder, self.schema, self.tessellation_quality) {
            Ok(m) => m,
            // Missing Axis or unparseable curve isn't fatal — fall back so
            // the caller can still walk a normal representation if present.
            Err(error) => {
                Self::recoverable_source_error(error)?;
                return Ok(None);
            },
        };
        if mesh.positions.is_empty() {
            return Ok(None);
        }
        mesh.validate_indices();
        self.scale_mesh(&mut mesh);
        self.apply_placement(element, decoder, &mut mesh)?;
        Ok(Some(mesh))
    }

    /// Drain refs the content-hash walk refused above `u32::MAX` (#3421/#3752).
    pub fn take_content_hash_oversized_ref_drops(&self) -> usize {
        std::mem::take(&mut *self.content_hash_oversized_ref_drops.borrow_mut())
    }
}

#[cfg(test)]
#[path = "processing_hygiene_tests.rs"]
mod hygiene_tests;

#[cfg(test)]
#[path = "processing_budget_tests.rs"]
mod budget_tests;
