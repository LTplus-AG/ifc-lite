// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #10698: a caller-supplied element colour carries the source the caller
//! decided with it. Passed as RGBA alone it is `Unavailable`: production does
//! not infer a style from the colour, and the finish join attaches none. The
//! plain entry's output is the styled entry's with the sources dropped.

use crate::element::*;
use crate::execution::{build_router, RouterCaches, SchedulerPolicy};
use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::{GeometryRouter, RouterConfig};

const SOURCE: &str = include_str!("../../tests/fixtures/c4_0_refusal_parity_7782.ifc");
const RGBA: [f32; 4] = [0.25, 0.5, 0.75, 1.0];

fn router() -> GeometryRouter {
    let caches = RouterCaches {
        items: GeometryRouter::new_dedup_cache(),
        brep_signatures: GeometryRouter::new_brep_signature_cache(),
        mapped_items: GeometryRouter::new_mapped_item_cache(),
    };
    build_router(RouterConfig::default(), SchedulerPolicy::PerBatch, caches, None, None, None)
}

/// Product #300 has geometry and no style, so every mesh falls back to the
/// element colour.
fn produce(element_color: Option<[f32; 4]>, element_style: StyleSource) -> (Vec<MeshData>, Vec<StyleSource>) {
    let mut decoder = EntityDecoder::new(SOURCE).with_strict_reals();
    decoder.seed_unit_scales(1.0, 1.0);
    let entity = decoder.decode_by_id(300).unwrap();
    let job = ElementMeshJob {
        id: 300, ifc_type: entity.ifc_type.clone(), entity: &entity, kind: ElementJobKind::Product,
        element_color, metadata: None,
    };
    let context = ProductionModel::new().snapshot(Default::default());
    let styled = produce_element_meshes_owned_styled(&job, element_style, &context, &MeshProductionOptions::default(),
        &mut decoder, &router()).unwrap();
    let (produced, styles, occurrence_styles) = styled.into_parts();
    assert_eq!(styles.len(), produced.meshes.len(), "one source per mesh");
    assert_eq!(occurrence_styles.len(), produced.instance_occurrences.len(), "one source per occurrence");
    (produced.meshes, styles)
}

#[test]
fn an_element_colour_passed_as_rgba_alone_has_unavailable_provenance() {
    let (meshes, styles) = produce(Some(RGBA), StyleSource::Unavailable);
    assert!(!meshes.is_empty(), "the fixture produces geometry");
    assert!(meshes.iter().all(|mesh| mesh.color == RGBA), "every mesh takes the element colour");
    assert!(styles.iter().all(|&style| style == StyleSource::Unavailable), "no style is inferred from the colour: {styles:?}");
    // No finish is attached for a colour of unknown provenance, even where a
    // style of that very colour authors one.
    let finishes: rustc_hash::FxHashMap<u32, crate::style::SpecularMaterial> =
        [(77, crate::style::SpecularMaterial { metallic: Some(1.0), roughness: Some(0.1) })].into_iter().collect();
    let join = crate::style::MeshFinishJoin::new(&finishes, |id| (id == 77).then_some(RGBA));
    assert!(styles.iter().all(|&style| join.finish_for_source(style).is_none()));
}

#[test]
fn an_element_colour_passed_with_its_source_carries_it() {
    let (meshes, styles) = produce(Some(RGBA), StyleSource::Style(77));
    assert!(meshes.iter().all(|mesh| mesh.color == RGBA));
    assert!(styles.iter().all(|&style| style == StyleSource::Style(77)), "{styles:?}");
}

#[test]
fn the_type_default_comes_from_no_style_whatever_the_caller_passes() {
    let (_, styles) = produce(None, StyleSource::Style(77));
    assert!(styles.iter().all(|&style| style == StyleSource::Unstyled), "{styles:?}");
}

#[test]
fn the_plain_entry_is_the_styled_entry_without_sources() {
    let (styled, _) = produce(Some(RGBA), StyleSource::Style(77));
    let mut decoder = EntityDecoder::new(SOURCE).with_strict_reals();
    decoder.seed_unit_scales(1.0, 1.0);
    let entity = decoder.decode_by_id(300).unwrap();
    let job = ElementMeshJob {
        id: 300, ifc_type: entity.ifc_type.clone(), entity: &entity, kind: ElementJobKind::Product,
        element_color: Some(RGBA), metadata: None,
    };
    let context = ProductionModel::new().snapshot(Default::default());
    let plain = produce_element_meshes_owned(&job, &context, &MeshProductionOptions::default(), &mut decoder, &router())
        .unwrap();
    assert_eq!(serde_json::to_vec(&plain.meshes).unwrap(), serde_json::to_vec(&styled).unwrap());
}
