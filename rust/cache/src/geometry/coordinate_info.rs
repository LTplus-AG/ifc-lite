// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `CoordinateInfo` in the geometry head (`sections/coordinate-info.ts`, v28):
//!
//!   originShift f64x3, originalBounds f64x6, shiftedBounds f64x6,
//!   hasLargeCoordinates u8,
//!   wasmRtcOffset: u8 flag + f64x3 (IFC Z-up),
//!   buildingRotation: u8 flag + f64,
//!   wasmRtcFrame: u8 flag + f64x3 + needsShift u8   (v20)
//!   boundsRecoveryFallbackCount: u8 flag + f64        (v24)
//!   lengthUnitScale: u8 flag + f64                    (v24)
//!   siteOrigin: u8 flag + f64x3 (IFC Z-up)            (v27, #9480)

use crate::buf::Buf;

/// The fewest bytes [`write`] can emit: every optional field absent. A
/// present option only ever adds bytes, so this is a true lower bound on any
/// head's `CoordinateInfo` — which is what [`super::section`] needs while it
/// is still appending chunks and does not yet know the info it will write.
pub(crate) const MIN_BYTES: usize = 15 * 8 + 1 + 6;

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct CoordinateInfo {
    /// Viewer Y-up.
    pub(crate) origin_shift: [f64; 3],
    /// Viewer Y-up `[min, max]`.
    pub(crate) original_bounds: [[f64; 3]; 2],
    pub(crate) shifted_bounds: [[f64; 3]; 2],
    pub(crate) has_large_coordinates: bool,
    /// IFC Z-up; present exactly when the vertices were re-based.
    pub(crate) wasm_rtc_offset: Option<[f64; 3]>,
    pub(crate) building_rotation: Option<f64>,
    /// `(frame, needsShift)`. The reader requires `needsShift` to equal
    /// `wasmRtcOffset`'s presence and, when set, the frame to equal it.
    pub(crate) wasm_rtc_frame: Option<([f64; 3], bool)>,
    pub(crate) bounds_recovery_fallback_count: Option<f64>,
    pub(crate) length_unit_scale: Option<f64>,
    /// IFC Z-up.
    pub(crate) site_origin: Option<[f64; 3]>,
}

fn vec3(buf: &mut Buf, value: [f64; 3]) {
    for axis in value {
        buf.f64(axis);
    }
}

fn optional_number(buf: &mut Buf, value: Option<f64>) {
    buf.u8(value.is_some() as u8);
    if let Some(value) = value {
        buf.f64(value);
    }
}

pub(crate) fn write(buf: &mut Buf, info: &CoordinateInfo) {
    vec3(buf, info.origin_shift);
    for bounds in [info.original_bounds, info.shifted_bounds] {
        vec3(buf, bounds[0]);
        vec3(buf, bounds[1]);
    }
    buf.u8(info.has_large_coordinates as u8);
    buf.u8(info.wasm_rtc_offset.is_some() as u8);
    if let Some(offset) = info.wasm_rtc_offset {
        vec3(buf, offset);
    }
    optional_number(buf, info.building_rotation);
    buf.u8(info.wasm_rtc_frame.is_some() as u8);
    if let Some((frame, needs_shift)) = info.wasm_rtc_frame {
        vec3(buf, frame);
        buf.u8(needs_shift as u8);
    }
    optional_number(buf, info.bounds_recovery_fallback_count);
    optional_number(buf, info.length_unit_scale);
    buf.u8(info.site_origin.is_some() as u8);
    if let Some(origin) = info.site_origin {
        vec3(buf, origin);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_optionals_cost_one_flag_byte_each() {
        let mut buf = Buf::new();
        write(&mut buf, &CoordinateInfo::default());
        // 3 + 6 + 6 f64, hasLarge, then six absent presence flags.
        assert_eq!(buf.len(), 15 * 8 + 1 + 6);
        assert_eq!(buf.len(), MIN_BYTES, "nothing a head can carry is smaller");
    }

    #[test]
    fn present_optionals_follow_their_flags_in_v28_order() {
        let info = CoordinateInfo {
            wasm_rtc_offset: Some([1.0, 2.0, 3.0]),
            wasm_rtc_frame: Some(([1.0, 2.0, 3.0], true)),
            length_unit_scale: Some(0.001),
            site_origin: Some([4.0, 5.0, 6.0]),
            ..CoordinateInfo::default()
        };
        let mut buf = Buf::new();
        write(&mut buf, &info);
        let bytes = buf.into_vec();
        assert_eq!(bytes.len(), 15 * 8 + 1 + (1 + 24) + 1 + (1 + 24 + 1) + 1 + (1 + 8) + (1 + 24));
        let tail = f64::from_le_bytes(bytes[bytes.len() - 8..].try_into().unwrap());
        assert_eq!(tail, 6.0, "siteOrigin is the last field");
    }
}
