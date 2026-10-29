// SPDX-License-Identifier: MPL-2.0
//! Internal positional-wire adapter; public wasm-bindgen signatures stay fixed.

pub(super) struct BatchWire<'a> {
    pub jobs_flat: &'a [u32],
    pub unit_scale: f64,
    pub rtc_x: f64,
    pub rtc_y: f64,
    pub rtc_z: f64,
    pub needs_shift: bool,
    pub void_keys: &'a [u32],
    pub void_counts: &'a [u32],
    pub void_values: &'a [u32],
    pub style_ids: &'a [u32],
    pub style_colors: &'a [u8],
    pub plane_angle_to_radians: Option<f64>,
    pub material_element_ids: Option<Vec<u32>>,
    pub material_color_counts: Option<Vec<u32>>,
    pub material_colors_rgba: Option<Vec<u8>>,
}
