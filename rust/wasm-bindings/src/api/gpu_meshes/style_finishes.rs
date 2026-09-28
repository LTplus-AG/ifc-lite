// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #5582: how the prepass `styleFinishes` wire reaches the batch's meshes.
//!
//! The batch entry points take `styleIds` + `styleColors` and nothing else, and
//! their signatures are public `@ifc-lite/wasm` API, so the finish travels
//! beside them instead: the host hands the prepass's `(styleIds,
//! styleFinishes)` pair to [`IfcAPI::set_style_finishes`] once per API
//! instance, and the batch stamps each mesh it hands to JS with the finish of
//! the style its colour came from (the canonical join, #5984), keyed like
//! `styleIds` by styled representation item. The colour-only style index the producer
//! consumes is untouched, so a host that never calls it gets exactly the
//! meshes it always had.

use crate::api::IfcAPI;
use crate::zero_copy::MeshDataJs;
use ifc_lite_core::EntityDecoder;
use ifc_lite_processing::style::{MeshFinishJoin, SpecularMaterial};
use ifc_lite_processing::MeshData;
use rustc_hash::FxHashMap;
use std::sync::{Arc, PoisonError};
use wasm_bindgen::prelude::*;

/// Authored finish per style id, which is a representation-item id for every
/// entry that can carry one (geometry styles win their id in the flatten).
pub(super) type StyleFinishes = FxHashMap<u32, SpecularMaterial>;

/// The cheap `(len, first_id, last_id)` identity of a `styleIds` wire, the same
/// key the batch style cache uses; ties a `setStyleFinishes` call to the style
/// wire it was made for.
pub(super) type StyleWireSignature = (usize, u32, u32);

pub(super) fn style_wire_signature(style_ids: &[u32]) -> StyleWireSignature {
    (
        style_ids.len(),
        style_ids.first().copied().unwrap_or(0),
        style_ids.last().copied().unwrap_or(0),
    )
}

/// Decode a finishes wire: `ids[i]` paired with the two floats `[metallic,
/// roughness]` at `finishes[i * 2 ..]`, each pair decoded by
/// [`ifc_lite_processing::prepass::finish_from_wire`] (non-finite means
/// unauthored). Length-guarded like the colour wire: an id whose pair is not
/// fully present is dropped, never read past the end, and an id with neither
/// field authored (an empty claim) is left out, since it means "no finish".
pub(super) fn style_finishes_from_wire(ids: &[u32], finishes: &[f32]) -> StyleFinishes {
    let mut out = StyleFinishes::default();
    for (&id, pair) in ids.iter().zip(finishes.chunks_exact(2)) {
        if let Some(finish) = ifc_lite_processing::prepass::finish_from_wire([pair[0], pair[1]]) {
            out.insert(id, finish);
        }
    }
    out
}

/// The batch's finish join (#5984): `ifc_lite_processing::style::MeshFinishJoin`
/// over this batch's colour index and decoder, so a mesh's finish comes from
/// the style its colour came from. That reaches past the mesh's own item: an
/// occurrence styled on its `IfcMappedItem`, and #957 type geometry, whose
/// meshes carry no item id at all. `None` inside when no finishes are
/// installed for this style wire, and then every join is free.
pub(super) struct BatchFinishes<'a> {
    join: Option<MeshFinishJoin<'a>>,
}

impl<'a> BatchFinishes<'a> {
    pub(super) fn new(installed: Option<&'a StyleFinishes>, colors: &'a FxHashMap<u32, [f32; 4]>) -> Self {
        let join = installed
            .filter(|f| !f.is_empty())
            .map(|f| MeshFinishJoin::new(f, move |id| colors.get(&id).copied()));
        Self { join }
    }

    /// One finish per mesh, index-parallel; empty when nothing is installed.
    pub(super) fn for_meshes(&mut self, meshes: &[MeshData], decoder: &mut EntityDecoder) -> Vec<Option<SpecularMaterial>> {
        match self.join.as_mut() {
            Some(join) => meshes.iter().map(|m| join.finish_for_mesh(m, decoder)).collect(),
            None => Vec::new(),
        }
    }

    /// The finish of a pose-only (don't-bake) shard occurrence, which has no
    /// `MeshData` of its own.
    pub(super) fn for_occurrence(
        &mut self,
        express_id: u32,
        geometry_item_id: Option<u32>,
        color: [f32; 4],
        decoder: &mut EntityDecoder,
    ) -> Option<SpecularMaterial> {
        self.join.as_mut()?.finish(express_id, geometry_item_id, color, decoder)
    }
}

/// Entry `i` of a [`BatchFinishes::for_meshes`] result (empty means none).
pub(super) fn finish_at(finishes: &[Option<SpecularMaterial>], i: usize) -> Option<SpecularMaterial> {
    finishes.get(i).copied().flatten()
}

/// [`MeshDataJs::from_mesh_data`] plus the #5582 finish stamp. Every site that
/// turns a batch's `MeshData` into a `MeshDataJs` goes through this, so the
/// flat collection and the partitioned batch's flat side cannot disagree.
pub(super) fn mesh_js_with_finish(mesh: MeshData, finish: Option<SpecularMaterial>) -> MeshDataJs {
    let mut js = MeshDataJs::from_mesh_data(mesh);
    if let Some(finish) = finish {
        js.set_material(finish.metallic, finish.roughness);
    }
    js
}

#[wasm_bindgen]
impl IfcAPI {
    /// Install the prepass's authored metallic/roughness per style (#5582):
    /// `styleFinishes` carries two floats per `styleIds` entry,
    /// `[metallic, roughness]`, NaN for an unauthored field — the
    /// `styleFinishes` array every prepass result carries beside `styleColors`.
    /// Call it with the same `styleIds` later passed to `processGeometryBatch*`;
    /// finishes set for a different style wire are ignored. Empty arrays clear
    /// them. Malformed lengths never throw: a style without a complete pair
    /// simply gets no finish.
    ///
    /// The batch stamps each returned `MeshDataJs` (`metallic` / `roughness`)
    /// from these, taking each mesh's finish from the style its colour came
    /// from (#5984). Occurrences that ride the instanced (IFNS) shard carry
    /// theirs in the shard's per-instance finish field (v3).
    #[wasm_bindgen(js_name = setStyleFinishes)]
    pub fn set_style_finishes(&self, style_ids: &[u32], style_finishes: &[f32]) {
        let finishes = style_finishes_from_wire(style_ids, style_finishes);
        *self.style_finishes.lock().unwrap_or_else(PoisonError::into_inner) =
            (!finishes.is_empty()).then(|| (style_wire_signature(style_ids), Arc::new(finishes)));
    }

    /// Sharded pre-pass (#5582): stash the shard-merged geometry finishes —
    /// the `geomFinishes` columns `resolveStyledItemsShard` returns, merged
    /// first-wins like `geomColors` — for the next `finalizePrepassStyles` /
    /// `finalizePrepassStylesFromSource` call on this instance, which consumes
    /// them and emits the aligned `styleFinishes`. Without this call that
    /// finalize emits NaN finishes, as it always emitted colours only.
    #[wasm_bindgen(js_name = setPrepassGeometryFinishes)]
    pub fn set_prepass_geometry_finishes(&self, geom_ids: &[u32], geom_finishes: &[f32]) {
        *self
            .pending_geometry_finishes
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(style_finishes_from_wire(geom_ids, geom_finishes));
    }
}

impl IfcAPI {
    /// The installed finishes, when they were set for this exact style wire.
    pub(super) fn style_finishes_for(&self, style_ids: &[u32]) -> Option<Arc<StyleFinishes>> {
        let slot = self.style_finishes.lock().unwrap_or_else(PoisonError::into_inner);
        match slot.as_ref() {
            Some((sig, finishes)) if *sig == style_wire_signature(style_ids) => Some(Arc::clone(finishes)),
            _ => None,
        }
    }

    /// Take the sharded stash (empty when none was set).
    pub(super) fn take_pending_geometry_finishes(&self) -> StyleFinishes {
        self.pending_geometry_finishes
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
            .unwrap_or_default()
    }

    /// Drop both finish stores (end of load, `clearPrePassCache`).
    pub(crate) fn clear_style_finishes(&self) {
        self.style_finishes.lock().unwrap_or_else(PoisonError::into_inner).take();
        self.pending_geometry_finishes
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
    }
}

#[cfg(test)]
#[path = "style_finishes_tests.rs"]
mod tests;
