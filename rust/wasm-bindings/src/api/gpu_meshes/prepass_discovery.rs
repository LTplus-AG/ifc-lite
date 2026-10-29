// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Columns-driven pre-pass discovery (stage 2 of the sharded pre-pass):
//! reproduces the serial scan loop's job/span collection from the shard
//! class columns, so the pre-pass never byte-scans the file.

use ifc_lite_core::parser::StepRecord;

/// Everything the pre-pass scan loop discovers, filled from the shard class
/// columns instead of a byte scan (stage 2 of the sharded pre-pass). The
/// class byte was computed at shard-scan time from the SAME predicates the
/// serial loop matches on, so filling these from the columns reproduces the
/// serial discovery byte-for-byte — without re-walking the file.
#[derive(Default)]
pub(super) struct ColumnsDiscovery {
    pub buffered_jobs: Vec<(u32, usize, usize, ifc_lite_core::IfcType)>,
    pub total_jobs: u32,
    pub project_id: Option<u32>,
    pub site_position: Option<(u32, usize, usize)>,
    pub prepass_spans: ifc_lite_processing::prepass::PrepassSpans,
    pub mapped_item_spans: Vec<(u32, usize, usize)>,
    pub type_candidate_spans: Vec<(u32, usize, usize, ifc_lite_core::IfcType)>,
    pub has_layer_set: bool,
}

impl ColumnsDiscovery {
    /// Browser scheduling decorates the shared collector without changing its order.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn observe(
        &mut self,
        shared: &mut ifc_lite_processing::discovery::Discovery,
        content: &[u8], id: u32, kw: &str, start: usize, end: usize,
        disabled: &rustc_hash::FxHashSet<String>,
    ) {
        use ifc_lite_processing::scan::ScanClass;
        let class = ScanClass::classify(kw);
        let job = shared.observe(content, class, id, kw, start, end);
        self.project_id = shared.project_id;
        if class == ScanClass::Site {
            self.site_position.get_or_insert((id, start, end));
        }
        if class == ScanClass::MappedItem {
            self.mapped_item_spans.push((id, start, end));
        }
        if class == ScanClass::MaterialLayerSet {
            self.has_layer_set = true;
        }
        if let Some(ty) = ifc_lite_core::type_product_ifc_type(kw) {
            self.type_candidate_spans.push((id, start, end, ty));
        }
        if let Some(ty) = job {
            if !is_disabled(disabled, kw) {
                self.buffered_jobs.push((id, start, end, ty));
                self.total_jobs += 1;
            }
        }
    }
}

/// The raw STEP keyword at a record start (`#id=KEYWORD(...`), read through
/// core's [`StepRecord`] so trivia between the `=` and the keyword (`#1= /*c*/
/// IFCWALL(`) is skipped. Only called for the few records that need it
/// (geometry jobs + type candidates), never for the 19M-entity bulk. A span
/// outside `content` (columns stitched against a different buffer) yields
/// `""`, like a record with no keyword.
fn keyword_at(content: &[u8], start: usize, end: usize) -> &str {
    content
        .get(start..end.min(content.len()))
        .and_then(StepRecord::parse)
        .and_then(|record| record.keyword())
        .unwrap_or("")
}

/// Is the raw keyword `kw` in the caller's load-time skip set? The set holds
/// uppercase names, so an uppercase `kw` (every mainstream exporter) is one
/// hash lookup; only a keyword the file wrote in another case falls to the
/// folded linear scan. The set is empty in the common case.
pub(super) fn is_disabled(disabled_types: &rustc_hash::FxHashSet<String>, kw: &str) -> bool {
    if disabled_types.is_empty() {
        return false;
    }
    if disabled_types.contains(kw) {
        return true;
    }
    kw.bytes().any(|b| b.is_ascii_lowercase())
        && disabled_types.iter().any(|d| ifc_lite_core::keyword_eq(kw, d))
}

/// Walk the stitched (file-ordered) class columns and reproduce the serial
/// pre-pass scan's discovery. `disabled_types` (rare) forces a keyword parse
/// per flagged geometry record; the empty default never touches the bytes.
pub(super) fn discover_from_columns(
    content: &[u8],
    ids: &[u32],
    starts: &[u32],
    lengths: &[u32],
    classes: &[u8],
    disabled_types: &rustc_hash::FxHashSet<String>,
) -> ColumnsDiscovery {
    let mut d = ColumnsDiscovery::default();
    let mut shared = ifc_lite_processing::discovery::Discovery::new(false);
    // Preserve shard/file order, including duplicate ids, before index sorting.
    for (((&id, &start), &length), &class) in ids.iter().zip(starts).zip(lengths).zip(classes) {
        if class == ifc_lite_processing::PREPASS_CLASS_NONE {
            continue;
        }
        let start = start as usize;
        let end = start.saturating_add(length as usize);
        let kw = keyword_at(content, start, end);
        // Invalid spans must not turn a malformed column into an indexing trap.
        if content.get(start..end).is_none() {
            continue;
        }
        d.observe(&mut shared, content, id, kw, start, end, disabled_types);
    }
    d.prepass_spans = shared.prepass_spans;

    d
}


#[cfg(test)]
#[path = "prepass_discovery_tests.rs"]
mod tests;
