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
    // instance-level exception so a spatial container (`IfcBuildingStorey`
    // et al.) that exceptionally carries a non-null Representation is still
    // scheduled as a geometry job. The SHARDED/column-discovery path here
    // reads a separate, precomputed class byte
    // (`ifc_lite_processing::classify_type_name_with_content`) instead of
    // re-deriving anything from the type name, so it needed the identical
    // exception applied at classification time or this exact file would
    // still render nothing in a worker-sharded (browser) load even after the
    // serial-path fix. This test exercises the real column-discovery walk
    // (`discover_from_columns`), not just the classifier, so it fails if
    // either half of the pipeline regresses.
    //
    // Uses the `IfcBuildingStorey` fixture, not the `IfcBuilding` one:
    // #1969 (merged on `main` after this test was first written) exempts
    // `IfcBuilding` from `is_non_geometric_spatial` class-wide, so
    // `has_geometry_by_name("IFCBUILDING")` is now unconditionally `true`
    // and the building's class byte would carry the geometry-job flag via
    // the ordinary by-name classification regardless of whether the
    // instance-level exception this test exists to cover works at all.
    // `IfcBuildingStorey` stays blocked by name, so reaching its job here
    // can only happen through the exception branch actually firing.
    const FIXTURE: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../geometry/tests/fixtures/issue_1910_storey_shell_geometry.ifc"
    );

    fn read_fixture() -> String {
        std::fs::read_to_string(FIXTURE).expect("issue_1910 storey fixture must be present")
    }

    #[test]
    fn sharded_column_discovery_schedules_storey_geometry_job() {
        let mut content = read_fixture();
        // #1910 review follow-up: the fixture only ever proved a storey
        // WITH a non-null Representation gets a geometry job. Inject a
        // second storey with a null Representation (attribute index 6,
        // verified against #40's positional layout above) so a mutation
        // that flagged every storey unconditionally would fail this test.
        // Not editing the shared fixture file itself -- it has four
        // consumers and this second entity is only relevant here.
        let injected =
            "#42=IFCBUILDINGSTOREY('7777777777777777770108',$,'Level 2',$,$,#18,$,$,.ELEMENT.,0.);\n";
        // `rfind`, not `find`: the fixture has two `ENDSEC;` markers (one
        // closing HEADER, one closing DATA) -- the injected entity must
        // land inside the DATA section, right before its `ENDSEC;`.
        let endsec_pos = content.rfind("ENDSEC;").expect("fixture must have an ENDSEC;");
        content.insert_str(endsec_pos, injected);
        let bytes = content.as_bytes();

        assert!(
            !ifc_lite_core::has_geometry_by_name("IFCBUILDINGSTOREY"),
            "sanity: IFCBUILDINGSTOREY must stay excluded from has_geometry_by_name -- \
             otherwise this test would pass via the ordinary by-name classification and \
             stop proving the instance-level exception fires"
        );

        // Stage 1: shard-scan + classify, exactly as `scan_entity_index_shard`
        // does before handing the columns to the host.
        let (records, classes, handoff) =
            ifc_lite_processing::scan_shard_classified(bytes, 0, bytes.len());
        assert!(handoff.is_none(), "single shard must cover the whole fixture");

        let ids: Vec<u32> = records.iter().map(|&(id, _, _)| id).collect();
        let starts: Vec<u32> = records.iter().map(|&(_, s, _)| s as u32).collect();
        let lengths: Vec<u32> = records.iter().map(|&(_, s, e)| (e - s) as u32).collect();

        // Locate the two storeys separately, by GlobalId, not by keyword
        // alone -- both entities are IFCBUILDINGSTOREY.
        let find_storey_idx = |global_id: &str| {
            records
                .iter()
                .position(|&(_, s, e)| {
                    keyword_at(bytes, s, e) == "IFCBUILDINGSTOREY"
                        && bytes[s..e].windows(global_id.len()).any(|w| w == global_id.as_bytes())
                })
                .unwrap_or_else(|| panic!("fixture must contain a storey with GlobalId {global_id}"))
        };
        let with_repr_idx = find_storey_idx("7777777777777777770103");
        let without_repr_idx = find_storey_idx("7777777777777777770108");

        // Sanity: the storey entity's class byte must carry the geometry-job
        // flag (this is what a regression in `classify_type_name_with_content`
        // or its `scan_shard_classified` wiring would break).
        assert!(
            classes[with_repr_idx] & ifc_lite_processing::PREPASS_CLASS_FLAG_GEOMETRY_JOB != 0,
            "IFCBUILDINGSTOREY's shard class byte must carry the geometry-job flag \
             when its Representation is non-null (#1910)"
        );
        assert!(
            classes[without_repr_idx] & ifc_lite_processing::PREPASS_CLASS_FLAG_GEOMETRY_JOB == 0,
            "an IFCBUILDINGSTOREY with a null Representation must NOT carry the \
             geometry-job flag (#1910 negative case)"
        );

        // Stage 2: the actual column-discovery walk the sharded browser path
        // runs (`buildPrePassStreamingSharded` -> `discover_from_columns`).
        let disabled = rustc_hash::FxHashSet::default();
        let discovery = discover_from_columns(bytes, &ids, &starts, &lengths, &classes, &disabled);

        let with_repr_id = records[with_repr_idx].0;
        let without_repr_id = records[without_repr_idx].0;
        assert!(
            discovery
                .buffered_jobs
                .iter()
                .any(|&(id, _, _, _)| id == with_repr_id),
            "sharded column discovery must emit a geometry job for the \
             storey whose only geometry hangs off IFCBUILDINGSTOREY (#1910); \
             buffered_jobs = {:?}",
            discovery.buffered_jobs
        );
        assert!(
            discovery
                .buffered_jobs
                .iter()
                .all(|&(id, _, _, _)| id != without_repr_id),
            "sharded column discovery must NOT emit a geometry job for a storey \
             with a null Representation (#1910 negative case); buffered_jobs = {:?}",
            discovery.buffered_jobs
        );
    }
}
