// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #5582: the `styleFinishes` wire decode, the per-mesh finish stamp keyed by
//! `geometry_item_id`, and the `setStyleFinishes` / `setPrepassGeometryFinishes`
//! state on a real `IfcAPI`.

use super::*;

fn steel() -> SpecularMaterial {
    SpecularMaterial { metallic: Some(1.0), roughness: Some(0.1) }
}

fn mesh_from_item(geometry_item_id: Option<u32>) -> MeshData {
    let mut mesh = MeshData::new(
        1,
        "IfcWindow".to_string(),
        vec![0.0, 0.0, 0.0],
        vec![0.0, 0.0, 1.0],
        vec![0],
        [0.5, 0.5, 0.5, 1.0],
    );
    mesh.geometry_item_id = geometry_item_id;
    mesh
}

// ───────────────────────────────────────────────────────────────────────────
// style_finishes_from_wire
// ───────────────────────────────────────────────────────────────────────────

/// Stride 2 and lane order: every float distinct, so a stride of 4 (the colour
/// wire's), a metallic/roughness swap, or a one-lane shift reads a different
/// number. The NaN/NaN style in the middle is absent, not zeroed; the one with
/// only roughness authored keeps metallic `None`.
#[test]
fn each_style_reads_its_own_metallic_roughness_pair() {
    let map = style_finishes_from_wire(&[10, 20, 30], &[1.0, 0.25, f32::NAN, f32::NAN, f32::NAN, 0.75]);
    assert_eq!(map.len(), 2, "#20 authored nothing");
    assert_eq!(map[&10], SpecularMaterial { metallic: Some(1.0), roughness: Some(0.25) });
    assert!(!map.contains_key(&20));
    assert_eq!(map[&30], SpecularMaterial { metallic: None, roughness: Some(0.75) });
}

/// Short, long and empty wires never read past the end: a style whose pair is
/// incomplete loses its finish and nothing else, and surplus floats past the
/// last id are ignored.
#[test]
fn a_malformed_finish_wire_keeps_only_complete_pairs() {
    let short = style_finishes_from_wire(&[10, 20], &[0.0, 0.5, 1.0]);
    assert_eq!(short.len(), 1, "#20 has one float of its pair");
    assert_eq!(short[&10], SpecularMaterial { metallic: Some(0.0), roughness: Some(0.5) });

    let long = style_finishes_from_wire(&[10], &[1.0, 0.1, 0.9, 0.9]);
    assert_eq!(long.len(), 1);
    assert_eq!(long[&10].roughness, Some(0.1), "the surplus pair belongs to no id");

    assert!(style_finishes_from_wire(&[1, 2], &[]).is_empty());
    assert!(style_finishes_from_wire(&[], &[0.5, 0.5]).is_empty());
    assert!(
        style_finishes_from_wire(&[1], &[f32::INFINITY, f32::NAN]).is_empty(),
        "a non-finite field is unauthored"
    );
}

// ───────────────────────────────────────────────────────────────────────────
// finish_for_geometry_item / mesh_js_with_finish — the per-mesh join
// ───────────────────────────────────────────────────────────────────────────

/// The join is `finishes[mesh.geometry_item_id]`: two meshes of one element
/// from different items take different finishes, a mesh with no item id takes
/// none, and an empty claim (a style that authored no specular) is no finish.
#[test]
fn a_mesh_takes_the_finish_of_its_own_representation_item() {
    let mut finishes = StyleFinishes::default();
    finishes.insert(10, steel());
    finishes.insert(11, SpecularMaterial { metallic: None, roughness: Some(0.9) });
    finishes.insert(12, SpecularMaterial::default());

    assert_eq!(finish_for_geometry_item(Some(10), Some(&finishes)), Some(steel()));
    assert_eq!(finish_for_geometry_item(Some(11), Some(&finishes)).and_then(|f| f.roughness), Some(0.9));
    assert_eq!(finish_for_geometry_item(Some(12), Some(&finishes)), None, "empty claim");
    assert_eq!(finish_for_geometry_item(Some(13), Some(&finishes)), None, "unstyled item");
    assert_eq!(finish_for_geometry_item(None, Some(&finishes)), None, "no item id");
    assert_eq!(finish_for_geometry_item(Some(10), None), None, "no finishes installed");
}

/// What JS reads: the `MeshDataJs.metallic/roughness` getters of the mesh the
/// batch hands over, stamped from the item's finish and otherwise `undefined`.
#[test]
fn the_js_mesh_reports_its_items_finish_through_the_getters() {
    let mut finishes = StyleFinishes::default();
    finishes.insert(10, steel());
    finishes.insert(11, SpecularMaterial { metallic: None, roughness: Some(0.9) });

    let js = mesh_js_with_finish(mesh_from_item(Some(10)), Some(&finishes));
    assert_eq!((js.metallic(), js.roughness()), (Some(1.0), Some(0.1)));

    let js = mesh_js_with_finish(mesh_from_item(Some(11)), Some(&finishes));
    assert_eq!((js.metallic(), js.roughness()), (None, Some(0.9)), "a half-authored finish stays half");

    for js in [
        mesh_js_with_finish(mesh_from_item(Some(99)), Some(&finishes)),
        mesh_js_with_finish(mesh_from_item(None), Some(&finishes)),
        mesh_js_with_finish(mesh_from_item(Some(10)), None),
    ] {
        assert_eq!((js.metallic(), js.roughness()), (None, None));
    }
}

/// #5582 through the Rust side of the boundary: the finish the prepass
/// resolved for a styled item, flattened by the function the wasm prepass
/// calls, decoded by the helper `setStyleFinishes` uses, and stamped by the one
/// the batch uses, lands on the mesh produced from that item. The
/// indexed-colour fallback id beside it is colour-only and stamps nothing.
#[test]
fn a_prepass_finish_reaches_the_mesh_built_from_its_item() {
    use ifc_lite_core::{EntityDecoder, EntityScanner};
    use ifc_lite_processing::prepass::{
        flat_styles_with_finishes, resolve_geometry_finishes, resolve_prepass, PrepassSpans,
        ResolveOptions,
    };
    let content = b"ISO-10303-21;\nDATA;\n\
        #1=IFCCOLOURRGB($,0.8,0.8,0.85);\n\
        #2=IFCSURFACESTYLERENDERING(#1,0.,$,$,$,$,IFCNORMALISEDRATIOMEASURE(0.9),$,.METAL.);\n\
        #3=IFCSURFACESTYLE('Brushed steel',.BOTH.,(#2));\n\
        #4=IFCSTYLEDITEM(#10,(#3),$);\n\
        ENDSEC;\nEND-ISO-10303-21;\n";
    let mut decoder = EntityDecoder::new(content);
    let mut spans = PrepassSpans::default();
    let mut scanner = EntityScanner::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        spans.stash(type_name, id, start, end);
    }
    let mut resolved = resolve_prepass(&spans, &mut decoder, ResolveOptions::default());
    resolved.indexed_colour_index.insert(11, [1.0, 0.0, 0.0, 1.0]);
    let geometry_finishes = resolve_geometry_finishes(&spans.styled_items, &mut decoder);
    let (ids, _colors, wire) = flat_styles_with_finishes(&resolved, &geometry_finishes, &mut decoder);
    assert_eq!(ids, vec![10, 11]);

    let api = IfcAPI::new();
    api.set_style_finishes(&ids, &wire);
    let installed = api.style_finishes_for(&ids).expect("installed for this style wire");

    let steel = mesh_js_with_finish(mesh_from_item(Some(10)), Some(&installed));
    assert_eq!(steel.metallic(), Some(1.0));
    assert!(steel.roughness().is_some_and(|r| (r - 0.1).abs() < 1e-6), "1 - 0.9 -> 0.1");
    let fallback = mesh_js_with_finish(mesh_from_item(Some(11)), Some(&installed));
    assert_eq!((fallback.metallic(), fallback.roughness()), (None, None));
}

// ───────────────────────────────────────────────────────────────────────────
// IfcAPI state
// ───────────────────────────────────────────────────────────────────────────

#[test]
fn finishes_apply_only_to_the_style_wire_they_were_set_for() {
    let api = IfcAPI::new();
    api.set_style_finishes(&[10, 20, 30], &[1.0, 0.1, f32::NAN, f32::NAN, f32::NAN, f32::NAN]);
    let finishes = api.style_finishes_for(&[10, 20, 30]).expect("same style wire");
    assert_eq!(finishes.get(&10), Some(&steel()));
    assert_eq!(finishes.len(), 1, "#20 and #30 authored nothing");
    assert!(
        api.style_finishes_for(&[10, 20]).is_none(),
        "another load's style wire must not inherit these finishes"
    );
    api.set_style_finishes(&[], &[]);
    assert!(api.style_finishes_for(&[10, 20, 30]).is_none(), "empty arrays clear the finishes");
}

#[test]
fn a_malformed_finish_wire_installs_what_is_complete_and_never_panics() {
    let api = IfcAPI::new();
    api.set_style_finishes(&[10, 20], &[1.0, 0.1, 0.5]);
    let finishes = api.style_finishes_for(&[10, 20]).expect("#10's pair is complete");
    assert_eq!(finishes.get(&10), Some(&steel()));
    assert!(!finishes.contains_key(&20));
}

#[test]
fn the_sharded_stash_is_consumed_once_and_cleared_between_loads() {
    let api = IfcAPI::new();
    api.set_prepass_geometry_finishes(&[10], &[1.0, 0.1]);
    assert_eq!(api.take_pending_geometry_finishes().get(&10), Some(&steel()));
    assert!(api.take_pending_geometry_finishes().is_empty(), "finalize consumes the stash");

    api.set_prepass_geometry_finishes(&[10], &[1.0, 0.1]);
    api.set_style_finishes(&[10], &[1.0, 0.1]);
    api.clear_pre_pass_cache();
    assert!(api.take_pending_geometry_finishes().is_empty());
    assert!(api.style_finishes_for(&[10]).is_none(), "clearPrePassCache ends the load's finishes");
}
