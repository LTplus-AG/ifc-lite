// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! F2 (#8341): a type record the full decoder rejects is omitted from the
//! type-geometry plan visibly. Native reports it through
//! `ProcessingSink::on_omitted_type_records`, the browser through
//! `PipelineDiagnosticsReport::omitted_type_records`; both count distinct
//! records, never attempts, and never as an input-admission refusal.
mod common;

use common::entry_trace::{assert_ordering_contract, Event, Recorder};
use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
use ifc_lite_processing::{
    discovery::{Discovery, TypeGeometryPlan},
    element::TypeGeometryMode,
    process,
    scan::ScanClass,
    ProcessingRequest,
};

const FIXTURE: &[u8] = include_bytes!("fixtures/f2_omitted_type_record_8341.ifc");
/// `#500` fails the full decode (`INVALID`) yet its two maps scan readably.
const MALFORMED: u32 = 500;
const NEIGHBOUR: u32 = 100;

type Spans = Vec<(u32, usize, usize)>;
type Candidates = Vec<(u32, usize, usize, ifc_lite_core::IfcType)>;

fn spans(content: &[u8]) -> (Discovery, Spans, Spans, Candidates) {
    let mut discovery = Discovery::new(true);
    let (mut mapped, mut defines, mut candidates) = (Vec::new(), Vec::new(), Vec::new());
    let mut scanner = EntityScanner::new(content);
    while let Some((id, name, start, end)) = scanner.next_entity() {
        let class = ScanClass::classify(name);
        discovery.observe(content, class, id, name, start, end);
        match class {
            ScanClass::MappedItem => mapped.push((id, start, end)),
            ScanClass::RelDefinesByType => defines.push((id, start, end)),
            _ => {}
        }
        if let Some(ty) = ifc_lite_core::type_product_ifc_type(name) {
            candidates.push((id, start, end, ty));
        }
    }
    (discovery, mapped, defines, candidates)
}

#[test]
fn f2_native_reports_distinct_omitted_type_record_first_8341() {
    let mut sink = Recorder::default();
    let result = process(FIXTURE, &ProcessingRequest::full_pass(), &mut sink);
    assert_ordering_contract(&sink.events, "f2");
    assert_eq!(sink.events[0], Event::OmittedTypeRecords(vec![MALFORMED]));
    // Its two orphan maps were two doomed jobs (attempts); one record is
    // omitted and schedules nothing, exactly as if it were absent.
    let without = String::from_utf8(FIXTURE.to_vec()).unwrap().lines()
        .filter(|l| !l.starts_with("#500=")).collect::<Vec<_>>().join("\n");
    let clean = process(without.as_bytes(), &ProcessingRequest::full_pass(), &mut ());
    assert_eq!(result.metadata.geometry_entity_count, clean.metadata.geometry_entity_count);
    assert_eq!(format!("{:?}", result.meshes), format!("{:?}", clean.meshes), "mesh output unchanged");
    assert!(result.meshes.iter().any(|m| m.express_id == NEIGHBOUR && !m.indices.is_empty()));
    assert!(result.meshes.iter().any(|m| m.express_id == 31 && !m.indices.is_empty()));
    assert!(!result.meshes.iter().any(|m| m.express_id == MALFORMED));
    // A plain decode failure is not an S6a admission refusal (C4-10a).
    assert_eq!((result.stats.refused_input_elements, result.stats.refused_prepass_records), (0, 0));
}

#[test]
fn f2_clean_file_raises_no_event_8341() {
    let mut sink = Recorder::default();
    process(
        include_bytes!("fixtures/c4_type_geometry_modes_7782.ifc"),
        &ProcessingRequest::full_pass(),
        &mut sink,
    );
    assert!(!sink.events.iter().any(|e| matches!(e, Event::OmittedTypeRecords(_))));
}

#[test]
fn f2_native_and_browser_plans_omit_the_same_record_8341() {
    let (discovery, mapped, defines, candidates) = spans(FIXTURE);
    let mut native = TypeGeometryPlan::from_scan(
        discovery.types, discovery.mapped_item_plan, TypeGeometryMode::SuppressInstanced,
    );
    let before: Vec<_> = native.jobs().iter().map(|j| j.0).collect();
    assert_eq!(before.iter().filter(|&&id| id == MALFORMED).count(), 1, "planned before admission");
    let omitted_native = native.retain_decodable_products(&EntityDecoder::new(FIXTURE));

    let index = build_entity_index(FIXTURE);
    let mut decoder = EntityDecoder::with_index(FIXTURE, index).with_strict_reals();
    let mut browser =
        TypeGeometryPlan::from_spans(FIXTURE, &mapped, &defines, &[], &mut decoder, TypeGeometryMode::EmitTagged);
    let omitted_browser = browser.decode_products_reporting(FIXTURE, &candidates, &mut decoder);

    assert_eq!(omitted_native, [MALFORMED]);
    assert_eq!(omitted_browser, [MALFORMED], "one record although it has two maps");
    assert_eq!(native.jobs(), browser.jobs(), "the valid neighbour is planned on both");
    assert_eq!(browser.jobs().iter().map(|j| j.0).collect::<Vec<_>>(), [NEIGHBOUR]);
    assert_eq!(decoder.refused_records(), 0, "no admission refusal recorded");

    // A repeated read reports the record again; callers union identities, so a
    // per-load count stays one. Planning is unchanged by the re-read.
    let mut again =
        TypeGeometryPlan::from_spans(FIXTURE, &mapped, &defines, &[], &mut decoder, TypeGeometryMode::EmitTagged);
    assert_eq!(again.decode_products_reporting(FIXTURE, &candidates, &mut decoder), [MALFORMED]);
    assert_eq!(again.jobs(), browser.jobs());
}

#[test]
fn f2_counts_only_records_whose_mode_would_draw_a_map_8341() {
    // An instantiated malformed type draws only as an EmitTagged class-2 map:
    // SuppressInstanced loses nothing, so it omits (and reports) nothing.
    let content = String::from_utf8(FIXTURE.to_vec()).unwrap().replace(
        "ENDSEC;\nEND-ISO",
        "#200=IFCRELDEFINESBYTYPE('7777777777777777777200',$,$,$,(#31),#500);\nENDSEC;\nEND-ISO",
    );
    let content = content.as_bytes();
    let (_, mapped, defines, candidates) = spans(content);
    for (mode, expected) in [
        (TypeGeometryMode::EmitTagged, vec![MALFORMED]),
        (TypeGeometryMode::SuppressInstanced, vec![]),
    ] {
        let mut decoder = EntityDecoder::new(content);
        let mut plan = TypeGeometryPlan::from_spans(content, &mapped, &defines, &[], &mut decoder, mode);
        assert_eq!(plan.decode_products_reporting(content, &candidates, &mut decoder), expected, "{mode:?}");
    }
    let mut sink = Recorder::default();
    process(content, &ProcessingRequest::full_pass(), &mut sink);
    assert!(!sink.events.iter().any(|e| matches!(e, Event::OmittedTypeRecords(_))));
}
