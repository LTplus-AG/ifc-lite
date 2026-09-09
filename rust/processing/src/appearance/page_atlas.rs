// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::page_raster::{composite, Raster};

pub(super) const MAX_PIXELS: usize = 16_777_216;
const AXIS: usize = 4096;
const PAD: f64 = 2.5;
struct Chart { xy: [[f64; 2]; 3], size: [usize; 2], origin: [usize; 2] }
pub(super) struct Atlas {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
    pub uv: Vec<[f64; 2]>,
}
pub(super) struct AtlasInput<'a> {
    pub positions: &'a [[f64; 3]],
    pub triangles: &'a [[u32; 3]],
    pub page_uv: &'a [[f64; 2]],
    pub page_indices: &'a [[u32; 3]],
    pub old_uv: Option<(&'a [[f32; 2]], &'a [[u32; 3]])>,
    pub old_raster: Option<(Raster<'a>, [bool; 2])>,
    pub color: [f32; 4],
    pub metres_per_unit: f64,
    pub density: f64,
    pub page: Raster<'a>,
}
fn chart(points: [[f64; 3]; 3], density: f64) -> Result<Chart, String> {
    let delta = |a: usize, b: usize| std::array::from_fn::<_, 3, _>(|i| points[b][i] - points[a][i]);
    let dot = |a: [f64; 3], b: [f64; 3]| a.iter().zip(b).map(|(a, b)| a * b).sum::<f64>();
    let mut order = [0, 1, 2];
    let mut longest = 0.;
    for a in 0..3 { let b = (a + 1) % 3; let d = delta(a, b); let length = dot(d, d);
        if length > longest { longest = length; order = [a, b, (a + 2) % 3]; } }
    let [a, b, c] = order;
    let length = longest.sqrt();
    let mut xy = [[0.; 2]; 3];
    if length > 0. {
        let ac = delta(a, c);
        let x = dot(ac, delta(a, b)) / length;
        let height = (dot(ac, ac) - x * x).max(0.).sqrt();
        xy[b] = [length * density, 0.]; xy[c] = [x * density, height * density];
    }
    let min_x = xy.iter().map(|v| v[0]).fold(0., f64::min);
    for p in &mut xy { p[0] += PAD - min_x; p[1] += PAD; }
    let mut size = [0; 2];
    for axis in 0..2 {
        let extent = xy.iter().map(|p| p[axis]).fold(0., f64::max) + PAD;
        if !extent.is_finite() || extent > AXIS as f64 { return Err("Page atlas chart exceeds 4096 pixels; lower texelsPerMetre".into()); }
        size[axis] = (extent.ceil() as usize).max(6);
    }
    Ok(Chart { xy, size, origin: [0, 0] })
}
fn layout(charts: &mut [Chart], budget: usize) -> Result<[usize; 2], String> {
    let area = charts.iter().try_fold(0usize, |sum, c| sum.checked_add(c.size[0] * c.size[1])).ok_or("Atlas area overflow")?;
    if area > budget { return Err("Page atlas exceeds remaining pixel budget; lower texelsPerMetre or choose fewer objects".into()); }
    let widest = charts.iter().map(|c| c.size[0]).max().unwrap_or(1);
    let mut width = ((area as f64).sqrt().ceil() as usize).max(widest).next_power_of_two().min(AXIS);
    loop {
        let (mut x, mut y, mut row_height) = (0, 0, 0);
        for c in charts.iter_mut() {
            if x + c.size[0] > width { y += row_height; x = 0; row_height = 0; }
            c.origin = [x, y]; x += c.size[0]; row_height = row_height.max(c.size[1]);
        }
        let height = y + row_height;
        if height <= AXIS && width * height <= budget { return Ok([width, height]); }
        if width == AXIS { return Err("Page atlas packing exceeds pixel budget; lower texelsPerMetre or choose fewer objects".into()); }
        width = (width * 2).min(AXIS);
    }
}
fn weights(xy: [[f64; 2]; 3], point: [f64; 2]) -> [f64; 3] {
    let [a, b, c] = xy;
    let denominator = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if denominator.abs() < 1e-16 { return [1., 0., 0.]; }
    let u = ((b[1] - c[1]) * (point[0] - c[0]) + (c[0] - b[0]) * (point[1] - c[1])) / denominator;
    let v = ((c[1] - a[1]) * (point[0] - c[0]) + (a[0] - c[0]) * (point[1] - c[1])) / denominator;
    // Fill guard pixels from the closest barycentric edge, avoiding seams under
    // bilinear sampling. We never sample a neighboring triangle's chart.
    let mut w = [u.max(0.), v.max(0.), (1. - u - v).max(0.)];
    let sum: f64 = w.iter().sum(); for v in &mut w { *v /= sum; } w
}
fn interpolate(uv: [[f64; 2]; 3], w: [f64; 3]) -> [f64; 2] {
    std::array::from_fn(|axis| (0..3).map(|i| uv[i][axis] * w[i]).sum())
}
pub(super) fn bake(input: AtlasInput<'_>, remaining: &mut usize) -> Result<Atlas, String> {
    let mut charts = Vec::with_capacity(input.triangles.len());
    for indices in input.triangles {
        let mut points = [[0.; 3]; 3];
        for (corner, &index) in indices.iter().enumerate() {
            points[corner] = *input.positions.get(index.checked_sub(1).ok_or("Zero source chart index")? as usize).ok_or("Invalid source chart index")?;
        }
        charts.push(chart(points, input.metres_per_unit * input.density)?);
    }
    let [width, height] = layout(&mut charts, *remaining)?;
    *remaining -= width * height;
    let mut rgba = vec![0; width * height * 4];
    let mut uv = Vec::with_capacity(charts.len() * 3);
    for (triangle, c) in charts.iter().enumerate() {
        let page_indices = input.page_indices.get(triangle).ok_or("Missing projected triangle")?;
        let mut page_uv = [[0.; 2]; 3];
        let mut old_uv = [[0.; 2]; 3];
        for i in 0..3 {
            page_uv[i] = *input.page_uv.get(page_indices[i].checked_sub(1).ok_or("Zero projected index")? as usize).ok_or("Invalid projected corner")?;
            if let Some((coords, indices)) = input.old_uv {
                let index = indices.get(triangle).ok_or("Missing source texture triangle")?[i];
                old_uv[i] = coords.get(index.checked_sub(1).ok_or("Zero source texture index")? as usize).ok_or("Invalid source texture corner")?.map(f64::from);
            }
            uv.push([(c.origin[0] as f64 + c.xy[i][0]) / width as f64,
                1. - (c.origin[1] as f64 + c.xy[i][1]) / height as f64]);
        }
        for y in 0..c.size[1] { for x in 0..c.size[0] {
            let w = weights(c.xy, [x as f64 + 0.5, y as f64 + 0.5]);
            let mut background = input.color.map(f64::from);
            if let Some((raster, repeat)) = input.old_raster {
                let sample = raster.sample(interpolate(old_uv, w), repeat);
                for i in 0..4 { background[i] *= sample[i]; }
            }
            let pixel = composite(input.page, interpolate(page_uv, w), background);
            let offset = ((c.origin[1] + y) * width + c.origin[0] + x) * 4;
            rgba[offset..offset + 4].copy_from_slice(&pixel);
        } }
    }
    Ok(Atlas { width: width as u32, height: height as u32, rgba, uv })
}
