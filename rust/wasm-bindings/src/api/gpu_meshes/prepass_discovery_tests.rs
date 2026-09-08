//! Tests for `prepass_discovery`, split out of it for the module-size ratchet.
//!
//! The rule there is shrink or split by default -- a raise is possible on both
//! sides (see `module_size_ratchet.rs`, which records one reaching main and
//! being undone, #2658), it is just not the move here -- and a `_tests.rs`
//! file is exempt by the gate's own `is_exempt`. Same move as
//! `styling/prepass_issue_3187_tests.rs`.
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

    // The geometry-JOB fixture. `IFCBEAMSTANDARDCASE` is an IFC4 entity that
    // IFC4X3 removed, and `has_geometry_by_name` admits it, so it reaches the
    // geometry-job branch directly. Declared IFC4 because that is the schema
    // the entity belongs to; nothing on this path reads FILE_SCHEMA, but a
    // header contradicting its own content misleads the next reader.
    const LEGACY_JOB_FIXTURE: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','2026-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000A',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#30=IFCBEAMSTANDARDCASE('0Beam00000000000000A',$,'Beam',$,$,#5,$,$,$);
ENDSEC;
END-ISO-10303-21;
"#;

// #3187: an IFC2X3 `IfcDoorStyle` whose RepresentationMap no IfcMappedItem
// references. `IfcType::from_str("IFCDOORSTYLE")` is `Unknown` -- the
// keyword is one IFC4X3 dropped -- so the flag-setting classifier and the
// label this walk attaches must BOTH go through the legacy-aware
// resolver, or the span is either never flagged or flagged and then
// labelled `Unknown`.
const LEGACY_TYPE_FIXTURE: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000A',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#8=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)));
#10=IFCREPRESENTATIONMAP(#5,#12);
#12=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#13));
#13=IFCTRIANGULATEDFACESET(#8,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
#20=IFCDOORSTYLE('0DoorStyle000000000A',$,'DoorStyle',$,$,$,(#10),$,.NOTDEFINED.,.NOTDEFINED.,.F.,.F.);
ENDSEC;
END-ISO-10303-21;
"#;

/// The sharded browser path's own pin for #3187. The serial scan is not
/// reachable from a host test (it lives inside a `#[wasm_bindgen]` method
/// driven by JS callbacks), but this walk is, and it is the path that
/// re-attaches an `IfcType` to a span someone else flagged -- the exact
/// place a bare `IfcType::from_str` would put `Unknown` on the wire.
#[test]
fn sharded_column_discovery_labels_a_legacy_type_candidate_with_its_base_type() {
    let bytes = LEGACY_TYPE_FIXTURE.as_bytes();
    assert!(
        matches!(
            ifc_lite_core::IfcType::from_str("IFCDOORSTYLE"),
            ifc_lite_core::IfcType::Unknown(_)
        ),
        "sanity: the BARE resolver must not know IFCDOORSTYLE, or this test \
         cannot tell the legacy-aware label from the literal one"
    );

    let (records, classes, handoff) =
        ifc_lite_processing::scan_shard_classified(bytes, 0, bytes.len());
    assert!(handoff.is_none(), "single shard must cover the whole fixture");
    let ids: Vec<u32> = records.iter().map(|&(id, _, _)| id).collect();
    let starts: Vec<u32> = records.iter().map(|&(_, s, _)| s as u32).collect();
    let lengths: Vec<u32> = records.iter().map(|&(_, s, e)| (e - s) as u32).collect();

    let style_idx = records
        .iter()
        .position(|&(_, s, e)| keyword_at(bytes, s, e) == "IFCDOORSTYLE")
        .expect("fixture must contain the IFCDOORSTYLE");
    assert!(
        classes[style_idx] & ifc_lite_processing::PREPASS_CLASS_FLAG_TYPE_CANDIDATE != 0,
        "IFCDOORSTYLE's shard class byte must carry the type-candidate flag (#3187)"
    );

    let disabled = rustc_hash::FxHashSet::default();
    let discovery = discover_from_columns(bytes, &ids, &starts, &lengths, &classes, &disabled);
    let style_id = records[style_idx].0;
    let labelled: Vec<_> = discovery
        .type_candidate_spans
        .iter()
        .filter(|&&(id, _, _, _)| id == style_id)
        .map(|&(_, _, _, ty)| ty)
        .collect();
    assert_eq!(
        labelled,
        vec![ifc_lite_core::IfcType::IfcDoorType],
        "the sharded walk must carry the legacy IfcDoorStyle forward as its base \
         type IfcDoorType, not as Unknown and not dropped; type_candidate_spans = {:?}",
        discovery.type_candidate_spans
    );
}

/// The geometry-JOB half of the same walk, and the sibling of the test
/// above. The type-candidate branch was made legacy-aware and this one was
/// not, so a keyword the gate admitted through the legacy-aware
/// `has_geometry_by_name` was then labelled by a bare `IfcType::from_str`
/// and reached the wire as `Unknown(crc32)`. `Unknown` carries a hash of
/// the keyword rather than the keyword, so no consumer can recover it
/// (#3179). This is the sharded path, which is the one large models take.
#[test]
fn sharded_column_discovery_labels_a_legacy_geometry_job_with_its_base_type() {
    let bytes = LEGACY_JOB_FIXTURE.as_bytes();
    // Anti-vacuity: if the generated enum ever learns this keyword, the
    // bare resolver returns the right type and this test passes with the
    // fix reverted.
    assert!(
        matches!(
            ifc_lite_core::IfcType::from_str("IFCBEAMSTANDARDCASE"),
            ifc_lite_core::IfcType::Unknown(_)
        ),
        "sanity: the BARE resolver must not know IFCBEAMSTANDARDCASE"
    );

    let (records, classes, handoff) =
        ifc_lite_processing::scan_shard_classified(bytes, 0, bytes.len());
    assert!(handoff.is_none(), "single shard must cover the whole fixture");
    let ids: Vec<u32> = records.iter().map(|&(id, _, _)| id).collect();
    let starts: Vec<u32> = records.iter().map(|&(_, s, _)| s as u32).collect();
    let lengths: Vec<u32> = records.iter().map(|&(_, s, e)| (e - s) as u32).collect();

    let beam_idx = records
        .iter()
        .position(|&(_, s, e)| keyword_at(bytes, s, e) == "IFCBEAMSTANDARDCASE")
        .expect("fixture must contain the IFCBEAMSTANDARDCASE");
    assert!(
        classes[beam_idx] & ifc_lite_processing::PREPASS_CLASS_FLAG_GEOMETRY_JOB != 0,
        "IFCBEAMSTANDARDCASE's shard class byte must carry the geometry-job flag, \
         else this test never reaches the branch it exists for (#3187)"
    );

    let disabled = rustc_hash::FxHashSet::default();
    let discovery = discover_from_columns(bytes, &ids, &starts, &lengths, &classes, &disabled);
    let beam_id = records[beam_idx].0;
    let labelled: Vec<_> = discovery
        .buffered_jobs
        .iter()
        .filter(|&&(id, _, _, _)| id == beam_id)
        .map(|&(_, _, _, ty)| ty)
        .collect();
    assert_eq!(
        labelled,
        vec![ifc_lite_core::IfcType::IfcBeam],
        "the sharded walk must label the legacy IFCBEAMSTANDARDCASE job as IfcBeam, \
         agreeing with the gate that admitted it; Unknown stores a hash of the \
         keyword rather than the keyword, so the label cannot be repaired later \
         from itself; buffered_jobs = {:?}",
        discovery.buffered_jobs
    );
}
