// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Strict decoding of the browser mesh frame supplied to overlay extractors.

use ifc_lite_processing::MeshFrame;
use js_sys::{Array, Reflect};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(typescript_custom_section)]
const RTC_FRAME_TYPES: &'static str = r#"
/** Exact browser mesh RTC frame, in IFC Z-up metres. */
export interface RtcFrame {
  x: number;
  y: number;
  z: number;
  needsShift: boolean;
}
"#;

fn required_number(frame: &JsValue, name: &str) -> Result<f64, JsValue> {
    let value = Reflect::get(frame, &JsValue::from_str(name))?;
    let number = value
        .as_f64()
        .filter(|value| value.is_finite())
        .ok_or_else(|| {
            JsValue::from_str(&format!(
                "overlay RTC frame.{name} must be a finite number"
            ))
        })?;
    Ok(number)
}

/// Decode the exact four-field TypeScript `RtcFrame` without JavaScript's
/// scalar coercions. `needsShift: false` is authoritative even when the
/// inactive coordinates are non-zero; `true` accepts a zero anchor because a
/// caller-supplied federation frame is authoritative too.
pub(crate) fn parse_overlay_frame(value: &JsValue) -> Result<MeshFrame, JsValue> {
    if !value.is_object() || value.is_null() || Array::is_array(value) {
        return Err(JsValue::from_str(
            "overlay RTC frame must be a non-array object",
        ));
    }
    let x = required_number(value, "x")?;
    let y = required_number(value, "y")?;
    let z = required_number(value, "z")?;
    let needs_shift = Reflect::get(value, &JsValue::from_str("needsShift"))?
        .as_bool()
        .ok_or_else(|| JsValue::from_str("overlay RTC frame.needsShift must be a boolean"))?;
    Ok(if needs_shift {
        MeshFrame::ModelRtc { anchor: (x, y, z) }
    } else {
        MeshFrame::RawIfc
    })
}
