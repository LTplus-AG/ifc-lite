// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Conservative independent groups in the existing projected union domain.

use i_overlay::i_float::adapter::FloatPointAdapter;

/// A strict gap in either integer-overlay axis proves independent operands.
/// Use the same adaptive adapter over all original projected paths as the union:
/// a positive floating-point gap can quantize into an edge contact.
/// Inclusive interval overlap keeps touching and crossing triangles together.
/// World-space AABBs cannot make this decision: normal-offset faces can have
/// disjoint world bounds while their projected footprints overlap completely.
///
/// At most two O(n log n) sorts, only after a union produced multiple regions.
/// Returned groups and their members retain authored triangle order. No graph
/// walk, tolerance, quadratic pair scan, or recursive partition is involved.
pub(super) fn separated_groups(
    subject: &[Vec<[f64; 2]>],
    clip: &[Vec<[f64; 2]>],
) -> Option<Vec<Vec<usize>>> {
    let paths: Vec<_> = subject.iter().chain(clip).collect();
    if paths.iter().any(|path| {
        path.is_empty()
            || path
                .iter()
                .flatten()
                .any(|coordinate| !coordinate.is_finite())
    }) {
        return None;
    }
    let adapter =
        FloatPointAdapter::<[f64; 2], i32>::with_iter(paths.iter().flat_map(|path| path.iter()));
    for axis in 0..2 {
        let mut intervals: Vec<_> = paths
            .iter()
            .enumerate()
            .map(|(i, path)| {
                let (lo, hi) = path.iter().fold((i32::MAX, i32::MIN), |(lo, hi), p| {
                    let point = adapter.float_to_int(p);
                    let coordinate = if axis == 0 { point.x } else { point.y };
                    (lo.min(coordinate), hi.max(coordinate))
                });
                (lo, hi, i)
            })
            .collect();
        intervals.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.2.cmp(&b.2)));
        let mut groups: Vec<Vec<usize>> = Vec::new();
        let mut end = i32::MIN;
        for (lo, hi, i) in intervals {
            if groups.is_empty() || lo > end {
                groups.push(Vec::new());
                end = hi;
            } else {
                end = end.max(hi);
            }
            groups.last_mut().expect("a group was started").push(i);
        }
        if groups.len() > 1 {
            for group in &mut groups {
                group.sort_unstable();
            }
            groups.sort_by_key(|g| g[0]);
            return Some(groups);
        }
    }
    None
}
