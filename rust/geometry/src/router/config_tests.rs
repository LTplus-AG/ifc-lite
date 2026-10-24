// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `RouterConfig`: `from_config` and the `with_*` constructors build the same
//! router, `config()` reads back the effective values, and every configuration
//! setter advances the execution generation.

use super::{GeometryRouter, RouterConfig};
use crate::tessellation::TessellationQuality;
use ifc_lite_core::execution_owner::ExecutionLeaseError;
use ifc_lite_core::EntityDecoder;

fn full() -> RouterConfig {
    RouterConfig {
        unit_scale: 0.001,
        rtc_offset: (2_600_000.0, 1_200_000.0, 5.0),
        tessellation_quality: TessellationQuality::Low,
        local_frame: Some(true),
        skip_small_cuts: true,
        instancing_batch_local: true,
    }
}

#[test]
fn from_config_round_trips_every_field() {
    let router = GeometryRouter::from_config(full());
    assert_eq!(router.config(), &full());
    assert_eq!(
        (router.unit_scale(), router.rtc_offset(), router.skip_small_cuts()),
        (0.001, (2_600_000.0, 1_200_000.0, 5.0), true)
    );
    assert_eq!(router.tessellation_quality(), TessellationQuality::Low);
    assert!(router.instancing_batch_local());
    assert!(router.local_frame_enabled());
    assert!(router.has_rtc_offset());
    assert!(!router.length_unit_refused());
}

#[test]
fn the_default_config_is_the_default_router() {
    assert_eq!(GeometryRouter::new().config(), &RouterConfig::default());
    assert_eq!(GeometryRouter::default().config(), &RouterConfig::default());
    let configured = GeometryRouter::from_config(RouterConfig::default());
    assert_eq!(configured.config(), &RouterConfig::default());
}

#[test]
fn the_with_constructors_are_config_delegates() {
    let d = RouterConfig::default;
    let rtc = (1.0, 2.0, 3.0);
    let low = TessellationQuality::Low;
    let mm = 0.001;
    let cases = [
        (GeometryRouter::with_scale(mm), RouterConfig { unit_scale: mm, ..d() }),
        (
            GeometryRouter::with_scale_and_local_frame(1.0, false),
            RouterConfig { local_frame: Some(false), ..d() },
        ),
        (GeometryRouter::with_rtc(rtc), RouterConfig { rtc_offset: rtc, ..d() }),
        (
            GeometryRouter::with_scale_and_rtc(mm, rtc),
            RouterConfig { unit_scale: mm, rtc_offset: rtc, ..d() },
        ),
        (GeometryRouter::with_quality(low), RouterConfig { tessellation_quality: low, ..d() }),
        (
            GeometryRouter::with_scale_and_quality(mm, low),
            RouterConfig { unit_scale: mm, tessellation_quality: low, ..d() },
        ),
    ];
    for (router, expected) in cases {
        assert_eq!(router.config(), &expected);
        assert_eq!(GeometryRouter::from_config(expected.clone()).config(), &expected);
    }
}

#[test]
fn setters_land_in_the_config() {
    let mut router = GeometryRouter::with_scale_and_rtc(0.001, (1.0, 2.0, 3.0));
    router.set_tessellation_quality(TessellationQuality::Low);
    router.set_skip_small_cuts(true);
    router.set_instancing_batch_local(true);
    router.set_rtc_offset((4.0, 5.0, 6.0));
    let expected = RouterConfig {
        unit_scale: 0.001,
        rtc_offset: (4.0, 5.0, 6.0),
        tessellation_quality: TessellationQuality::Low,
        local_frame: None,
        skip_small_cuts: true,
        instancing_batch_local: true,
    };
    assert_eq!(router.config(), &expected);
}

#[test]
fn a_refused_scale_reads_back_as_one_and_refuses_the_router() {
    for bad in [f64::NAN, 0.0, -1.0, f64::INFINITY] {
        let config = RouterConfig { unit_scale: bad, ..RouterConfig::default() };
        let router = GeometryRouter::from_config(config);
        assert!(router.length_unit_refused(), "{bad}");
        assert_eq!(router.config().unit_scale, 1.0);
    }
}

const SOURCE: &str = "#1=IFCBLOCK($,2.,3.,4.);";

/// #8091: a configuration change while a product holds the lease refuses that
/// product's publication, whichever setter made it.
#[test]
fn every_config_setter_invalidates_an_outstanding_lease() {
    let changes: [fn(&mut GeometryRouter); 4] = [
        |router| router.set_tessellation_quality(TessellationQuality::High),
        |router| router.set_skip_small_cuts(true),
        |router| router.set_rtc_offset((10., 20., 30.)),
        |router| router.set_instancing_batch_local(true),
    ];
    for change in changes {
        let mut router = GeometryRouter::from_config(RouterConfig::default());
        let lease = router.try_execution_lease().unwrap();
        change(&mut router);
        assert_eq!(
            lease.validate(router.execution_identity()),
            Err(ExecutionLeaseError::ConfigurationChanged)
        );
    }
}

/// `from_config` and cache injection finish before the first product: once
/// leased, meshing that product leaves the lease valid.
#[test]
fn a_configured_and_armed_router_keeps_its_lease_through_a_product() {
    let mut router = GeometryRouter::from_config(full());
    router.enable_content_dedup_shared(GeometryRouter::new_dedup_cache());
    router.enable_shared_mapped_item_cache(GeometryRouter::new_mapped_item_cache());
    let lease = router.try_execution_lease().unwrap();
    let mut decoder = EntityDecoder::new(SOURCE);
    let block = decoder.decode_by_id(1).unwrap();
    assert!(!router.process_representation_item(&block, &mut decoder).unwrap().is_empty());
    lease.validate(router.execution_identity()).unwrap();
    assert_eq!(router.config(), &full());
}
