// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::api::IfcAPI;
use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::GeometryRouter;

fn brep(base: u32, width: f64) -> String {
    let n = |id| base + id;
    format!(
        "#{}=IFCCARTESIANPOINT((0.,0.,0.));\n#{}=IFCCARTESIANPOINT(({width},0.,0.));\n\
        #{}=IFCCARTESIANPOINT((0.,1.,0.));\n#{}=IFCPOLYLOOP((#{},#{},#{}));\n\
        #{}=IFCFACEOUTERBOUND(#{},.T.);\n#{}=IFCFACE((#{}));\n\
        #{}=IFCCLOSEDSHELL((#{}));\n#{}=IFCFACETEDBREP(#{});\n",
        n(1),
        n(2),
        n(3),
        n(4),
        n(1),
        n(2),
        n(3),
        n(5),
        n(4),
        n(6),
        n(5),
        n(7),
        n(6),
        n(8),
        n(7)
    )
}

fn cached_router(api: &IfcAPI) -> GeometryRouter {
    ifc_lite_processing::execution::build_router(
        Default::default(), ifc_lite_processing::execution::ExecutionPolicy::PerBatch,
        &api.batch_caches(), None, None, None,
    )
}

fn widths(api: &IfcAPI, content: &[u8], ids: &[u32]) -> Vec<f32> {
    let mut router = cached_router(api);
    // Isolate signature lifetime from the independent item-mesh cache lifetime.
    router.enable_content_dedup_shared(GeometryRouter::new_dedup_cache());
    let mut decoder = EntityDecoder::new(content);
    ids.iter()
        .map(|&id| {
            let item = decoder.decode_by_id(id).unwrap();
            let mesh = router
                .process_representation_item(&item, &mut decoder)
                .unwrap();
            assert!(!mesh.positions.is_empty());
            mesh.positions
                .chunks_exact(3)
                .map(|p| p[0])
                .fold(f32::NEG_INFINITY, f32::max)
        })
        .collect()
}

#[test]
fn c4_10a_brep_cache_invalidates_colliding_ids_at_every_source_install_7782() {
    let first = brep(0, 1.0);
    // #8 changed, #108 has the old shape: stale #8's signature would alias these
    // different meshes in the second file's dedup cache.
    let second = brep(0, 2.0) + &brep(100, 1.0);
    for reset in 0..5 {
        let api = IfcAPI::new();
        assert_eq!(widths(&api, first.as_bytes(), &[8]), [1.0]);
        match reset {
            0 => api.clear_pre_pass_cache(),
            1 => api.set_entity_index(&[], &[], &[]).unwrap(),
            2 => api.set_source_bytes(second.as_bytes().to_vec()),
            3 => {
                api.build_prepass_once_data(second.as_bytes());
            }
            _ => {
                assert!(api.set_entity_index(&[8], &[], &[]).is_err());
            }
        }
        assert_eq!(
            widths(&api, second.as_bytes(), &[8, 108]),
            [2.0, 1.0],
            "reset {reset}"
        );
    }
}

#[test]
fn c4_10a_warm_router_reuses_brep_walk_across_batches_7782() {
    let api = IfcAPI::new();
    let content = brep(0, 1.0);
    for warm in [false, true] {
        let router = cached_router(&api);
        let mut decoder = EntityDecoder::new(content.as_bytes());
        let item = decoder.decode_by_id(8).unwrap();
        let mesh = router
            .process_representation_item(&item, &mut decoder)
            .unwrap();
        assert!(!mesh.positions.is_empty());
        let (hits, misses) = decoder.point_cache_stats();
        if warm {
            assert_eq!(hits + misses, 0, "completed signature avoids point walk");
        } else {
            assert!(hits + misses > 0);
        }
    }
}

fn run(
    api: &IfcAPI,
    content: &[u8],
    pre: &super::super::prepass_once::PrepassOnceData,
    jobs: &[u32],
) {
    let (x, y, z) = pre.meta.frame.rtc_offset();
    api.produce_batch(content, &super::super::batch_wire::BatchWire {
            jobs_flat: jobs,
            unit_scale: super::super::prepass_sharded::stream_meta_unit_scale(&pre.meta),
            rtc_x: x,
            rtc_y: y,
            rtc_z: z,
            needs_shift: pre.meta.frame.needs_shift(),
            void_keys: &pre.void_keys,
            void_counts: &pre.void_counts,
            void_values: &pre.void_values,
            style_ids: &pre.style_ids,
            style_colors: &pre.style_colors,
            plane_angle_to_radians: Some(pre.meta.plane_angle_to_radians),
            material_element_ids: Some(pre.material_element_ids.clone()),
            material_color_counts: Some(pre.material_color_counts.clone()),
            material_colors_rgba: Some(pre.material_colors.clone()),
        }, false);
}

#[test]
fn c4_10a_refusals_are_per_attempt_and_distinct_per_load_7782() {
    let source = include_str!("../../../../processing/tests/fixtures/c4_0_refusal_parity_7782.ifc");
    // F2: scanner recognizes a type and its maps, full decoder refuses the token.
    let source = source.replace("ENDSEC;\nEND-ISO", "#400=IFCWALL('bad',$,$,$,INVALID,#5,#303,$,.NOTDEFINED.);\n#500=IFCBOILERTYPE('bad',$,$,$,INVALID,$,(#501),$,$,.NOTDEFINED.);\n#501=IFCREPRESENTATIONMAP(#4,#302);\nENDSEC;\nEND-ISO");
    let api = IfcAPI::new();
    let pre = api.build_prepass_once_data(source.as_bytes());
    assert!(
        !pre.complex_jobs.iter().any(|j| j.0 == 500),
        "undecodable type stays omitted"
    );
    let mut jobs = vec![0; pre.total_jobs() * 3];
    pre.write_jobs(|i, v| jobs[i as usize] = v);
    // Deliberately repeat the two bad-leaf attempts in another batch. The good
    // neighbour follows failures and must never inherit a cumulative refusal.
    run(&api, source.as_bytes(), &pre, &jobs);
    let first = api.pipeline_diagnostics.lock().unwrap().clone();
    assert_eq!(first.refused_input_elements, 3);
    assert_eq!(first.refused_prepass_records, 3); // #101, #400, #500
    run(&api, source.as_bytes(), &pre, &jobs);
    let second = api.pipeline_diagnostics.lock().unwrap().clone();
    assert_eq!(second.refused_input_elements, 6);
    assert_eq!(second.refused_prepass_records, 3);
    api.clear_pre_pass_cache();
    assert_eq!(
        api.pipeline_diagnostics
            .lock()
            .unwrap()
            .refused_prepass_records,
        3
    );
    api.build_prepass_once_data(include_bytes!(
        "../../../../processing/tests/fixtures/c4_bare_type_map_7782.ifc"
    ));
    let new = api.pipeline_diagnostics.lock().unwrap();
    assert_eq!(new.refused_input_elements, 0);
    assert_eq!(new.refused_prepass_records, 0);
}

#[test]
fn c4_10a_refused_unit_counts_each_attempt_without_geometry_7782() {
    let source = include_str!("../../../../processing/tests/fixtures/c4_0_refusal_parity_7782.ifc")
        .replace("#8=IFCUNITASSIGNMENT((#7));", "#8=IFCUNITASSIGNMENT((#800));\n#800=IFCCONVERSIONBASEDUNIT(#803,.LENGTHUNIT.,'CUSTOM',#801);\n#801=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(1.E400),#7);\n#803=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);");
    let api = IfcAPI::new();
    let pre = api.build_prepass_once_data(source.as_bytes());
    assert_eq!(pre.meta.length_unit_refused, Some(801));
    let mut jobs = vec![0; pre.total_jobs() * 3];
    pre.write_jobs(|i, v| jobs[i as usize] = v);
    run(&api, source.as_bytes(), &pre, &jobs);
    let diag = api.pipeline_diagnostics.lock().unwrap();
    assert_eq!(diag.refused_input_elements, pre.total_jobs() as u64);
    assert!(diag.refused_prepass_records >= 1);
    assert_eq!(diag.mesh_count, 0);
}
