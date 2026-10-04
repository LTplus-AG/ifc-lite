// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Adopt sharded prepass ABI columns after file-order discovery (#6537).
//! Geometry-worker setEntityIndex already adopts its ABI columns (#3989);
//! this covers the remaining clone in the separate sharded prepass worker.

use crate::api::IfcAPI;
use ifc_lite_core::ColumnarEntityIndex;
use js_sys::Function;
use wasm_bindgen::prelude::*;

use super::prepass_discovery::{discover_from_columns, ColumnsDiscovery};

type IndexColumns<'a> = (&'a [u32], &'a [u32], &'a [u32], &'a [u8]);

pub(super) enum ShardedColumns<'a> {
    Borrowed { index: ColumnarEntityIndex, columns: IndexColumns<'a> },
    Owned { ids: Vec<u32>, starts: Vec<u32>, lengths: Vec<u32>, classes: &'a [u8] },
}

fn refuse(message: impl std::fmt::Display) -> String {
    format!("buildPrePassStreamingSharded: {message}")
}

impl<'a> ShardedColumns<'a> {
    fn validate(ids: usize, starts: usize, lengths: usize, classes: usize) -> Result<(), String> {
        // Preserve class-first refusal precedence, before reset/discovery (#4614).
        if classes != ids {
            return Err(refuse(format!("entity index columns disagree in length: ids {ids}, classes {classes}")));
        }
        if starts != ids || lengths != ids {
            return Err(refuse(ifc_lite_core::ColumnLengthMismatch { ids, starts, lengths }));
        }
        Ok(())
    }

    fn borrowed(ids: &'a [u32], starts: &'a [u32], lengths: &'a [u32], classes: &'a [u8]) -> Result<Self, String> {
        Self::validate(ids.len(), starts.len(), lengths.len(), classes.len())?;
        let index = ColumnarEntityIndex::from_columns(ids, starts, lengths).map_err(refuse)?;
        Ok(Self::Borrowed { index, columns: (ids, starts, lengths, classes) })
    }

    fn owned(ids: Vec<u32>, starts: Vec<u32>, lengths: Vec<u32>, classes: &'a [u8]) -> Result<Self, String> {
        Self::validate(ids.len(), starts.len(), lengths.len(), classes.len())?;
        Ok(Self::Owned { ids, starts, lengths, classes })
    }

    pub(super) fn discover_and_build(
        self, content: &[u8], disabled_types: &rustc_hash::FxHashSet<String>,
    ) -> Result<(ColumnarEntityIndex, ColumnsDiscovery), String> {
        let (ids, starts, lengths, classes) = match &self {
            Self::Borrowed { columns, .. } => *columns,
            Self::Owned { ids, starts, lengths, classes } => (ids.as_slice(), starts.as_slice(), lengths.as_slice(), *classes),
        };
        // The class column describes FILE ORDER. Sorting/deduplication must wait
        // until this sole discovery walk has retained all jobs/support spans.
        let discovery = discover_from_columns(content, ids, starts, lengths, classes, disabled_types);
        let index = match self {
            Self::Borrowed { index, .. } => index,
            Self::Owned { ids, starts, lengths, .. } =>
                ColumnarEntityIndex::from_owned_columns(ids, starts, lengths).map_err(refuse)?,
        };
        Ok((index, discovery))
    }
}

#[wasm_bindgen]
impl IfcAPI {
    /// Sharded pre-pass variant: same scan/discovery/jobs/columns pipeline as
    /// `buildPrePassStreaming`, but
    ///  1. the entity index is PREBUILT from the host's stitched shard columns
    ///     (file order; see `scanEntityIndexShard`) — the scan skips its inline
    ///     index build, the meta RTC ladder resolves against the FULL index
    ///     (no partial-ladder full-rescan detour), and the post-scan
    ///     `entity-index` event is skipped (the host already delivered it), and
    ///  2. styles resolution is EXTERNAL: the styled-item spans are resolved as
    ///     shard slices on the geometry workers (`resolveStyledItemsShard`);
    ///     this call stashes the SUPPORT spans + plane-angle scale, and the
    ///     follow-up `finalizePrepassStyles` merges + flattens into the exact
    ///     styles payload the serial path emits. NO `styles` event is emitted
    ///     here.
    #[wasm_bindgen(js_name = buildPrePassStreamingSharded)]
    #[allow(clippy::too_many_arguments)]
    pub fn build_pre_pass_streaming_sharded_owned_binding(
        &self, data: &[u8], on_event: &Function, chunk_size: u32,
        disabled_type_names: Option<Vec<String>>, skip_type_geometry: bool,
        index_ids: Vec<u32>, index_starts: Vec<u32>, index_lengths: Vec<u32>, index_classes: &[u8],
    ) -> Result<JsValue, JsValue> {
        let columns = ShardedColumns::owned(index_ids, index_starts, index_lengths, index_classes)
            .map_err(|message| JsValue::from_str(&message))?;
        self.pre_pass_streaming_impl(data, on_event, chunk_size, disabled_type_names,
            skip_type_geometry, Some(columns), true, false)
    }

    /// Existing sharded prepass plus an exact full-source key in complete.
    #[wasm_bindgen(js_name = buildPrePassStreamingShardedWithSourceFingerprint)]
    #[allow(clippy::too_many_arguments)]
    pub fn build_pre_pass_streaming_sharded_with_source_fingerprint_owned_binding(
        &self, data: &[u8], on_event: &Function, chunk_size: u32,
        disabled_type_names: Option<Vec<String>>, skip_type_geometry: bool,
        index_ids: Vec<u32>, index_starts: Vec<u32>, index_lengths: Vec<u32>, index_classes: &[u8],
    ) -> Result<JsValue, JsValue> {
        let columns = ShardedColumns::owned(index_ids, index_starts, index_lengths, index_classes)
            .map_err(|message| JsValue::from_str(&message))?;
        self.pre_pass_streaming_impl(data, on_event, chunk_size, disabled_type_names,
            skip_type_geometry, Some(columns), true, true)
    }
}

impl IfcAPI {
    /// Borrowed public Rust contract. JS uses the owned binding above.
    #[allow(clippy::too_many_arguments)]
    pub fn build_pre_pass_streaming_sharded(
        &self, data: &[u8], on_event: &Function, chunk_size: u32,
        disabled_type_names: Option<Vec<String>>, skip_type_geometry: bool,
        index_ids: &[u32], index_starts: &[u32], index_lengths: &[u32], index_classes: &[u8],
    ) -> Result<JsValue, JsValue> {
        self.pre_pass_streaming_sharded_impl(data, on_event, chunk_size, disabled_type_names,
            skip_type_geometry, index_ids, index_starts, index_lengths, index_classes, false)
    }

    /// Borrowed public Rust contract, including full-source fingerprinting.
    #[allow(clippy::too_many_arguments)]
    pub fn build_pre_pass_streaming_sharded_with_source_fingerprint(
        &self, data: &[u8], on_event: &Function, chunk_size: u32,
        disabled_type_names: Option<Vec<String>>, skip_type_geometry: bool,
        index_ids: &[u32], index_starts: &[u32], index_lengths: &[u32], index_classes: &[u8],
    ) -> Result<JsValue, JsValue> {
        self.pre_pass_streaming_sharded_impl(data, on_event, chunk_size, disabled_type_names,
            skip_type_geometry, index_ids, index_starts, index_lengths, index_classes, true)
    }

    #[allow(clippy::too_many_arguments)]
    fn pre_pass_streaming_sharded_impl(
        &self, data: &[u8], on_event: &Function, chunk_size: u32,
        disabled_type_names: Option<Vec<String>>, skip_type_geometry: bool,
        index_ids: &[u32], index_starts: &[u32], index_lengths: &[u32], index_classes: &[u8],
        compute_source_fingerprint: bool,
    ) -> Result<JsValue, JsValue> {
        let columns = ShardedColumns::borrowed(index_ids, index_starts, index_lengths, index_classes)
            .map_err(|message| JsValue::from_str(&message))?;
        self.pre_pass_streaming_impl(data, on_event, chunk_size, disabled_type_names,
            skip_type_geometry, Some(columns), true, compute_source_fingerprint)
    }
}

#[cfg(test)]
#[path = "prepass_owned_columns_tests.rs"]
mod tests;
