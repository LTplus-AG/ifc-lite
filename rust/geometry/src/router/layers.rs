// SPDX-License-Identifier: MPL-2.0
//! Layer gateway: public compatibility driver and existing hygiene/diagnostics.
use super::GeometryRouter;
use crate::material_layer_index::LayerBuildup;
use crate::mesh::SubMeshCollection;
use crate::Result;
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use rustc_hash::FxHashMap;

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
        let result = crate::resource::observe(self.process_element_with_material_layers(element, decoder, buildup, voids));
        crate::resource::check_current()?;
        let collection = match result {
            Err(error @ crate::Error::ProgramStopped(_)) => return Err(error),
            Ok(Some(c)) => c,
            Ok(None) => return Ok(None),
            Err(_e) => {
                // A sliceable wall whose base-mesh build errored falls back to a
                // single solid. Record for the browser; warn for native.
                self.push_layer_slice_diag(element.id, "skip:base-mesh-error");
                crate::diag::diag_warn!(
                    { element_id = element.id, reason = "base-mesh-error",
                      "material-layers: sliceable element failed to slice, keeping single solid" }
                    else {
                        eprintln!("[material-layers] #{}: sliceable but slicing errored", element.id);
                    }
                );
                return Ok(None);
            }
        };
        if collection.sub_meshes.len() < 2 {
            crate::diag::diag_warn!(
                { element_id = element.id, sub_meshes = collection.sub_meshes.len(),
                  reason = "fewer-than-two-sub-meshes",
                  "material-layers: sliceable element produced too few sub-meshes, keeping single solid" }
                else {
                    eprintln!(
                        "[material-layers] #{}: sliceable but produced {} sub-mesh(es) (<2) — keeping single solid",
                        element.id,
                        collection.sub_meshes.len()
                    );
                }
            );
            return Ok(None);
        }
        crate::diag::diag_debug!(
            { element_id = element.id, sub_meshes = collection.sub_meshes.len(),
              "material-layers: sliced element into layer sub-meshes" }
            else {
                eprintln!(
                    "[material-layers] #{}: sliced into {} layer sub-meshes",
                    element.id,
                    collection.sub_meshes.len()
                );
            }
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
        crate::resource::check_current()?;
        Ok(Some(collection))
    }

    /// Process an element into per-layer sub-meshes, subtracting any
    /// openings first.
    ///
    /// Returns `Ok(None)` when the buildup isn't sliceable (single material,
    /// constituent set, profile set, degenerate) so the caller can fall back
    /// to the existing sub-mesh-voids path without duplicating work.
    ///
    /// Each emitted [`SubMesh`][crate::SubMesh] carries the layer's `IfcMaterial` entity ID
    /// as its `geometry_id` — callers key colour lookup on that.
    pub fn process_element_with_material_layers(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
        buildup: &LayerBuildup,
        void_index: &FxHashMap<u32, Vec<u32>>,
    ) -> Result<Option<SubMeshCollection>> {
        crate::program::layers::drive(self, element, decoder, buildup, void_index)
    }
}
