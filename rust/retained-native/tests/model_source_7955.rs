// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955: the comparison indexes each model once (`checks::ModelSource`) and its oracles
//! take that shared source. Sharing must not change an answer: every shared entry point
//! returns the exact value the pre-#8595 per-call version returned (pinned below, since the
//! per-call versions now delegate to the shared ones), and the shared decoder and unit scale
//! equal what a fresh plain decoder resolves. Source-only, so no SMLib worker is needed.
#[allow(dead_code)]
#[path = "../examples/compare/metrics.rs"]
mod metrics;
#[allow(dead_code)]
#[path = "../examples/compare/checks/mod.rs"]
mod checks;

use checks::ModelSource;
use ifc_lite_core::{EntityDecoder, EntityScanner, SourceBundle};
use ifc_lite_processing::element::retained_runtime::canonical_type_maps;
use ifc_lite_processing::extract_analytic_quantity_sources;
use ifc_lite_retained_native::oracle::{bounded, clips::ClipOracle, layers, mapped, type_maps};

const MILLIMETRES: &str = include_str!("../../geometry/tests/fixtures/issue_5314_halfspace_edge.ifc");
const OPENINGS: &str = include_str!("../../../tests/fixtures/synthetic-retained/f-d-openings.ifc");
const HALFSPACES: &str = include_str!("../../../tests/fixtures/synthetic-retained/f-f-halfspaces.ifc");
const CIRCLE_AND_OPENING: &str = include_str!("../../../tests/fixtures/synthetic-retained/m6-equivalent-boundaries.ifc");
const CIRCLE_ONLY: &str = include_str!("../../../tests/fixtures/synthetic-retained/m6-equivalent-boundaries-no-opening.ifc");
const MAPPED: &str = include_str!("../../../tests/fixtures/synthetic-retained/f-e-mapped-booleans.ifc");
const TYPE_MAPS: &str = include_str!("../../geometry/tests/fixtures/issue_6446_mapped_source_frames.ifc");

#[test]
fn issue_7955_shared_decoder_and_unit_scale_equal_a_fresh_plain_decoder() {
    for text in [MILLIMETRES, OPENINGS, HALFSPACES] {
        let bundle = SourceBundle::new(text.as_bytes().to_vec());
        let model = ModelSource::new(text.as_bytes(), &bundle);
        let mut fresh = EntityDecoder::new(text.as_bytes());
        let units = ifc_lite_geometry::GeometryRouter::with_units(text.as_bytes(), &mut fresh).unit_scale();
        assert_eq!(model.unit_scale(), units);
        // The shared decoder's own lazily resolved model facts, not only its entities.
        let (mut shared, mut plain) = (model.decoder(), EntityDecoder::new(text.as_bytes()));
        assert_eq!(shared.length_unit_scale(), plain.length_unit_scale());
        assert_eq!(shared.plane_angle_to_radians(), plain.plane_angle_to_radians());
        assert_eq!(shared.project_id(), plain.project_id());
        let mut scanner = EntityScanner::new(text.as_bytes());
        let mut shared = model.decoder();
        let mut ids = 0;
        while let Some((id, ..)) = scanner.next_entity() {
            let expected = EntityDecoder::new(text.as_bytes()).decode_by_id(id).expect("fresh decode");
            let actual = shared.decode_by_id(id).expect("shared-index decode");
            assert_eq!((actual.id, actual.ifc_type), (expected.id, expected.ifc_type), "#{id}");
            assert_eq!(format!("{:?}", actual.attributes), format!("{:?}", expected.attributes), "#{id}");
            ids += 1;
        }
        assert!(ids > 20);
    }
    // A millimetre file, so a unit scale left at 1 cannot pass.
    let bundle = SourceBundle::new(MILLIMETRES.as_bytes().to_vec());
    let model = ModelSource::new(MILLIMETRES.as_bytes(), &bundle);
    assert_eq!(model.unit_scale(), 0.001);
    assert_eq!(model.decoder().length_unit_scale(), 0.001);
}

// Pinned from the pre-#8595 per-call implementations on main (ad10cb7147): each value is the
// exact `Debug` output of `layers::expected`, `bounded::{applies,unmodelled_reason,expected}`,
// `mapped::opened` and `face_sets::authored_surface` before they delegated to the shared
// versions. Since they now delegate, comparing against them here would compare a function with
// itself; these literals are the independent expectation.
// section_net (#7955, layered/voided PR): #248 is opened through section_net, and #1004 and
// #1062 now have sections (41 by the hand volume; the polygonised circle), as the oracle intends.
const PRE_PR_LAYERS_248: &str = "Some(LayerExpectation { volumes: [1.0000000000000002, 1.0000000000000002], opened_volume: 2.0000000000000004, curved: false })";
const PRE_PR_BOUNDED: [(&str, u32, &str); 5] = [
    (HALFSPACES, 1000, "applies=true reason=None expected=Some((64.0, Some(56.0), None, false))"),
    (HALFSPACES, 1004, "applies=true reason=None expected=Some((64.0, Some(41.0), None, false))"),
    (CIRCLE_AND_OPENING, 1062, "applies=true reason=None expected=Some((64.0, Some(62.179617653671436), None, true))"),
    (MAPPED, 173, "applies=true reason=None expected=Some((6.0, Some(3.0), None, false))"),
    (MAPPED, 231, "applies=true reason=None expected=Some((6.0, Some(3.0), None, false))"),
];
const PRE_PR_OPENED_181: [(&[u32], &str); 2] = [
    (&[190], "Some(OpeningExpectation { nominal_host_volume: 5.25, volume_bounds: [5.186, 5.25], result_volume: Some(5.186), host_bbox: Some([0.0, 0.0, 0.0, 2.0, 1.0, 3.0]), curved: false })"),
    (&[190, 190], "Some(OpeningExpectation { nominal_host_volume: 5.25, volume_bounds: [5.122, 5.25], result_volume: Some(5.186), host_bbox: Some([0.0, 0.0, 0.0, 2.0, 1.0, 3.0]), curved: false })"),
];
const PRE_PR_SURFACES: [(u32, &str); 4] = [
    (9, "Some([0, 1, 2, 0, 1, 2, 1, 2, 0, 2, 0, 1]) None"),
    (19, "None Some([[[0.125, 0.25], [0.75, 0.9375], [0.3125, 0.5]], [[0.5625, 0.1875], [0.875, 0.0625], [0.0625, 0.8125]], [[0.3125, 0.5], [0.125, 0.25], [0.75, 0.9375]], [[0.0625, 0.8125], [0.5625, 0.1875], [0.875, 0.0625]], [[0.75, 0.9375], [0.3125, 0.5], [0.125, 0.25]], [[0.875, 0.0625], [0.0625, 0.8125], [0.5625, 0.1875]], [[0.125, 0.25], [0.75, 0.9375], [0.3125, 0.5]], [[0.5625, 0.1875], [0.875, 0.0625], [0.0625, 0.8125]], [[0.3125, 0.5], [0.125, 0.25], [0.75, 0.9375]], [[0.0625, 0.8125], [0.5625, 0.1875], [0.875, 0.0625]], [[0.75, 0.9375], [0.3125, 0.5], [0.125, 0.25]], [[0.875, 0.0625], [0.0625, 0.8125], [0.5625, 0.1875]]])"),
    (30, "Some([0, 1, 2, 0, 1, 2, 1, 2, 0, 2, 0, 1]) None"),
    (48, "None Some([[[0.125, 0.25], [0.75, 0.9375], [0.3125, 0.5]], [[0.5625, 0.1875], [0.875, 0.0625], [0.0625, 0.8125]], [[0.3125, 0.5], [0.125, 0.25], [0.75, 0.9375]], [[0.0625, 0.8125], [0.5625, 0.1875], [0.875, 0.0625]], [[0.75, 0.9375], [0.3125, 0.5], [0.125, 0.25]], [[0.875, 0.0625], [0.0625, 0.8125], [0.5625, 0.1875]], [[0.125, 0.25], [0.75, 0.9375], [0.3125, 0.5]], [[0.5625, 0.1875], [0.875, 0.0625], [0.0625, 0.8125]], [[0.3125, 0.5], [0.125, 0.25], [0.75, 0.9375]], [[0.0625, 0.8125], [0.5625, 0.1875], [0.875, 0.0625]], [[0.75, 0.9375], [0.3125, 0.5], [0.125, 0.25]], [[0.875, 0.0625], [0.0625, 0.8125], [0.5625, 0.1875]]])"),
];

#[test]
fn issue_7955_shared_layer_and_bounded_oracles_match_the_pre_pr_values() {
    let sources = extract_analytic_quantity_sources(OPENINGS.as_bytes(), None);
    let bundle = SourceBundle::new(OPENINGS.as_bytes().to_vec());
    let clips = ClipOracle::new(&bundle, &sources);
    assert_eq!(format!("{:?}", layers::expected_in(&bundle, &clips, &sources, 248)), PRE_PR_LAYERS_248);

    for (text, id, pinned) in PRE_PR_BOUNDED {
        let sources = extract_analytic_quantity_sources(text.as_bytes(), None);
        let bundle = SourceBundle::new(text.as_bytes().to_vec());
        let expected = bounded::expected_in(&bundle, &sources, id)
            .map(|e| (e.host_volume, e.section_volume, e.section_unavailable, e.curved));
        let actual = format!("applies={} reason={:?} expected={:?}",
            bounded::applies_in(&bundle, id), bounded::unmodelled_reason_in(&bundle, id), expected);
        assert_eq!(actual, pinned, "#{id}");
    }
    // The per-call version now delegates to the shared one, so pin what the shared void scan
    // decides: #1062's authored opening is removed from the section; without it the curved
    // integral supplies the larger volume.
    let bundle = SourceBundle::new(CIRCLE_AND_OPENING.as_bytes().to_vec());
    let sources = extract_analytic_quantity_sources(CIRCLE_AND_OPENING.as_bytes(), None);
    let opened = bounded::expected_in(&bundle, &sources, 1062).unwrap();
    let opened_volume = opened.section_volume.expect("the opening is in the section family");
    let bundle = SourceBundle::new(CIRCLE_ONLY.as_bytes().to_vec());
    let sources = extract_analytic_quantity_sources(CIRCLE_ONLY.as_bytes(), None);
    let whole = bounded::expected_in(&bundle, &sources, 1062).unwrap().section_volume.expect("the curved integral");
    assert!(opened_volume < whole, "the shared scan found the opening: {opened_volume} vs {whole}");
}

#[test]
fn issue_7955_shared_mapped_and_type_map_oracles_match_the_pre_pr_values() {
    let bundle = SourceBundle::new(MAPPED.as_bytes().to_vec());
    for (cuts, pinned) in PRE_PR_OPENED_181 {
        assert_eq!(format!("{:?}", mapped::opened_in(&bundle, 181, cuts)), pinned, "{cuts:?}");
    }
    // `type_maps::expected` still builds its own plain decoder, independent of the shared one.
    let bundle = SourceBundle::new(TYPE_MAPS.as_bytes().to_vec());
    let model = ModelSource::new(TYPE_MAPS.as_bytes(), &bundle);
    let sources = extract_analytic_quantity_sources(TYPE_MAPS.as_bytes(), None);
    let maps = canonical_type_maps(&bundle);
    let shared = type_maps::expected_with(model.decoder(), &sources, &maps[&105]).unwrap().expect("orphan type #105");
    let per_call = type_maps::expected(TYPE_MAPS.as_bytes(), &sources, &maps[&105]).unwrap().unwrap();
    assert_eq!(format!("{shared:?}"), format!("{per_call:?}"));
}

#[test]
fn issue_7955_shared_surface_maps_match_the_pre_pr_values() {
    // #8291 presentation fixture: two palette and two texture face sets.
    const PRESENTED: &str = include_str!("../../../tests/fixtures/synthetic-retained/f-t-face-set-presentation.ifc");
    use ifc_lite_retained_native::oracle::face_sets;
    let bundle = SourceBundle::new(PRESENTED.as_bytes().to_vec());
    let model = ModelSource::new(PRESENTED.as_bytes(), &bundle);
    let mut ids = Vec::new();
    let mut scanner = EntityScanner::new(PRESENTED.as_bytes());
    while let Some((id, name, ..)) = scanner.next_entity() {
        if !name.eq_ignore_ascii_case("IFCTRIANGULATEDFACESET") && !name.eq_ignore_ascii_case("IFCPOLYGONALFACESET") { continue; }
        let mut decoder = model.decoder();
        let item = decoder.decode_by_id(id).unwrap();
        let surface = face_sets::authored_surface_in(model.surface_maps(), &item, &mut decoder);
        let pinned = PRE_PR_SURFACES.iter().find(|(pinned, _)| *pinned == id).map(|(_, value)| *value);
        assert_eq!(Some(format!("{:?} {:?}", surface.palette, surface.uvs)).as_deref(), pinned, "#{id}");
        ids.push(id);
    }
    assert_eq!(ids, PRE_PR_SURFACES.map(|(id, _)| id));
}
