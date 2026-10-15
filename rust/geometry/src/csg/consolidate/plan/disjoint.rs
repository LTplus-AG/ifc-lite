// This Source Code Form is subject to the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Conservative independent groups in the existing projected union domain.

/// A strict gap in either projected axis proves independent union operands.
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
    for axis in 0..2 {
        let mut intervals: Vec<_> = paths
            .iter()
            .enumerate()
            .map(|(i, path)| {
                let lo = path.iter().map(|p| p[axis]).fold(f64::INFINITY, f64::min);
                let hi = path
                    .iter()
                    .map(|p| p[axis])
                    .fold(f64::NEG_INFINITY, f64::max);
                (lo, hi, i)
            })
            .collect();
        if intervals
            .iter()
            .any(|(lo, hi, _)| !lo.is_finite() || !hi.is_finite())
        {
            return None;
        }
        intervals.sort_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.2.cmp(&b.2)));
        let mut groups: Vec<Vec<usize>> = Vec::new();
        let mut end = f64::NEG_INFINITY;
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
