// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7781: configuration affects geometry and admission, not just readback.
//! Scale, RTC, quality and local-frame behavior is also exercised through the
//! delegating `with_*` constructors in consolidate_unit_scale.rs,
//! the `with_rtc` router tests and tessellation_quality_test.rs.
//! styled_walk_tests.rs checks configured batch-local templates and placeholders.

use super::{GeometryRouter, RouterConfig};
use crate::kernel::mesh_volume::mesh_volume;
use crate::program::GeometryProgram;
use crate::{MaterialLayerIndex, SubMeshCollection, TessellationQuality};
use ifc_lite_core::EntityDecoder;
use std::sync::Arc;

const SOURCE: &str = "#1=IFCBLOCK($,2.,3.,4.);";

/// #7781 / #1286: keep Medium quality fixed so only the configured switch
/// decides whether a small solid-solid cut is executed. The cutter overlaps
/// the host by 0.25 x 0.5 x 0.5, removing exactly 0.0625 cubic units.
/// Run with the default cut ratio (unset `IFC_LITE_FAST_CUT_RATIO`).
#[test]
fn configured_small_cut_skip_changes_boolean_and_csg_volume() {
    let source = "#1=IFCBLOCK($,10.,10.,10.);\
        #2=IFCCARTESIANPOINT((9.75,4.,4.));#3=IFCAXIS2PLACEMENT3D(#2,$,$);\
        #4=IFCBLOCK(#3,0.5,0.5,0.5);\
        #5=IFCBOOLEANRESULT(.DIFFERENCE.,#1,#4);#6=IFCCSGSOLID(#5);";
    for skip_small_cuts in [false, true] {
        let router = GeometryRouter::from_config(RouterConfig {
            skip_small_cuts,
            local_frame: Some(false),
            ..RouterConfig::default()
        });
        for id in [5, 6] {
            let mut decoder = EntityDecoder::new(source);
            let item = decoder.decode_by_id(id).unwrap();
            let mesh = router.process_representation_item(&item, &mut decoder).unwrap();
            let expected = if skip_small_cuts { 1000.0 } else { 999.9375 };
            let actual = mesh_volume(&mesh);
            assert!(
                (actual - expected).abs() < 1e-3,
                "item #{id}, skip_small_cuts={skip_small_cuts}: volume {actual}, expected {expected}"
            );
            assert!(
                router.take_csg_failures().is_empty(),
                "the cut must succeed or be deliberately skipped"
            );
        }
    }
}

/// #7781 / #7678: sanitizing an invalid scale must never publish geometry in
/// metres; refusal must both suppress the mesh and report the dropped item.
#[test]
fn configured_invalid_scales_emit_no_mesh_and_report_unsupported() {
    for bad in [f64::NAN, 0.0, -1.0, f64::INFINITY] {
        let router = GeometryRouter::from_config(RouterConfig {
            unit_scale: bad,
            ..RouterConfig::default()
        });
        let mut decoder = EntityDecoder::new(SOURCE);
        let block = decoder.decode_by_id(1).unwrap();
        // The plain item entry reports failure to its caller; the styled
        // collection entry drops and counts that same item instead (#7781).
        router.process_representation_item(&block, &mut decoder)
            .expect_err("an invalid configured scale must not mesh in metres");
        let styled = GeometryProgram::styled_item(
            &block, SubMeshCollection::new(), false, None, router.rtc_offset(),
        ).drain_styled(&router, &mut decoder).unwrap();
        assert!(styled.is_empty(), "invalid scale {bad} must drop the styled item");
        assert_eq!(router.take_unsupported_items().get("IfcBlock"), Some(&1), "scale {bad}");
    }
}

/// #7781: configuration and cache injection finish before the first product;
/// meshing that product leaves its execution lease valid.
#[test]
fn a_configured_and_armed_router_keeps_its_lease_through_a_product() {
    let mut router = GeometryRouter::from_config(RouterConfig {
        unit_scale: 0.001,
        rtc_offset: (2_600_000.0, 1_200_000.0, 5.0),
        tessellation_quality: TessellationQuality::Low,
        local_frame: Some(true),
        skip_small_cuts: true,
        instancing_batch_local: true,
    });
    router.enable_content_dedup_shared(GeometryRouter::new_dedup_cache());
    router.enable_shared_mapped_item_cache(GeometryRouter::new_mapped_item_cache());
    router.enable_output_instancing(Arc::new(Default::default()));
    router.set_material_layer_index(Arc::new(MaterialLayerIndex::default()));
    let lease = router.try_execution_lease().unwrap();
    let mut decoder = EntityDecoder::new(SOURCE);
    let block = decoder.decode_by_id(1).unwrap();
    let mesh = router.process_representation_item(&block, &mut decoder).unwrap();
    assert_eq!(mesh.triangle_count(), 12, "the configured product materializes its block");
    lease.validate(router.execution_identity()).unwrap();
}
