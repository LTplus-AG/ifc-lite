// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `RouterConfig`: `from_config` and the `with_*` constructors build the same
//! router, and `config()` reads back the effective values.

use super::{GeometryRouter, RouterConfig};
use crate::tessellation::TessellationQuality;

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
    assert!(!router.length_unit_refused());
}

#[test]
fn the_default_config_is_the_default_router() {
    assert_eq!(GeometryRouter::new().config(), &RouterConfig::default());
}

#[test]
fn constructors_and_setters_land_in_the_config() {
    let mut router = GeometryRouter::with_scale_and_rtc(0.001, (1.0, 2.0, 3.0));
    router.set_tessellation_quality(TessellationQuality::Low);
    router.set_skip_small_cuts(true);
    router.set_instancing_batch_local(true);
    let mut expected = RouterConfig { unit_scale: 0.001, rtc_offset: (1.0, 2.0, 3.0), ..RouterConfig::default() };
    expected.tessellation_quality = TessellationQuality::Low;
    expected.skip_small_cuts = true;
    expected.instancing_batch_local = true;
    assert_eq!(router.config(), &expected);
    assert_eq!(GeometryRouter::with_scale_and_local_frame(1.0, false).config().local_frame, Some(false));
}

#[test]
fn a_refused_scale_reads_back_as_one_and_refuses_the_router() {
    for bad in [f64::NAN, 0.0, -1.0, f64::INFINITY] {
        let router = GeometryRouter::from_config(RouterConfig { unit_scale: bad, ..RouterConfig::default() });
        assert!(router.length_unit_refused(), "{bad}");
        assert_eq!(router.config().unit_scale, 1.0);
    }
}
