// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Exact whole-shell and finite-carrier acceptance (#7714).

use super::carrier::{ring, Shell};
use super::carrier_exact::{area_vector, cross, dot, sub, zero, Plane, P, R};
use num_traits::{Signed, Zero};
use std::collections::{BTreeMap, BTreeSet};

pub(super) fn validate(shell: &Shell, before: &[Vec<P>], planes: &[Plane]) -> Option<()> {
    if shell.points.values().collect::<BTreeSet<_>>().len() != shell.points.len() {
        return None;
    }
    let rings: Vec<_> = shell.faces.iter().map(|ids| ring(shell, ids)).collect();
    let mut edges: BTreeMap<(u32, u32), Vec<(usize, bool)>> = BTreeMap::new();
    let mut volume = R::zero();
    let mut original_volume = R::zero();
    for (f, ids) in shell.faces.iter().enumerate() {
        let r = &rings[f];
        let n = area_vector(r);
        if zero(&n)
            || dot(&n, &area_vector(&before[f])) <= R::zero()
            || !r.iter().all(|p| planes[f].contains(p))
        {
            return None;
        }
        // Every face is a simple convex finite polygon. Testing every vertex
        // against every edge also rejects stars, backtracking and concavities.
        for i in 0..r.len() {
            let next = (i + 1) % r.len();
            if r[i] == r[next] {
                return None;
            }
            for j in 0..i {
                if r[i] == r[j] {
                    return None;
                }
            }
            let direction = sub(&r[next], &r[i]);
            if r.iter()
                .any(|p| dot(&cross(&direction, &sub(p, &r[i])), &n) < R::zero())
            {
                return None;
            }
            let (a, b) = (ids[i], ids[next]);
            edges
                .entry((a.min(b), a.max(b)))
                .or_default()
                .push((f, a < b));
        }
        // Convex supporting halfspaces, oriented outward by the authored loop.
        if shell
            .points
            .values()
            .any(|p| dot(&n, &sub(p, &r[0])) > R::zero())
        {
            return None;
        }
        for i in 1..r.len() - 1 {
            volume += dot(&r[0], &cross(&r[i], &r[i + 1]));
            original_volume += dot(&before[f][0], &cross(&before[f][i], &before[f][i + 1]));
        }
    }
    if volume <= R::zero()
        || original_volume <= R::zero()
        || edges.values().any(|e| e.len() != 2 || e[0].1 == e[1].1)
    {
        return None;
    }
    // Closed oriented incidence alone admits disconnected and pinched shells.
    let mut visited = BTreeSet::from([0]);
    let mut pending = vec![0];
    while let Some(f) = pending.pop() {
        for e in edges.values().filter(|e| e.iter().any(|v| v.0 == f)) {
            for &(other, _) in e {
                if visited.insert(other) {
                    pending.push(other);
                }
            }
        }
    }
    if visited.len() != rings.len() || shell.points.len() + rings.len() != edges.len() + 2 {
        return None;
    }
    for id in shell.points.keys() {
        // The incident face link must be one cycle, not two fans meeting only
        // at the source point. Each local edge contributes one link edge.
        let incident: BTreeSet<_> = shell
            .faces
            .iter()
            .enumerate()
            .filter(|(_, r)| r.contains(id))
            .map(|(f, _)| f)
            .collect();
        let mut link = BTreeSet::new();
        let mut pending = vec![*incident.first()?];
        while let Some(f) = pending.pop() {
            if !link.insert(f) {
                continue;
            }
            for (&(a, b), e) in &edges {
                if (a == *id || b == *id) && e.iter().any(|v| v.0 == f) {
                    pending.extend(e.iter().map(|v| v.0).filter(|g| !link.contains(g)));
                }
            }
        }
        if link != incident {
            return None;
        }
    }
    finite_coverage(&rings, planes)
}

pub(super) fn finite_coverage(rings: &[Vec<P>], planes: &[Plane]) -> Option<()> {
    let mut grouped: BTreeSet<usize> = BTreeSet::new();
    for i in 0..rings.len() {
        if grouped.contains(&i) {
            continue;
        }
        let group: Vec<_> = (i..rings.len())
            .filter(|&j| planes[i].same(&planes[j]))
            .collect();
        grouped.extend(&group);
        let n = area_vector(&rings[i]);
        for a in 0..group.len() {
            for b in a + 1..group.len() {
                let (a, b) = (&rings[group[a]], &rings[group[b]]);
                if !separated(a, b, &n) && !separated(b, a, &n) {
                    return None;
                }
            }
        }
        // Disjoint interiors plus exact equality with the supporting-plane
        // convex hull proves the finite face union has no hole/double cover.
        let axis = n.iter().position(|v| !v.is_zero())?;
        let axes: Vec<_> = (0..3).filter(|&j| j != axis).collect();
        let projected: Vec<Vec<[R; 2]>> = group
            .iter()
            .map(|&j| {
                rings[j]
                    .iter()
                    .map(|p| [p[axes[0]].clone(), p[axes[1]].clone()])
                    .collect()
            })
            .collect();
        let area: R = projected.iter().map(|r| area2(r).abs()).sum();
        let points: BTreeSet<_> = projected.iter().flatten().cloned().collect();
        let hull = hull(points.into_iter().collect());
        if area != area2(&hull).abs() {
            return None;
        }
    }
    Some(())
}

fn separated(a: &[P], b: &[P], n: &P) -> bool {
    (0..a.len()).any(|i| {
        let edge = sub(&a[(i + 1) % a.len()], &a[i]);
        b.iter()
            .all(|p| dot(&cross(&edge, &sub(p, &a[i])), n) <= R::zero())
    })
}

fn turn(a: &[R; 2], b: &[R; 2], c: &[R; 2]) -> R {
    (&b[0] - &a[0]) * (&c[1] - &a[1]) - (&b[1] - &a[1]) * (&c[0] - &a[0])
}
fn area2(r: &[[R; 2]]) -> R {
    (0..r.len())
        .map(|i| &r[i][0] * &r[(i + 1) % r.len()][1] - &r[i][1] * &r[(i + 1) % r.len()][0])
        .sum()
}
fn hull(points: Vec<[R; 2]>) -> Vec<[R; 2]> {
    // Construct the two chains independently so the return chain cannot
    // remove a vertex belonging to the forward chain.
    let chain = |iter: Vec<[R; 2]>| {
        let mut out: Vec<[R; 2]> = Vec::new();
        for p in iter {
            while out.len() >= 2 && turn(&out[out.len() - 2], &out[out.len() - 1], &p) <= R::zero()
            {
                out.pop();
            }
            out.push(p);
        }
        out.pop();
        out
    };
    let mut result = chain(points.clone());
    result.extend(chain(points.into_iter().rev().collect()));
    result
}
