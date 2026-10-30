// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7782: cache lifetime over real decodes, with colliding ids across files.
use crate::api::IfcAPI;
use ifc_lite_core::EntityDecoder;
use ifc_lite_processing::element::OwnedMeshProductionData;

const PLAIN: &str = include_str!("../../../../processing/tests/fixtures/c4_bare_type_map_7782.ifc");

fn authored() -> String {
    PLAIN.replace("ENDSEC;\nEND-ISO", "\
#60=IFCMAPPEDITEM(#44,#45);
#61=IFCRELDEFINESBYTYPE('rel',$,$,$,(#1),#43);
#70=IFCMATERIAL('Layer',$,$);
#71=IFCMATERIALLAYER(#70,0.1,$);
#72=IFCMATERIALLAYER(#70,0.2,$);
#73=IFCMATERIALLAYERSET((#71,#72),'layers');
#74=IFCMATERIALLAYERSETUSAGE(#73,.AXIS2.,.POSITIVE.,0.);
#75=IFCRELASSOCIATESMATERIAL('material',$,$,$,(#43),#74);
#80=IFCIMAGETEXTURE(.T.,.T.,$,$,$,'first.png');
#81=IFCTEXTUREVERTEXLIST(((0.,0.),(1.,0.),(0.,1.)));
#82=IFCINDEXEDTRIANGLETEXTUREMAP((#80),#48,#81,((1,2,3)));
ENDSEC;\nEND-ISO")
}

fn check_rebuilt(api: &IfcAPI, source: &[u8], present: bool) {
    let mut decoder = EntityDecoder::new(source);
    assert_eq!(api.get_or_build_texture_index(source, &mut decoder).contains_key(&48), present);
    let plan = api.get_or_build_type_geometry_plan(source, &mut decoder);
    assert_eq!(plan.referenced_representation_maps.contains(&44), present);
    assert_eq!(plan.instantiated_type_ids.contains(&43), present);
    assert_eq!(api.get_or_build_material_layer_index(source, &mut decoder).get(43).is_some(), present);
}

// #8320 P3-2: exercise real builders/installs, then require every derived slot
// to be discarded, even when its cached value happens to be empty for this IFC.
fn warm_derived_slots(api: &IfcAPI, source: &[u8]) {
    check_rebuilt(api, source, true);
    let mut decoder = EntityDecoder::new(source);
    api.get_or_build_parts_to_skip(source, &mut decoder);
    api.get_or_build_indexed_colour_maps(source, &mut decoder);
    api.set_referenced_repmaps(&[44]);
    api.set_instantiated_type_ids(&[43]);
    api.set_mapped_instance_plan(&[44]);
    api.set_style_finishes(&[48], &[1.0, 0.1]);
    // A batch populates the mesh registries, wire styles, units and index through
    // the production path; no source-text or mock assertions stand in for it.
    api.process_geometry_batch(source, &[], 1.0, 0.0, 0.0, 0.0, false,
        &[], &[], &[], &[48], &[255, 255, 255, 255], None,
        None, None, None);
    // The column setters intentionally expire the type plan; warm it again.
    check_rebuilt(api, source, true);
    check_derived_slots(api, true, "warm");
}

fn check_derived_slots(api: &IfcAPI, populated: bool, install: &str) {
    macro_rules! check {
        ($($slot:ident),+ $(,)?) => {$(
            assert_eq!(api.content.$slot.lock().unwrap().is_some(), populated,
                "{install}: stale content cache {}", stringify!($slot));
        )+};
    }
    check!(cached_parts_to_skip, cached_material_layer_index,
        cached_referenced_repmaps, cached_instantiated_type_ids,
        cached_type_geometry_plan, cached_mapped_instance_plan,
        cached_texture_index, cached_indexed_colour_maps,
        cached_plane_angle_to_radians, cached_geometry_styles, style_finishes,
        cached_item_dedup, cached_mapped_item, cached_brep_signatures);
}

#[test]
fn c4_11a_install_rebuilds_texture_type_layer_caches_and_expires_snapshots_7782() {
    for install in ["once", "index", "rejected", "empty", "cleanup"] {
        let api = IfcAPI::new();
        warm_derived_slots(&api, authored().as_bytes());
        let old_index = api.content.cached_entity_index.lock().unwrap().clone().unwrap();
        let snapshot = api.content.production_model.snapshot(OwnedMeshProductionData::default());
        match install {
            "once" => { api.build_prepass_once_data(PLAIN.as_bytes()); }
            "index" => {
                let index = ifc_lite_core::ColumnarEntityIndex::from_scan(PLAIN.as_bytes()).unwrap();
                api.set_entity_index(index.ids(), index.starts(), index.lengths()).unwrap();
            }
            "rejected" => { assert!(api.set_entity_index(&[48], &[], &[]).is_err()); }
            "empty" => { api.set_entity_index(&[], &[], &[]).unwrap(); }
            _ => api.clear_pre_pass_cache(),
        }
        assert!(snapshot.validate_source().is_err(), "{install}: source epoch must expire");
        check_derived_slots(&api, false, install);
        let index = api.content.cached_entity_index.lock().unwrap().clone();
        if matches!(install, "once" | "index") {
            assert!(!std::sync::Arc::ptr_eq(&old_index, index.as_ref().unwrap()),
                "{install}: the installed index must replace the old one");
        } else {
            assert!(index.is_none(), "{install}: old index must be cleared");
        }
        check_rebuilt(&api, PLAIN.as_bytes(), false);
    }
}

#[test]
fn c4_11a_finish_transaction_survives_install_but_cleanup_abandons_it_7782() {
    let api = IfcAPI::new();
    api.set_style_finishes(&[48], &[1.0, 0.1]);
    api.set_prepass_geometry_finishes(&[48], &[0.5, 0.25]);
    api.set_source_bytes(PLAIN.as_bytes().to_vec());
    let source = api.source_bytes_arc();
    api.set_entity_index(&[], &[], &[]).unwrap();
    assert!(api.style_finishes_for(&[48]).is_none(), "same wire signature is a new file");
    assert!(std::sync::Arc::ptr_eq(&source, &api.source_bytes_arc()), "index preserves the source tier");
    let pending = api.take_pending_geometry_finishes();
    assert_eq!(pending[&48].roughness, Some(0.25), "only finalize consumes the staged input");
    assert!(api.take_pending_geometry_finishes().is_empty(), "consumed exactly once");
    api.set_prepass_geometry_finishes(&[48], &[0.5, 0.25]);
    api.clear_pre_pass_cache();
    assert!(api.take_pending_geometry_finishes().is_empty());
    assert!(api.source_bytes_arc().is_empty());
}

#[test]
fn c4_11a_source_after_columns_preserves_inputs_and_settings_7782() {
    let api = IfcAPI::new();
    api.set_entity_index(&[48], &[1], &[2]).unwrap();
    api.set_referenced_repmaps(&[44]);
    api.set_instantiated_type_ids(&[43]);
    api.set_merge_layers(true);
    api.set_skip_small_cuts(true);
    api.set_tessellation_quality(Some("highest".into())).unwrap();
    let snapshot = api.content.production_model.snapshot(OwnedMeshProductionData::default());
    api.set_source_bytes(PLAIN.as_bytes().to_vec());
    assert!(snapshot.validate_source().is_err());
    // Real type planning must still use the injected sets, even though PLAIN
    // has no mapped occurrence or rel-defines-by-type of its own.
    let mut decoder = EntityDecoder::new(PLAIN.as_bytes());
    let plan = api.get_or_build_type_geometry_plan(PLAIN.as_bytes(), &mut decoder);
    assert!(plan.referenced_representation_maps.contains(&44));
    assert!(plan.instantiated_type_ids.contains(&43));
    assert_eq!(api.content.cached_entity_index.lock().unwrap().as_ref().unwrap().lookup(48), Some((1, 3)));
    api.record_pipeline_batch(7, 0, 0, 0, 0, 0, 0, &Default::default());
    api.clear_pre_pass_cache();
    assert_eq!(api.pipeline_diagnostics.lock().unwrap().element_count, 7);
    assert!(api.merge_layers.load(std::sync::atomic::Ordering::Relaxed));
    assert!(api.skip_small_cuts());
    assert_eq!(api.tessellation_quality(), ifc_lite_geometry::TessellationQuality::Highest);
}
