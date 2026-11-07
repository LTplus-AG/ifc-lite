// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Streaming discovery and metadata trigger. No post-scan payload emission.
use super::{
    prepass_discovery::ColumnsDiscovery, prepass_index::SerialIndex, prepass_mode::PrepassMode,
};
use crate::api::IfcAPI;
use ifc_lite_core::{ColumnarEntityIndex, EntityDecoder, EntityScanner};
use ifc_lite_processing::stream_meta::{resolve_stream_meta, MetaMode};
use js_sys::Function;
use std::sync::Arc;
use wasm_bindgen::prelude::*;

pub(super) struct ScannedPrepass {
    pub(super) index: Arc<ColumnarEntityIndex>,
    pub(super) discovery: ColumnsDiscovery,
    pub(super) plane_angle_to_radians: f64,
    pub(super) oversized_id_count: usize,
    pub(super) malformed_record_found: bool,
    pub(super) external_styles: bool,
}

fn emit_meta(
    api: &IfcAPI,
    content: &[u8],
    on_event: &Function,
    discovery: &ColumnsDiscovery,
    decoder: &mut EntityDecoder<'_>,
    mode: MetaMode,
) -> Result<f64, JsValue> {
    let meta_res = resolve_stream_meta(
        mode,
        content,
        discovery.project_id,
        discovery.site_position,
        decoder,
    );
    api.collect_pipeline_refusals(decoder);
    super::prepass_events::emit_meta(on_event, &meta_res)?;
    Ok(meta_res.plane_angle_to_radians)
}

pub(super) fn scan(
    api: &IfcAPI,
    content: &[u8],
    on_event: &Function,
    mode: PrepassMode<'_>,
    disabled_types: &rustc_hash::FxHashSet<String>,
) -> Result<ScannedPrepass, JsValue> {
    match mode {
        PrepassMode::Sharded(columns) => {
            // Discover file-order classes before sorting/deduplicating columns.
            // Existing with_arc_columnar_index reuse is retained, not new work.
            let (index, mut discovery) = columns
                .discover_and_build(content, disabled_types)
                .map_err(|m| JsValue::from_str(&m))?;
            discovery.prepass_spans.styled_items = Vec::new();
            let index = Arc::new(index);
            let mut decoder = EntityDecoder::with_arc_columnar_index(content, index.clone());
            let plane_angle_to_radians = emit_meta(
                api,
                content,
                on_event,
                &discovery,
                &mut decoder,
                MetaMode::SmallFileSingle,
            )?;
            ifc_lite_core::report_scan_diagnostics(0, false);
            Ok(ScannedPrepass {
                index,
                discovery,
                plane_angle_to_radians,
                oversized_id_count: 0,
                malformed_record_found: false,
                external_styles: true,
            })
        }
        PrepassMode::Serial => scan_serial(content, disabled_types, |discovery, decoder, mode| {
            emit_meta(api, content, on_event, discovery, decoder, mode)
        }),
    }
}

pub(super) fn scan_serial<'a>(
    content: &'a [u8],
    disabled_types: &rustc_hash::FxHashSet<String>,
    mut on_meta: impl FnMut(&ColumnsDiscovery, &mut EntityDecoder<'a>, MetaMode) -> Result<f64, JsValue>,
) -> Result<ScannedPrepass, JsValue> {
    let mut index = SerialIndex::new(content.len());
    let mut discovery = ColumnsDiscovery::default();
    let mut shared = ifc_lite_processing::discovery::Discovery::default();
    let mut scanner = EntityScanner::new(content);
    let mut plane_angle = None;
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        index.insert(id, start, end);
        discovery.observe(
            &mut shared,
            content,
            id,
            type_name,
            start,
            end,
            disabled_types,
        );
        // Emit at the same 50th accepted job, even with a late IFCPROJECT.
        // This temporary decoder must drop before the next index insertion.
        if let Some(scanned_through) = discovery.early_meta_end(plane_angle.is_some()) {
            let mut decoder = index.decoder(content);
            plane_angle = Some(on_meta(
                &discovery,
                &mut decoder,
                MetaMode::StreamingPartial { scanned_through },
            )?);
        }
    }
    discovery.prepass_spans = shared.prepass_spans;
    let plane_angle_to_radians = match plane_angle {
        Some(scale) => scale,
        None => on_meta(
            &discovery,
            &mut index.decoder(content),
            MetaMode::SmallFileSingle,
        )?,
    };
    let oversized_id_count = scanner.skipped_oversized_ids();
    let malformed_record_found = scanner.malformed_record_start().is_some();
    ifc_lite_core::report_scan_diagnostics(oversized_id_count, malformed_record_found);
    let index = Arc::new(index.into_columns().map_err(|m| JsValue::from_str(&m))?);
    Ok(ScannedPrepass {
        index,
        discovery,
        plane_angle_to_radians,
        oversized_id_count,
        malformed_record_found,
        external_styles: false,
    })
}
