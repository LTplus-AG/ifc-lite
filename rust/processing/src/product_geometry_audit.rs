// SPDX-License-Identifier: MPL-2.0
//! Opt-in, request-local refusal receipts from the canonical producer (#7711).
use std::{collections::BTreeMap, sync::{Arc, Mutex}};
use crate::element::ProducedElementMeshes;

/// Per-product processing receipts for consumers that cannot accept partial geometry.
/// No entry means NOT proven: skipped/undecodable jobs never become a clean receipt.
/// `Ok` certifies only the diagnostic checks below, not source referential integrity
/// or shared-cache provenance. Strict consumers must check those independently.
#[derive(Clone, Default)]
pub struct ProductGeometryAudit {
    receipts: Arc<Mutex<BTreeMap<u32, Result<(), String>>>>,
}

impl ProductGeometryAudit {
    /// Require a completed job with no recorded item drop, input refusal, CSG
    /// diagnostic (including fallbacks), empty output or degenerate backstop drop.
    /// This intentionally refuses informational CSG records too: absence of loss
    /// must be proved before a strict consumer can exempt a diagnostic reason.
    pub fn require_complete(&self, product_id: u32) -> Result<(), String> {
        self.receipts.lock().unwrap_or_else(|e| e.into_inner()).get(&product_id)
            .cloned().unwrap_or_else(|| Err("no completed processing receipt".into()))
            .map_err(|reason| format!("incomplete product #{product_id}: {reason}"))
    }

    pub(crate) fn record(
        &self, id: u32, produced: &ProducedElementMeshes,
        decoder: &ifc_lite_core::EntityDecoder,
        unsupported: &rustc_hash::FxHashMap<String, u64>,
    ) {
        let mut reasons = Vec::new();
        if !unsupported.is_empty() { reasons.push(format!("dropped representation items: {}", ifc_lite_geometry::format_unsupported_breakdown(unsupported))); }
        if decoder.refused_records() > 0 { reasons.push("refused geometry input".into()); }
        if produced.csg_failures.values().any(|failures| !failures.is_empty()) { reasons.push("CSG diagnostic/fallback".into()); }
        if produced.degenerate_triangles_dropped > 0 { reasons.push("degenerate triangles dropped".into()); }
        if produced.meshes.is_empty() { reasons.push("no mesh output".into()); }
        let receipt = if reasons.is_empty() { Ok(()) } else { Err(reasons.join("; ")) };
        self.receipts.lock().unwrap_or_else(|e| e.into_inner()).insert(id, receipt);
    }
}
