// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::geometry_compare::centre_distance;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NearestPair { pub base: usize, pub head: usize, pub distance: f64 }

fn unique_nearest(
    from: &[[f64; 3]], to: &[[f64; 3]], retired_from: &[bool], retired_to: &[bool], margin: f64,
) -> Vec<Option<usize>> {
    from.iter().enumerate().map(|(i, point)| {
        if retired_from[i] { return None; }
        let mut best_index = None;
        let mut best = f64::INFINITY;
        let mut second = f64::INFINITY;
        for (j, other) in to.iter().enumerate() {
            if retired_to[j] { continue; }
            let distance = centre_distance(*point, *other);
            if distance < best {
                second = best;
                best = distance;
                best_index = Some(j);
            } else if distance < second { second = distance; }
        }
        if best < second && best * margin <= second { best_index } else { None }
    }).collect()
}

/// A veto remains in the candidate pool. Exact ties abstain; every successful
/// round retires at least one entity on each side, so termination is bounded.
pub fn mutual_nearest_pairs(
    base: &[[f64; 3]], head: &[[f64; 3]], max_distance: f64,
    accept: impl Fn(usize, usize) -> bool, margin_ratio: f64,
) -> Vec<NearestPair> {
    let mut pairs = Vec::new();
    let mut retired_base = vec![false; base.len()];
    let mut retired_head = vec![false; head.len()];
    loop {
        let nearest_head = unique_nearest(base, head, &retired_base, &retired_head, margin_ratio);
        let nearest_base = unique_nearest(head, base, &retired_head, &retired_base, margin_ratio);
        let mut round = Vec::new();
        for (b, point) in base.iter().enumerate() {
            if retired_base[b] { continue; }
            let Some(h) = nearest_head[b] else { continue };
            if nearest_base[h] != Some(b) { continue; }
            let distance = centre_distance(*point, head[h]);
            // A comparison written this way also refuses NaN caps, like JS.
            if distance.partial_cmp(&max_distance).is_none_or(|order| order.is_gt()) || !accept(b, h) { continue; }
            round.push(NearestPair { base: b, head: h, distance });
        }
        if round.is_empty() { break; }
        for pair in round {
            retired_base[pair.base] = true;
            retired_head[pair.head] = true;
            pairs.push(pair);
        }
    }
    pairs.sort_by_key(|pair| pair.base);
    pairs
}
