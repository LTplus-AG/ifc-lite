// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Chart-local raster padding. Interior observations remain unchanged; padding
//! inherits the nearest interior texel in Manhattan distance, with row-major
//! ties. Padding is never new coverage and cannot cross a chart boundary.
use super::{weights, Chart};

pub(super) fn dilate(
    chart: &Chart,
    atlas_width: usize,
    rgba: &mut [u8],
) {
    let [width, height] = chart.size;
    let count = width * height;
    // The transfer caller reserves five extra bytes and two extra pixel visits
    // per atlas pixel before allocation. No per-pixel source/BVH query here.
    let mut visited = vec![false; count];
    let mut queue = Vec::<u32>::with_capacity(count);
    let offset = |index: usize| {
        ((chart.origin[1] + index / width) * atlas_width + chart.origin[0] + index % width) * 4
    };
    for (index, marked) in visited.iter_mut().enumerate() {
        if weights(chart.xy, [(index % width) as f64 + 0.5, (index / width) as f64 + 0.5]).1 {
            *marked = true;
            queue.push(index as u32);
        }
    }
    // No emitted interior means no measured scan colour for this chart. Keep
    // its already sampled old appearance, even when its centroid was observed.
    let mut cursor = 0;
    while cursor < queue.len() {
        let index = queue[cursor] as usize;
        cursor += 1;
        let x = index % width;
        let y = index / width;
        let source = offset(index);
        let color: [u8; 4] = rgba[source..source + 4].try_into().unwrap();
        for neighbor in [
            (x > 0).then(|| index - 1),
            (x + 1 < width).then_some(index + 1),
            (y > 0).then(|| index - width),
            (y + 1 < height).then_some(index + width),
        ].into_iter().flatten() {
            if !visited[neighbor] {
                visited[neighbor] = true;
                queue.push(neighbor as u32);
                let start = offset(neighbor);
                rgba[start..start + 4].copy_from_slice(&color);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issue_4381_padding_preserves_interior_unknowns_and_chart_boundaries() {
        let chart = Chart { xy: [[2.5, 2.5], [8.5, 2.5], [2.5, 7.5]],
            size: [11, 10], origin: [3, 2] };
        let atlas_width = 17;
        let mut rgba = vec![211; atlas_width * 15 * 4];
        let mut seeds = Vec::new();
        for y in 0..10 { for x in 0..11 {
            if weights(chart.xy, [x as f64 + 0.5, y as f64 + 0.5]).1 {
                // Zero is deliberately retained unknown/source appearance.
                let color = [x as u8, y as u8, 0, 255];
                let start = ((y + 2) * atlas_width + x + 3) * 4;
                rgba[start..start + 4].copy_from_slice(&color);
                seeds.push((x, y, color));
            }
        } }
        dilate(&chart, atlas_width, &mut rgba);
        for y in 0usize..15 { for x in 0usize..atlas_width {
            let pixel = &rgba[(y * atlas_width + x) * 4..(y * atlas_width + x) * 4 + 4];
            if !(3..14).contains(&x) || !(2..12).contains(&y) {
                assert_eq!(pixel, &[211; 4]);
            } else {
                let (x, y) = (x - 3, y - 2);
                let nearest = seeds.iter().min_by_key(|(sx, sy, _)| x.abs_diff(*sx) + y.abs_diff(*sy)).unwrap();
                assert_eq!(pixel, &nearest.2, "nearest same-chart seed at {x},{y}");
            }
        } }
    }

    #[test]
    fn issue_4381_subpixel_chart_preserves_existing_appearance() {
        let chart = Chart { xy: [[2.6, 2.6], [2.7, 2.6], [2.6, 2.7]],
            size: [6, 6], origin: [0, 0] };
        let before: Vec<u8> = (0..6 * 6 * 4).map(|i| (i % 256) as u8).collect();
        let mut rgba = before.clone();
        dilate(&chart, 6, &mut rgba);
        assert_eq!(rgba, before);
    }
}
