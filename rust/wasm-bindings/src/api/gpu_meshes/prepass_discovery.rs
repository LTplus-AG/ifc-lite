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
    /// The serial path emits meta at the 50th accepted job, before EOF or a
    /// late project. Columns already have a full index and use tail meta.
    pub(super) fn early_meta_end(&self, emitted: bool) -> Option<usize> {
        if !emitted && self.buffered_jobs.len() >= 50 {
            self.buffered_jobs.last().map(|job| job.2)
        } else {
            None
        }
    }

    /// Browser scheduling decorates the shared collector without changing its order.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn observe(
        &mut self,
        shared: &mut ifc_lite_processing::discovery::Discovery,
        content: &[u8],
        id: u32,
        kw: &str,
        start: usize,
        end: usize,
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
        if let Some((ty, _by_name)) = job {
            if !is_disabled(disabled, kw) {
                self.buffered_jobs.push((id, start, end, ty));
                self.total_jobs += 1;
            }
        }
    }
}

/// The raw STEP keyword at a record start (`#id=KEYWORD(...`), read through
/// core's [`StepRecord`] so trivia between the `=` and the keyword (`#1= /*c*/
/// IFCWALL(`) is skipped. Only classified rows need a keyword; the bulk of
/// unclassified records are skipped without inspecting their bytes. A span
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
/// pre-pass scan's discovery through the shared collector. Class bytes select
/// the relevant rows; keyword parsing preserves schema labels and filtering.
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
        // #4614: retain invalid-span jobs for the decoder to refuse/count.
        // The shared observer requires an in-bounds record; malformed wire
        // columns still carry their original class and positions.
        if content.get(start..end).is_none() {
            use ifc_lite_processing::{scan::ScanClass, PREPASS_CLASS_CODE_MASK, PREPASS_CLASS_FLAG_GEOMETRY_JOB};
            let kind = ScanClass::try_from(class & PREPASS_CLASS_CODE_MASK).unwrap_or(ScanClass::Other);
            shared.prepass_spans.stash_class(kind, id, start, end);
            match kind {
                ScanClass::Project => {
                    shared.project_id.get_or_insert(id);
                    d.project_id = shared.project_id;
                }
                ScanClass::Site => { d.site_position.get_or_insert((id, start, end)); }
                ScanClass::MappedItem => d.mapped_item_spans.push((id, start, end)),
                ScanClass::MaterialLayerSet => d.has_layer_set = true,
                _ => {}
            }
            if class & ifc_lite_processing::PREPASS_CLASS_FLAG_TYPE_CANDIDATE != 0 {
                if let Some(ty) = ifc_lite_core::type_product_ifc_type(kw) {
                    d.type_candidate_spans.push((id, start, end, ty));
                }
            }
            let site = kind == ScanClass::Site;
            let keyword = if site { "IFCSITE" } else { kw };
            if (site || class & PREPASS_CLASS_FLAG_GEOMETRY_JOB != 0) && !is_disabled(disabled_types, keyword) {
                d.buffered_jobs.push((id, start, end, ifc_lite_core::ifc_type_from_keyword(keyword)));
                d.total_jobs += 1;
            }
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
