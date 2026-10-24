// SPDX-License-Identifier: MPL-2.0
//! Exact-predicate simple-polygon partition; no epsilon, sampled curve or mesh cutter.
use super::clip::refused;
use crate::{Result, math::geom2d::{orientation, segments_intersect}};

pub(super) fn cells(points: &[[f64; 2]]) -> Result<Vec<Vec<usize>>> {
    let n = points.len();
    if !(3..=super::finite_source::MAX_POINTS).contains(&n)
        || points.iter().flatten().any(|v| !v.is_finite() || v.abs() > 1e100) {
        return Err(refused("finite polygon coordinate/count budget"));
    }
    for i in 0..n {
        crate::resource::charge(crate::resource::Cost { work: n as u64, ..Default::default() })?.retain();
        let next = (i + 1) % n;
        if points[i] == points[next] || orientation(points[(i+n-1)%n], points[i], points[next]) == 0 {
            return Err(refused("finite polygon repeated or collinear edge"));
        }
        for j in i+1..n {
            if j == next || (j+1)%n == i { continue; }
            if segments_intersect(points[i], points[next], points[j], points[(j+1)%n]) {
                return Err(refused("finite polygon self intersection/touch"));
            }
        }
    }
    // A lexicographically extreme simple-polygon vertex is convex. Its exact
    // orientation determines winding without an overflow-prone signed-area sum.
    let extreme = (0..n).min_by(|&a, &b| points[a][0].total_cmp(&points[b][0])
        .then(points[a][1].total_cmp(&points[b][1]))).ok_or_else(|| refused("empty polygon"))?;
    let winding = orientation(points[(extreme+n-1)%n], points[extreme], points[(extreme+1)%n]);
    let mut ring = Vec::new();
    crate::resource::reserve_headers(&mut ring, n)?.retain();
    ring.extend(0..n);
    if winding < 0 { ring.reverse(); }
    let mut output = Vec::new();
    crate::resource::reserve_headers(&mut output, n-2)?.retain();
    // Preserve a convex domain whole: unnecessary diagonal cuts increase both
    // SDK operations and artificial shared interfaces.
    if (0..n).all(|i| orientation(points[ring[i]], points[ring[(i+1)%n]], points[ring[(i+2)%n]]) > 0) {
        output.push(ring);
        return Ok(output);
    }
    while ring.len() > 3 {
        let k = ring.len();
        crate::resource::charge(crate::resource::Cost { work: (k*k) as u64, ..Default::default() })?.retain();
        let ear = (0..k).find(|&i| {
            let [a,b,c] = [ring[(i+k-1)%k],ring[i],ring[(i+1)%k]];
            orientation(points[a],points[b],points[c]) > 0 && !ring.iter().any(|&p| {
                p != a && p != b && p != c
                    && orientation(points[a],points[b],points[p]) >= 0
                    && orientation(points[b],points[c],points[p]) >= 0
                    && orientation(points[c],points[a],points[p]) >= 0
            })
        }).ok_or_else(|| refused("finite polygon has no certifiable ear"))?;
        let mut cell = Vec::new();
        crate::resource::reserve_headers(&mut cell, 3)?.retain();
        cell.extend([ring[(ear+k-1)%k],ring[ear],ring[(ear+1)%k]]);
        output.push(cell);
        ring.remove(ear);
    }
    output.push(ring);
    Ok(output)
}

#[cfg(test)]
mod tests {
#[test]
fn j1_finite_partition_preserves_concave_area_both_windings() {
    let polygon = [[0.,0.],[3.,0.],[3.,1.],[1.,1.],[1.,3.],[0.,3.]];
    for points in [polygon.to_vec(),polygon.into_iter().rev().collect()] {
        let cells=super::cells(&points).unwrap();
        let area:f64=cells.iter().map(|cell| (0..cell.len()).map(|i| {
            let a=points[cell[i]];let b=points[cell[(i+1)%cell.len()]];a[0]*b[1]-a[1]*b[0]
        }).sum::<f64>()/2.).sum();
        assert_eq!(area,5.,"FINITE_PARTITION L area must not become its convex hull or kernel");
    }
}
}
