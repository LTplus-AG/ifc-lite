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


#[cfg(test)]
mod tests {
    use super::*;

    // #1910 follow-up (Greptile-flagged displaced-path gap): the serial scan
    // loop in `prepass.rs` and the streaming processor both grew an
    // instance-level exception so a spatial container (`IfcBuilding` et al.)
    // that exceptionally carries a non-null Representation is still
    // scheduled as a geometry job. The SHARDED/column-discovery path here
    // reads a separate, precomputed class byte
    // (`ifc_lite_processing::classify_type_name_with_content`) instead of
    // re-deriving anything from the type name, so it needed the identical
    // exception applied at classification time or this exact file would
    // still render nothing in a worker-sharded (browser) load even after the
    // serial-path fix. This test exercises the real column-discovery walk
    // (`discover_from_columns`), not just the classifier, so it fails if
    // either half of the pipeline regresses.
    const FIXTURE: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../geometry/tests/fixtures/issue_1910_building_shell_geometry.ifc"
    );

    fn read_fixture() -> String {
        std::fs::read_to_string(FIXTURE).expect("issue_1910 fixture must be present")
    }

    #[test]
    fn sharded_column_discovery_schedules_building_geometry_job() {
        let content = read_fixture();
        let bytes = content.as_bytes();

        // Stage 1: shard-scan + classify, exactly as `scan_entity_index_shard`
        // does before handing the columns to the host.
        let (records, classes, handoff) =
            ifc_lite_processing::scan_shard_classified(bytes, 0, bytes.len());
        assert!(handoff.is_none(), "single shard must cover the whole fixture");

        let ids: Vec<u32> = records.iter().map(|&(id, _, _)| id).collect();
        let starts: Vec<u32> = records.iter().map(|&(_, s, _)| s as u32).collect();
        let lengths: Vec<u32> = records.iter().map(|&(_, s, e)| (e - s) as u32).collect();

        // Sanity: the building entity's class byte must carry the geometry-job
        // flag (this is what a regression in `classify_type_name_with_content`
        // or its `scan_shard_classified` wiring would break).
        let building_idx = records
            .iter()
            .position(|&(_, s, e)| {
                let span = &bytes[s..e];
                let eq = span.iter().position(|&b| b == b'=').map(|p| p + 1).unwrap_or(0);
                span[eq..].starts_with(b"IFCBUILDING(")
            })
            .expect("fixture must contain an IFCBUILDING entity");
        assert!(
            classes[building_idx] & ifc_lite_processing::PREPASS_CLASS_FLAG_GEOMETRY_JOB != 0,
            "IFCBUILDING's shard class byte must carry the geometry-job flag              when its Representation is non-null (#1910)"
        );

        // Stage 2: the actual column-discovery walk the sharded browser path
        // runs (`buildPrePassStreamingSharded` -> `discover_from_columns`).
        let disabled = rustc_hash::FxHashSet::default();
        let discovery = discover_from_columns(bytes, &ids, &starts, &lengths, &classes, &disabled);

        let building_id = records[building_idx].0;
        assert!(
            discovery
                .buffered_jobs
                .iter()
                .any(|&(id, _, _, _)| id == building_id),
            "sharded column discovery must emit a geometry job for the              building whose only geometry hangs off IFCBUILDING (#1910);              buffered_jobs = {:?}",
            discovery.buffered_jobs
        );
    }
}
