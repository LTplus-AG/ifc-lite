// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Bounded uniform grid over registered scan points (#4381). A BVH leaf per
//! point would cost ~120 bytes/point; this index costs 16 and answers the two
//! queries point transfer needs: nearest point within a radius and every point
//! within a radius. Every visited cell and point is charged to the caller's
//! aggregate work budget so an exhausted budget is an error, never a partial
//! neighborhood.
use super::{transfer_budget::TransferBudget, transfer_math::Point};

/// Cells per axis fit 21 bits so three axes pack into one sortable u64 key.
const AXIS_CELLS: f64 = 2_097_152.;

pub(super) struct PointGrid {
    cell: f64,
    min: Point,
    /// Point indices sorted by packed cell key.
    order: Vec<u32>,
    /// (packed key, first position in `order`) per occupied cell, ascending.
    cells: Vec<(u64, u32)>,
}
impl PointGrid {
    /// `cell` should match the common query radius: a query visits the cells
    /// its box overlaps, so a radius up to `cell` touches at most 27 cells and a
    /// wider (rarer) query proportionally more. Charges one sort's worth of work
    /// and reserves index memory.
    pub fn build(points: &[Point], cell: f64, budget: &mut TransferBudget) -> Result<Self, String> {
        if points.is_empty() || !cell.is_finite() || cell <= 0. {
            return Err("Transfer point index needs points and a positive cell size".into());
        }
        let mut min = points[0];
        let mut max = points[0];
        for p in points {
            for axis in 0..3 {
                min[axis] = min[axis].min(p[axis]);
                max[axis] = max[axis].max(p[axis]);
            }
        }
        if (0..3).any(|axis| (max[axis] - min[axis]) / cell >= AXIS_CELLS - 2.) {
            return Err("Transfer point extent exceeds the spatial index bound; crop the scan or raise the distance bound".into());
        }
        budget.reserve(points.len() * 16)?;
        let levels = usize::BITS as usize - points.len().leading_zeros() as usize;
        budget.charge(points.len() * (levels + 1))?;
        let key_of = |p: &Point| pack(cell_coordinates(p, min, cell));
        let mut keyed: Vec<(u64, u32)> = points
            .iter()
            .enumerate()
            .map(|(i, p)| (key_of(p), i as u32))
            .collect();
        keyed.sort_unstable();
        let mut cells = Vec::new();
        let mut order = Vec::with_capacity(keyed.len());
        for (position, (key, index)) in keyed.iter().enumerate() {
            if cells.last().is_none_or(|(last, _)| last != key) {
                cells.push((*key, position as u32));
            }
            order.push(*index);
        }
        Ok(Self { cell, min, order, cells })
    }
    /// Every point within `radius` of `center` as `(index, squared distance)`,
    /// appended to `out` in ascending cell then original index order.
    pub fn within(
        &self,
        points: &[Point],
        center: Point,
        radius: f64,
        out: &mut Vec<(u32, f64)>,
        budget: &mut TransferBudget,
    ) -> Result<(), String> {
        if !center.iter().all(|v| v.is_finite()) || !radius.is_finite() || radius < 0. || radius > 16. * self.cell {
            return Err("Transfer point query needs a finite center and a radius within 16 index cells".into());
        }
        let low = cell_coordinates(&std::array::from_fn(|a| center[a] - radius), self.min, self.cell);
        let high = cell_coordinates(&std::array::from_fn(|a| center[a] + radius), self.min, self.cell);
        let r2 = radius * radius;
        for x in low[0]..=high[0] {
            for y in low[1]..=high[1] {
                for z in low[2]..=high[2] {
                    budget.charge(1)?;
                    let key = pack([x, y, z]);
                    let Ok(slot) = self.cells.binary_search_by_key(&key, |(k, _)| *k) else { continue };
                    let start = self.cells[slot].1 as usize;
                    let end = self.cells.get(slot + 1).map_or(self.order.len(), |(_, s)| *s as usize);
                    budget.charge(end - start)?;
                    for &index in &self.order[start..end] {
                        let p = points[index as usize];
                        let d2: f64 = (0..3).map(|a| (p[a] - center[a]).powi(2)).sum();
                        if d2 <= r2 {
                            out.push((index, d2));
                        }
                    }
                }
            }
        }
        Ok(())
    }
    /// Nearest point within `radius`; ties keep the lowest original index.
    pub fn nearest(
        &self,
        points: &[Point],
        center: Point,
        radius: f64,
        scratch: &mut Vec<(u32, f64)>,
        budget: &mut TransferBudget,
    ) -> Result<Option<(u32, f64)>, String> {
        scratch.clear();
        self.within(points, center, radius, scratch, budget)?;
        Ok(scratch
            .iter()
            .copied()
            .fold(None, |best: Option<(u32, f64)>, (i, d2)| match best {
                Some((bi, bd)) if bd < d2 || (bd == d2 && bi < i) => Some((bi, bd)),
                _ => Some((i, d2)),
            }))
    }
}
fn cell_coordinates(p: &Point, min: Point, cell: f64) -> [u64; 3] {
    std::array::from_fn(|axis| {
        // Query boxes may extend below the minimum: clamp instead of wrapping.
        (((p[axis] - min[axis]) / cell).floor().max(0.) as u64).min(AXIS_CELLS as u64 - 1)
    })
}
fn pack(c: [u64; 3]) -> u64 {
    (c[0] << 42) | (c[1] << 21) | c[2]
}

#[cfg(test)]
mod tests {
    use super::*;
    fn cloud() -> Vec<Point> {
        (0..1000)
            .map(|i| {
                let f = i as f64;
                [(f * 0.37).rem_euclid(3.) - 1., (f * 0.91).rem_euclid(2.) + 5., (f * 0.13).rem_euclid(1.5) - 100.]
            })
            .collect()
    }
    #[test]
    fn issue_4381_grid_queries_match_brute_force_and_charge_work() {
        let points = cloud();
        let mut budget = TransferBudget::new();
        let grid = PointGrid::build(&points, 0.05, &mut budget).unwrap();
        let before = budget.work;
        for center in [[0., 5.5, -99.5], [-1., 5., -100.], [2.01, 7., -98.5], [0.3, 6.2, -99.]] {
            for radius in [0., 0.01, 0.05, 0.12] {
                let mut out = Vec::new();
                grid.within(&points, center, radius, &mut out, &mut budget).unwrap();
                out.sort_by_key(|(i, _)| *i);
                let expected: Vec<(u32, f64)> = points
                    .iter()
                    .enumerate()
                    .filter_map(|(i, p)| {
                        let d2: f64 = (0..3).map(|a| (p[a] - center[a]).powi(2)).sum();
                        (d2 <= radius * radius).then_some((i as u32, d2))
                    })
                    .collect();
                assert_eq!(out, expected, "{center:?} r={radius}");
                let nearest = grid.nearest(&points, center, radius, &mut Vec::new(), &mut budget).unwrap();
                let brute = expected.iter().copied().min_by(|a, b| a.1.total_cmp(&b.1).then(a.0.cmp(&b.0)));
                assert_eq!(nearest, brute);
            }
        }
        assert!(budget.work < before, "every query charges the shared budget");
        assert!(grid.within(&points, [0., 5.5, -99.5], 0.9, &mut Vec::new(), &mut budget).is_err(), "a radius beyond 16 cells is refused");
        assert!(grid.within(&points, [f64::NAN, 5.5, -99.5], 0.01, &mut Vec::new(), &mut budget).is_err());
        let mut exhausted = TransferBudget::new();
        exhausted.work = 3;
        assert!(grid.within(&points, [0., 5.5, -99.5], 0.05, &mut Vec::new(), &mut exhausted).unwrap_err().contains("budget"));
        assert!(PointGrid::build(&points, 1e-9, &mut TransferBudget::new()).err().is_some_and(|e| e.contains("extent")));
        assert!(PointGrid::build(&[], 0.1, &mut TransferBudget::new()).is_err());
    }
}
