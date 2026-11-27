// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Out-of-core geometry batches. A worker holds a sparse arena of the
//! records its jobs reference instead of the whole file and its own entity
//! index. The host owns the byte source and the id to offset lookup:
//!
//! 1. `sparseBegin(preamble)` once per load.
//! 2. Per batch: `sparseExpand(roots)` names the records still needed; the
//!    host reads them by range and calls `sparseInstall`; repeat on the newly
//!    installed ids until nothing is missing.
//! 3. `processGeometryBatch*Sparse(...)`, same wire as the `*FromSource` twins.
//! 4. `sparseTakeMisses()`: an id the batch looked up and did not find, while
//!    the file holds it, means the walk missed a dependency. The host installs
//!    it, calls `sparseInvalidateDerived` and runs the batch again.
//!
//! The mesh code is the same code; only the bytes behind `content` differ.

use crate::api::IfcAPI;
use crate::zero_copy::MeshCollection;
use ifc_lite_core::{SparseIndex, SparseSource};
use std::sync::{Arc, PoisonError};
use wasm_bindgen::prelude::*;

use super::batch_wire::{BatchSource, BatchWire};
use super::partitioned_batch::PartitionedBatch;

/// The arena plus what the batch path caches against it.
pub(in crate::api) struct SparseSession {
    pub(super) source: SparseSource,
    /// `SparseStats::referrer_generation` the per-content colour/texture
    /// indexes were last built at.
    indexed_at_generation: Option<u32>,
    /// Index handed to the decoder of the batch that is running.
    pub(super) active_index: Option<Arc<SparseIndex>>,
}

impl IfcAPI {
    fn with_sparse<R>(&self, f: impl FnOnce(&mut SparseSession) -> R) -> Option<R> {
        self.content.sparse.lock().unwrap_or_else(PoisonError::into_inner).as_mut().map(f)
    }

    /// Index of the batch in flight, when it runs over the sparse arena.
    pub(super) fn active_sparse_index(&self) -> Option<Arc<SparseIndex>> {
        self.with_sparse(|session| session.active_index.clone()).flatten()
    }

    /// Arena, index and job spans rewritten to arena offsets. A job whose
    /// record is not installed keeps an empty span and is refused downstream.
    fn sparse_batch_inputs(&self, jobs_flat: &[u32]) -> Option<(Arc<Vec<u8>>, Vec<u32>)> {
        let prepared = self.with_sparse(|session| {
            let generation = session.source.stats().referrer_generation;
            let stale = session.indexed_at_generation != Some(generation);
            session.indexed_at_generation = Some(generation);
            let index = session.source.index();
            let mut jobs = Vec::with_capacity(jobs_flat.len());
            for job in jobs_flat.chunks_exact(3) {
                let (start, end) = index.peek(job[0]).unwrap_or((0, 0));
                jobs.extend_from_slice(&[job[0], start as u32, end as u32]);
            }
            session.active_index = Some(index);
            (session.source.bytes(), jobs, stale)
        })?;
        let (bytes, jobs, stale) = prepared;
        if stale {
            // Built by scanning the arena for inverse-referencing maps: stale
            // once a new one was installed or a reset dropped them.
            crate::api::content_lifetime::discard(&self.content.cached_indexed_colour_maps);
            crate::api::content_lifetime::discard(&self.content.cached_texture_index);
        }
        Some((bytes, jobs))
    }

    fn end_sparse_batch(&self) {
        self.with_sparse(|session| session.active_index = None);
    }
}

#[wasm_bindgen]
impl IfcAPI {
    /// Start an out-of-core session from the pre-pass preamble. Replaces any
    /// previous content, like `setEntityIndex`. `reserve_bytes` sizes the
    /// arena once (the host's budget plus headroom), so it never reallocates
    /// below that; 0 lets it grow on demand.
    #[wasm_bindgen(js_name = sparseBegin)]
    pub fn sparse_begin(&self, preamble: Vec<u8>, reserve_bytes: u32) {
        self.begin_content_install();
        crate::api::content_lifetime::discard(&self.content.cached_source_bytes);
        let session = SparseSession {
            source: SparseSource::with_reserve(preamble, reserve_bytes as usize),
            indexed_at_generation: None,
            active_index: None,
        };
        *self.content.sparse.lock().unwrap_or_else(PoisonError::into_inner) = Some(session);
    }

    /// Declare records that reference a target and must travel with it
    /// (indexed colour and texture maps): `referrers[i]` references `targets[i]`.
    #[wasm_bindgen(js_name = sparseSetInverseEdges)]
    pub fn sparse_set_inverse_edges(&self, targets: &[u32], referrers: &[u32]) {
        self.with_sparse(|session| session.source.set_inverse_edges(targets, referrers));
    }

    /// Ids reachable from `ids` within `max_depth` hops (`0xFFFFFFFF` for the
    /// full closure) that are not installed yet, ascending.
    #[wasm_bindgen(js_name = sparseExpand)]
    pub fn sparse_expand(&self, ids: &[u32], max_depth: u32) -> Vec<u32> {
        let mut missing = Vec::new();
        self.with_sparse(|session| session.source.expand(ids, max_depth, &mut missing));
        missing
    }

    /// Install records from one contiguous read. `spans` is flat
    /// `[id, offset, length]` triples into `chunk`.
    #[wasm_bindgen(js_name = sparseInstall)]
    pub fn sparse_install(&self, spans: &[u32], chunk: &[u8]) {
        let triples: Vec<(u32, usize, usize)> = spans
            .chunks_exact(3)
            .map(|s| (s[0], s[1] as usize, s[2] as usize))
            .collect();
        self.with_sparse(|session| session.source.install(&triples, chunk));
    }

    /// Ids the file does not hold, so the walk stops asking for them.
    #[wasm_bindgen(js_name = sparseMarkAbsent)]
    pub fn sparse_mark_absent(&self, ids: &[u32]) {
        self.with_sparse(|session| session.source.mark_absent(ids));
    }

    /// Ids a batch looked up and did not find since the last call.
    #[wasm_bindgen(js_name = sparseTakeMisses)]
    pub fn sparse_take_misses(&self) -> Vec<u32> {
        self.with_sparse(|session| session.source.take_misses()).unwrap_or_default()
    }

    /// `[arenaBytes, baseBytes, records, installedBytesTotal,
    /// installedRecordsTotal, resets]`.
    #[wasm_bindgen(js_name = sparseStats)]
    pub fn sparse_stats(&self) -> Vec<f64> {
        self.with_sparse(|session| {
            let s = session.source.stats();
            vec![
                s.arena_bytes as f64,
                s.base_bytes as f64,
                s.records as f64,
                s.installed_bytes_total as f64,
                s.installed_records_total as f64,
                f64::from(s.resets),
            ]
        })
        .unwrap_or_default()
    }

    /// Drop every installed record but the preamble (the host's byte budget).
    /// Mesh caches survive: they are keyed by entity id, not by arena offset.
    #[wasm_bindgen(js_name = sparseReset)]
    pub fn sparse_reset(&self) {
        self.with_sparse(|session| session.source.reset());
    }

    /// Forget results derived while a dependency was missing, before the batch
    /// that reported the miss runs again.
    #[wasm_bindgen(js_name = sparseInvalidateDerived)]
    pub fn sparse_invalidate_derived(&self) {
        self.content.production_model.invalidate_source();
        self.invalidate_brep_signatures();
        crate::api::content_lifetime::discard(&self.content.cached_item_dedup);
        crate::api::content_lifetime::discard(&self.content.cached_mapped_item);
        crate::api::content_lifetime::discard(&self.content.cached_indexed_colour_maps);
        crate::api::content_lifetime::discard(&self.content.cached_texture_index);
        self.with_sparse(|session| session.indexed_at_generation = None);
    }

    /// End the session and free the arena.
    #[wasm_bindgen(js_name = sparseEnd)]
    pub fn sparse_end(&self) {
        self.content.sparse.lock().unwrap_or_else(PoisonError::into_inner).take();
    }

    /// `processGeometryBatchFromSource` over the sparse arena.
    #[wasm_bindgen(js_name = processGeometryBatchSparse)]
    #[allow(clippy::too_many_arguments)]
    pub fn process_geometry_batch_sparse(
        &self,
        jobs_flat: &[u32],
        unit_scale: f64,
        rtc_x: f64,
        rtc_y: f64,
        rtc_z: f64,
        needs_shift: bool,
        void_keys: &[u32],
        void_counts: &[u32],
        void_values: &[u32],
        style_ids: &[u32],
        style_colors: &[u8],
        plane_angle_to_radians: Option<f64>,
        material_element_ids: Option<Vec<u32>>,
        material_color_counts: Option<Vec<u32>>,
        material_colors_rgba: Option<Vec<u8>>,
    ) -> Result<MeshCollection, JsValue> {
        let (bytes, jobs) = self.sparse_batch_inputs(jobs_flat).ok_or_else(no_sparse_session)?;
        let wire = BatchWire {
            jobs_flat: &jobs, unit_scale, rtc_x, rtc_y, rtc_z, needs_shift, void_keys, void_counts, void_values, style_ids, style_colors, plane_angle_to_radians, material_element_ids, material_color_counts, material_colors_rgba,
        };
        let out = self.batch_flat(BatchSource::Held(bytes), wire);
        self.end_sparse_batch();
        Ok(out)
    }

    /// `processGeometryBatchPartitionedFromSource` over the sparse arena.
    #[wasm_bindgen(js_name = processGeometryBatchPartitionedSparse)]
    #[allow(clippy::too_many_arguments)]
    pub fn process_geometry_batch_partitioned_sparse(
        &self,
        jobs_flat: &[u32],
        unit_scale: f64,
        rtc_x: f64,
        rtc_y: f64,
        rtc_z: f64,
        needs_shift: bool,
        void_keys: &[u32],
        void_counts: &[u32],
        void_values: &[u32],
        style_ids: &[u32],
        style_colors: &[u8],
        plane_angle_to_radians: Option<f64>,
        material_element_ids: Option<Vec<u32>>,
        material_color_counts: Option<Vec<u32>>,
        material_colors_rgba: Option<Vec<u8>>,
    ) -> Result<PartitionedBatch, JsValue> {
        let (bytes, jobs) = self.sparse_batch_inputs(jobs_flat).ok_or_else(no_sparse_session)?;
        let wire = BatchWire {
            jobs_flat: &jobs, unit_scale, rtc_x, rtc_y, rtc_z, needs_shift, void_keys, void_counts, void_values, style_ids, style_colors, plane_angle_to_radians, material_element_ids, material_color_counts, material_colors_rgba,
        };
        let out = self.batch_partitioned(BatchSource::Held(bytes), wire);
        self.end_sparse_batch();
        Ok(out)
    }
}

/// A sparse batch with no session is a host error, never an empty batch: an empty result would read
/// as a batch that meshed nothing.
fn no_sparse_session() -> JsValue {
    JsValue::from_str("no sparse session: call sparseBegin before a sparse batch")
}

#[cfg(test)]
#[path = "sparse_tests.rs"]
mod tests;
