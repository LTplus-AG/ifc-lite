// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::AppearanceRaster;

#[derive(Clone, Copy)]
pub(super) struct Raster<'a> {
    pub width: u32,
    pub height: u32,
    pub rgba: &'a [u8],
}
impl<'a> Raster<'a> {
    pub fn supplied(spec: &AppearanceRaster, payload: &'a [u8]) -> Result<Self, String> {
        let end = spec.byte_offset.checked_add(spec.byte_length).ok_or("Raster range overflow")?;
        let rgba = payload.get(spec.byte_offset..end).ok_or("Raster range exceeds supplied pixels")?;
        Self::new(spec.width, spec.height, rgba)
    }
    pub fn new(width: u32, height: u32, rgba: &'a [u8]) -> Result<Self, String> {
        let pixels = u64::from(width) * u64::from(height);
        if width == 0 || height == 0 || width > 8192 || height > 8192 || pixels > 16_777_216
            || pixels * 4 != rgba.len() as u64 {
            return Err("Raster needs valid RGBA8 dimensions within 8192 axes and 16 megapixels".into());
        }
        Ok(Self { width, height, rgba })
    }
    /// IFC UV is bottom-up; image rows are top-down. Repeat/clamp mirrors the
    /// existing surface sampler. This function is never used to clamp the page.
    pub fn sample(self, uv: [f64; 2], repeat: [bool; 2]) -> [f64; 4] {
        let axis = |v: f64, size: u32, wrap: bool| {
            let v = if wrap { v.rem_euclid(1.) } else { v.clamp(0., 1.) };
            let x = v * f64::from(size) - 0.5;
            let lower = x.floor() as i64;
            let index = |i: i64| if wrap { i.rem_euclid(i64::from(size)) as usize }
                else { i.clamp(0, i64::from(size) - 1) as usize };
            (index(lower), index(lower + 1), x - x.floor())
        };
        let (x0, x1, tx) = axis(uv[0], self.width, repeat[0]);
        let (y0, y1, ty) = axis(1. - uv[1], self.height, repeat[1]);
        std::array::from_fn(|channel| {
            let at = |x, y| f64::from(self.rgba[(y * self.width as usize + x) * 4 + channel]) / 255.;
            (at(x0, y0) * (1. - tx) + at(x1, y0) * tx) * (1. - ty)
                + (at(x0, y1) * (1. - tx) + at(x1, y1) * tx) * ty
        })
    }
}
pub(super) fn composite(page: Raster<'_>, page_uv: [f64; 2], background: [f64; 4]) -> [u8; 4] {
    // The page is a finite decal. Outside coordinates never reach its sampler.
    if page_uv.iter().any(|v| *v < 0. || *v > 1.) {
        return background.map(|v| (v.clamp(0., 1.) * 255.).round() as u8);
    }
    let foreground = page.sample(page_uv, [false, false]);
    let alpha = foreground[3] + background[3] * (1. - foreground[3]);
    std::array::from_fn(|i| {
        let value = if i == 3 { alpha } else if alpha == 0. { 0. }
            else { (foreground[i] * foreground[3] + background[i] * background[3] * (1. - foreground[3])) / alpha };
        (value.clamp(0., 1.) * 255.).round() as u8
    })
}
