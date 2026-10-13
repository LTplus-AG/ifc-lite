// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Directional lateral admission after the ordinary exact plane lift.
use super::{Face, lift::{exact_on_plane_weld, exact_axis_plane_foot}};
use super::super::near_band::NearBand;

pub(super) fn bounded_weld(v: [f64; 3], face: &Face, d: f64, band: &NearBand) -> Option<[f64; 3]> {
    let mut w = exact_on_plane_weld(v, face.t)?;
    // #7292: edge-basis quantization must not move the weld
    // farther in-plane than the noise band in that direction.
    // In mm files the old unit-free step shifts a flush side
    // by micrometres and leaves metres of the host uncut.
    let scale = d / face.nn;
    let drift = [0, 1, 2].map(|k| w[k] - (v[k] - scale * face.n[k]));
    let drift2 = drift[0] * drift[0] + drift[1] * drift[1] + drift[2] * drift[2];
    // The face band measures NORMAL uncertainty. Lateral drift
    // must use its own direction: at native mm coordinates a
    // Y-ULP can exceed a mostly-Z plane band (#7292/#7468).
    let lateral_band2 = band.scaled_band2(drift, drift2);
    if !drift2.is_finite() || drift2 * drift2 > lateral_band2 {
        // Preserve every already-admitted ordinary weld. Only
        // a rejected axis-face candidate tries its exact foot.
        let foot = exact_axis_plane_foot(v, face.t)?;
        let fallback_drift=[0,1,2].map(|k|foot[k]-(v[k]-scale*face.n[k]));
        let fallback_drift2=fallback_drift.iter().map(|d|d*d).sum::<f64>();
        let fallback_band2=band.scaled_band2(fallback_drift,fallback_drift2);
        if !fallback_drift2.is_finite() || fallback_drift2*fallback_drift2>fallback_band2 {return None;}
        w=foot;
    }
    Some(w)
}
