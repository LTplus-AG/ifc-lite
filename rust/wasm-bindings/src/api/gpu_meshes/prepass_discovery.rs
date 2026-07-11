// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Columns-driven pre-pass discovery (stage 2 of the sharded pre-pass):
//! reproduces the serial scan loop's job/span collection from the shard
//! class columns, so the pre-pass never byte-scans the file.

/// The stitched index + class columns handed to the columns-discovery walk.
pub(super) type IndexColumns<'a> = (&'a [u32], &'a [u32], &'a [u32], &'a [u8]);

/// Everything the pre-pass scan loop discovers, filled from the shard class
/// columns instead of a byte scan (stage 2 of the sharded pre-pass). The
/// class byte was computed at shard-scan time from the SAME predicates the
/// serial loop matches on, so filling these from the columns reproduces the
/// serial discovery byte-for-byte — without re-walking the file.
pub(super) struct ColumnsDiscovery {
    pub buffered_jobs: Vec<(u32, usize, usize, ifc_lite_core::IfcType)>,
    pub total_jobs: u32,
    pub project_id: Option<u32>,
    pub site_position: Option<(u32, usize, usize)>,
    pub prepass_spans: ifc_lite_processing::prepass::PrepassSpans,
    pub mapped_item_spans: Vec<(u32, usize, usize)>,
    pub rel_defines_by_type_spans: Vec<(u32, usize, usize)>,
    pub type_candidate_spans: Vec<(u32, usize, usize, ifc_lite_core::IfcType)>,
    pub has_layer_set: bool,
}

/// Parse the raw STEP keyword at a record start (`#id=KEYWORD(...`). Only
/// called for the few records that need it (geometry jobs + type candidates),
/// never for the 19M-entity bulk.
fn keyword_at(content: &[u8], start: usize, end: usize) -> &str {
    let span = &content[start..end.min(content.len())];
    let eq = span.iter().position(|&b| b == b'=').map(|p| p + 1).unwrap_or(0);
    let kw_end = span[eq..]
        .iter()
        .position(|&b| b == b'(')
        .map(|p| eq + p)
        .unwrap_or(span.len());
    std::str::from_utf8(&span[eq..kw_end]).unwrap_or("").trim()
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
    use ifc_lite_processing as p;
    let mut d = ColumnsDiscovery {
        buffered_jobs: Vec::new(),
        total_jobs: 0,
        project_id: None,
        site_position: None,
        prepass_spans: p::prepass::PrepassSpans::default(),
        mapped_item_spans: Vec::new(),
        rel_defines_by_type_spans: Vec::new(),
        type_candidate_spans: Vec::new(),
        has_layer_set: false,
    };
    for i in 0..ids.len() {
        let class = classes[i];
        if class == p::PREPASS_CLASS_NONE {
            continue;
        }
        let id = ids[i];
        let start = starts[i] as usize;
        let end = start + lengths[i] as usize;
        match class & p::PREPASS_CLASS_CODE_MASK {
            c if c == p::PREPASS_CLASS_PROJECT => {
                if d.project_id.is_none() {
                    d.project_id = Some(id);
                }
                continue;
            }
            c if c == p::PREPASS_CLASS_SITE => {
                if d.site_position.is_none() {
                    d.site_position = Some((id, start, end));
                }
                d.buffered_jobs.push((id, start, end, ifc_lite_core::IfcType::IfcSite));
                d.total_jobs += 1;
                continue;
            }
            c if c == p::PREPASS_CLASS_STYLED_ITEM => {
                d.prepass_spans.styled_items.push((id, start, end));
                continue;
            }
            c if c == p::PREPASS_CLASS_INDEXED_COLOUR_MAP => {
                d.prepass_spans.indexed_colour_maps.push((id, start, end));
                continue;
            }
            c if c == p::PREPASS_CLASS_MATERIAL_DEF_REPR => {
                d.prepass_spans.material_def_reprs.push((id, start, end));
                continue;
            }
            c if c == p::PREPASS_CLASS_REL_ASSOCIATES_MATERIAL => {
                d.prepass_spans.rel_associates_material.push((id, start, end));
                continue;
            }
            c if c == p::PREPASS_CLASS_REL_VOIDS => {
                d.prepass_spans.void_rels.push((id, start, end));
                continue;
            }
            c if c == p::PREPASS_CLASS_REL_FILLS => {
                d.prepass_spans.fills_rels.push((id, start, end));
                continue;
            }
            c if c == p::PREPASS_CLASS_REL_AGGREGATES => {
                d.prepass_spans.aggregate_rels.push((id, start, end));
                continue;
            }
            c if c == p::PREPASS_CLASS_MATERIAL_LAYER_SET => {
                d.has_layer_set = true;
                continue;
            }
            c if c == p::PREPASS_CLASS_MAPPED_ITEM => {
                d.mapped_item_spans.push((id, start, end));
                continue;
            }
            c if c == p::PREPASS_CLASS_REL_DEFINES_BY_TYPE => {
                d.rel_defines_by_type_spans.push((id, start, end));
                continue;
            }
            _ => {}
        }
        // Flag bits (the serial `_` arm): type candidate and/or geometry job.
        if class & p::PREPASS_CLASS_FLAG_TYPE_CANDIDATE != 0 {
            let kw = keyword_at(content, start, end);
            d.type_candidate_spans
                .push((id, start, end, ifc_lite_core::IfcType::from_str(kw)));
        }
        if class & p::PREPASS_CLASS_FLAG_GEOMETRY_JOB != 0 {
            let kw = keyword_at(content, start, end);
            if disabled_types.is_empty() || !disabled_types.contains(kw) {
                d.buffered_jobs
                    .push((id, start, end, ifc_lite_core::IfcType::from_str(kw)));
                d.total_jobs += 1;
            }
        }
    }
    d
}
