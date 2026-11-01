// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955: the comparison indexes each model once (`checks::ModelSource`) and its oracles
//! take that shared source. Sharing must not change an answer: every shared entry point
//! equals the per-call `bytes` version it replaced, and the shared decoder and unit scale
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
    assert_eq!(ModelSource::new(MILLIMETRES.as_bytes(), &bundle).unit_scale(), 0.001);
}

#[test]
fn issue_7955_shared_layer_and_bounded_oracles_equal_their_per_call_versions() {
    let sources = extract_analytic_quantity_sources(OPENINGS.as_bytes(), None);
    let bundle = SourceBundle::new(OPENINGS.as_bytes().to_vec());
    let clips = ClipOracle::new(&bundle, &sources);
    let shared = layers::expected_in(&bundle, &clips, &sources, 248).expect("opened layered wall #248");
    let per_call = layers::expected(OPENINGS.as_bytes(), &sources, 248).unwrap();
    assert_eq!(format!("{shared:?}"), format!("{per_call:?}"));

    for (text, ids) in [(HALFSPACES, &[1000u32, 1004][..]), (CIRCLE_AND_OPENING, &[1062][..]), (MAPPED, &[173, 231][..])] {
        let sources = extract_analytic_quantity_sources(text.as_bytes(), None);
        let bundle = SourceBundle::new(text.as_bytes().to_vec());
        for &id in ids {
            assert!(bounded::applies_in(&bundle, id), "#{id}");
            assert_eq!(bounded::applies_in(&bundle, id), bounded::applies(text.as_bytes(), id));
            assert_eq!(bounded::unmodelled_reason_in(&bundle, id), bounded::unmodelled_reason(text.as_bytes(), id));
            let shared = bounded::expected_in(&bundle, &sources, id).expect("bounded expectation");
            let per_call = bounded::expected(text.as_bytes(), &sources, id).unwrap();
            assert_eq!((shared.host_volume, shared.section_volume, &shared.section_unavailable, shared.curved),
                (per_call.host_volume, per_call.section_volume, &per_call.section_unavailable, per_call.curved), "#{id}");
        }
    }
    // The per-call version now delegates to the shared one, so pin what the shared void scan
    // decides: #1062's authored opening makes the curved section unavailable; without it the
    // curved integral supplies the volume.
    let bundle = SourceBundle::new(CIRCLE_AND_OPENING.as_bytes().to_vec());
    let sources = extract_analytic_quantity_sources(CIRCLE_AND_OPENING.as_bytes(), None);
    let opened = bounded::expected_in(&bundle, &sources, 1062).unwrap();
    assert!(opened.section_volume.is_none() && opened.section_unavailable.is_some(), "opening must be found");
    let bundle = SourceBundle::new(CIRCLE_ONLY.as_bytes().to_vec());
    let sources = extract_analytic_quantity_sources(CIRCLE_ONLY.as_bytes(), None);
    assert!(bounded::expected_in(&bundle, &sources, 1062).unwrap().section_volume.is_some());
}

#[test]
fn issue_7955_shared_mapped_and_type_map_oracles_equal_their_per_call_versions() {
    let bundle = SourceBundle::new(MAPPED.as_bytes().to_vec());
    for cuts in [&[190u32][..], &[190, 190][..]] {
        let shared = mapped::opened_in(&bundle, 181, cuts).expect("mapped host #181");
        let per_call = mapped::opened(MAPPED.as_bytes(), 181, cuts).unwrap();
        assert_eq!(format!("{shared:?}"), format!("{per_call:?}"));
    }
    let bundle = SourceBundle::new(TYPE_MAPS.as_bytes().to_vec());
    let model = ModelSource::new(TYPE_MAPS.as_bytes(), &bundle);
    let sources = extract_analytic_quantity_sources(TYPE_MAPS.as_bytes(), None);
    let maps = canonical_type_maps(&bundle);
    let shared = type_maps::expected_with(model.decoder(), &sources, &maps[&105]).unwrap().expect("orphan type #105");
    let per_call = type_maps::expected(TYPE_MAPS.as_bytes(), &sources, &maps[&105]).unwrap().unwrap();
    assert_eq!(format!("{shared:?}"), format!("{per_call:?}"));
}

#[test]
fn issue_7955_shared_surface_maps_find_every_palette_and_texture() {
    // #8291 presentation fixture: palette and texture face sets.
    const PRESENTED: &str = include_str!("../../../tests/fixtures/synthetic-retained/f-t-face-set-presentation.ifc");
    use ifc_lite_retained_native::oracle::face_sets;
    let bundle = SourceBundle::new(PRESENTED.as_bytes().to_vec());
    let model = ModelSource::new(PRESENTED.as_bytes(), &bundle);
    let (mut palettes, mut textures, mut scanner) = (0, 0, EntityScanner::new(PRESENTED.as_bytes()));
    while let Some((id, name, ..)) = scanner.next_entity() {
        if !name.eq_ignore_ascii_case("IFCTRIANGULATEDFACESET") && !name.eq_ignore_ascii_case("IFCPOLYGONALFACESET") { continue; }
        let mut decoder = model.decoder();
        let item = decoder.decode_by_id(id).unwrap();
        let shared = face_sets::authored_surface_in(model.surface_maps(), &item, &mut decoder);
        let per_call = face_sets::authored_surface(PRESENTED.as_bytes(), &item, &mut EntityDecoder::new(PRESENTED.as_bytes()));
        assert_eq!((&shared.palette, &shared.uvs), (&per_call.palette, &per_call.uvs), "#{id}");
        palettes += usize::from(shared.palette.is_some());
        textures += usize::from(shared.uvs.is_some());
    }
    // The per-call version now reads the same span list, so pin that both kinds are found.
    assert!(palettes > 0 && textures > 0, "palettes {palettes}, textures {textures}");
}
