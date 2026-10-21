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
use stages::{LayerProgram, LayerSkip};

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
    ) -> Result<Option<SubMeshCollection>> {
        crate::resource::check_current()?;
        let Some(index) = self.material_layer_index() else { return Ok(None) };
        let Some(buildup) = index.get(element.id) else { return Ok(None) };
        if !buildup.is_sliceable() {
            return Ok(None);
        }
        let empty: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
        let voids = void_index.unwrap_or(&empty);
        let outcome = self.process_element_with_material_layers(element, decoder, buildup, voids);
        self.finish_layer_attempt(element.id, outcome)
    }

    // Observe the terminal account before any fallback diagnostic, including
    // when a lower stage returned ordinary content failure or apparent success.
    fn finish_layer_attempt(
        &self,
        element_id: u32,
        outcome: Result<Option<SubMeshCollection>>,
    ) -> Result<Option<SubMeshCollection>> {
        let collection = match crate::resource::observe(outcome) {
            Ok(Some(c)) => c,
            Ok(None) => return Ok(None),
            Err(error @ crate::Error::ProgramStopped(_)) => return Err(error),
            Err(_e) => {
                self.push_layer_slice_diag(element_id, "skip:base-mesh-error");
                crate::diag::diag_warn!(
                    { element_id = element_id, reason = "base-mesh-error",
                      "material-layers: sliceable element failed to slice, keeping single solid" }
                    else {
                        eprintln!("[material-layers] #{}: sliceable but slicing errored", element_id);
                    }
                );
                return Ok(None);
            }
        };
        if collection.sub_meshes.len() < 2 {
            crate::diag::diag_warn!(
                { element_id = element_id, sub_meshes = collection.sub_meshes.len(),
                  reason = "fewer-than-two-sub-meshes",
                  "material-layers: sliceable element produced too few sub-meshes, keeping single solid" }
                else {
                    eprintln!(
                        "[material-layers] #{}: sliceable but produced {} sub-mesh(es) (<2) — keeping single solid",
                        element_id,
                        collection.sub_meshes.len()
                    );
                }
            );
            return Ok(None);
        }
        // Mesh hygiene: slicing the base mesh by layer-interface planes can
        // introduce zero-area/collinear slivers at the cut, and this layered
        // path early-returns to its callers (process_element_with_submeshes /
        // _and_voids) BEFORE their own cleanup loop runs — so clean here, the
        // single gateway both layered call sites share. See clean_degenerate.
        let mut collection = collection;
        for sub in &mut collection.sub_meshes {
            sub.mesh.clean_degenerate();
        }
        crate::resource::check_current()?;
        crate::diag::diag_debug!(
            { element_id = element_id, sub_meshes = collection.sub_meshes.len(),
              "material-layers: sliced element into layer sub-meshes" }
            else {
                eprintln!(
                    "[material-layers] #{}: sliced into {} layer sub-meshes",
                    element_id,
                    collection.sub_meshes.len()
                );
            }
        );
        Ok(Some(collection))
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
        // Eligibility can decode representation members before host meshing.
        // Run the same source-only admission first, without reporting/claiming:
        // a refusal abstains so ordinary production renders its completed roots.
        // Alignments retain their dedicated directrix processor in host meshing.
        if element.ifc_type != ifc_lite_core::IfcType::IfcAlignment {
            let mut plan = crate::representation::product_budget::admit_product(
                element, decoder, crate::representation::MAX_WALK_LEVELS, self,
            );
            plan.strict()?;
            plan.validate(self, decoder)?;
            if plan.refusal.is_some() { return Ok(None); }
        }
        crate::resource::check_current()?;
        let outcome = LayerProgram::admit(element, decoder, buildup, self.unit_scale);
        let Some(program) = self.accept_layer_stage(element.id, outcome)?.flatten() else {
            return Ok(None);
        };

        // Void subtraction happens on the merged mesh (cheap + topology-safe).
        let host = crate::resource::observe(
            self.process_element_with_voids(element, decoder, void_index),
        )?;
        let Some(request) = self.accept_layer_stage(element.id, program.accept_host(host))? else {
            return Ok(None);
        };
        // Planes live in the host's frame: world - rtc - per-element origin.
        let outcome = request.admit_frame(element, decoder, self);
        let Some(planes) = self.accept_layer_stage(element.id, outcome)? else {
            return Ok(None);
        };
        let Some(ready) = self.accept_layer_stage(element.id, planes.execute())? else {
            return Ok(None);
        };
        // Numerical execution owns an unpublished result. Observe any stop it
        // reached before publication can report success or ordinary fallback.
        let result = ready.execute();
        Ok(Some(result.publish(self, element.id)?))
    }

    fn accept_layer_stage<T>(
        &self,
        element_id: u32,
        outcome: std::result::Result<T, LayerSkip>,
    ) -> Result<Option<T>> {
        crate::resource::check_current()?;
        match outcome {
            Ok(value) => Ok(Some(value)),
            Err(skip) => {
                self.push_layer_slice_diag(element_id, skip.reason());
                Ok(None)
            }
        }
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
