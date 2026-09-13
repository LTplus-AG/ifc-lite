// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Encroachment broad-phase for the CDT refinement driver: a CSR uniform grid
//! over the constraint segments' diametral circles. Split out of `cdt.rs` for
//! the module-size ratchet; `Cdt::start_refinement` builds it and
//! `Cdt::next_steiner` queries it.

use super::predicates::dist2;
use super::{Cdt, P2};

/// Broad-phase over the constraint segments' diametral circles, for the
/// per-candidate encroachment test. CSR uniform grid + an "oversized disk"
/// list; `nx == 0` = not built.
#[derive(Default)]
pub(super) struct EncGrid {
    mid: Vec<P2>,
    r2: Vec<f64>,
    minx: f64,
    miny: f64,
    inv: f64,
    nx: usize,
    ny: usize,
    starts: Vec<u32>,
    items: Vec<u32>,
    big: Vec<u32>,
}

impl Cdt {
    /// Does point `p` lie inside the diametral circle of any constraint
    /// segment?
    ///
    /// Existence only — the refinement driver never looks at WHICH segment — so
    /// the answer is order-independent and a broad-phase is exact rather than
    /// approximate. Every skinny candidate used to test every constraint
    /// (5.9e7 disk tests on ISSUE_129); the grid built once per refinement
    /// answers from one cell plus the few oversized disks.
    pub(super) fn is_encroached(&self, p: P2) -> bool {
        let hit = |i: u32| {
            let i = i as usize;
            dist2(p, self.enc.mid[i]) < self.enc.r2[i] * (1.0 - 1e-12)
        };
        if self.enc.nx == 0 {
            // No grid (constraints mutated mid-refinement, or none at all).
            return self.constraints.iter().any(|&(a, b)| {
                let (pa, pb) = (self.points[a], self.points[b]);
                let mid = [(pa[0] + pb[0]) * 0.5, (pa[1] + pb[1]) * 0.5];
                dist2(p, mid) < dist2(pa, pb) * 0.25 * (1.0 - 1e-12)
            });
        }
        if self.enc.big.iter().copied().any(hit) {
            return true;
        }
        let gx = (p[0] - self.enc.minx) * self.enc.inv;
        let gy = (p[1] - self.enc.miny) * self.enc.inv;
        if !(gx >= 0.0 && gy >= 0.0) {
            return false;
        }
        let (gx, gy) = (gx as usize, gy as usize);
        if gx >= self.enc.nx || gy >= self.enc.ny {
            return false;
        }
        let c = gy * self.enc.nx + gx;
        let (s, e) = (
            self.enc.starts[c] as usize,
            self.enc.starts[c + 1] as usize,
        );
        self.enc.items[s..e].iter().copied().any(hit)
    }

    /// Rebuild [`Cdt::enc`] from the current constraint set. `nx == 0` means
    /// "no grid" and [`Cdt::is_encroached`] falls back to the linear scan.
    pub(super) fn build_enc_grid(&mut self) {
        let mut mid: Vec<P2> = Vec::with_capacity(self.constraints.len());
        let mut r2: Vec<f64> = Vec::with_capacity(self.constraints.len());
        let mut rad: Vec<f64> = Vec::with_capacity(self.constraints.len());
        for &(a, b) in &self.constraints {
            let (pa, pb) = (self.points[a], self.points[b]);
            mid.push([(pa[0] + pb[0]) * 0.5, (pa[1] + pb[1]) * 0.5]);
            let d2 = dist2(pa, pb) * 0.25;
            r2.push(d2);
            rad.push(d2.sqrt());
        }
        self.enc = EncGrid {
            mid,
            r2,
            ..EncGrid::default()
        };
        let n = self.enc.mid.len();
        if n == 0 {
            return;
        }
        let (mut minx, mut miny, mut maxx, mut maxy) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        for (m, r) in self.enc.mid.iter().zip(rad.iter()) {
            minx = minx.min(m[0] - r);
            miny = miny.min(m[1] - r);
            maxx = maxx.max(m[0] + r);
            maxy = maxy.max(m[1] + r);
        }
        let span = (maxx - minx).max(maxy - miny);
        if !(span > 0.0) || !span.is_finite() {
            return;
        }
        // ~1 cell per constraint, capped so the CSR stays small.
        let side = ((n as f64).sqrt().ceil() as usize).clamp(1, 64);
        let cell = span / side as f64;
        let inv = 1.0 / cell;
        let (nx, ny) = (side, side);
        let cellrange = |m: P2, r: f64| -> (usize, usize, usize, usize) {
            let c = |v: f64, lo: f64, hi: usize| {
                let g = ((v - lo) * inv).floor();
                if g < 0.0 {
                    0
                } else if g >= hi as f64 {
                    hi - 1
                } else {
                    g as usize
                }
            };
            (
                c(m[0] - r, minx, nx),
                c(m[0] + r, minx, nx),
                c(m[1] - r, miny, ny),
                c(m[1] + r, miny, ny),
            )
        };
        let mut counts = vec![0u32; nx * ny + 1];
        let mut big: Vec<u32> = Vec::new();
        let mut is_big = vec![false; n];
        for i in 0..n {
            let (x0, x1, y0, y1) = cellrange(self.enc.mid[i], rad[i]);
            if (x1 - x0 + 1) * (y1 - y0 + 1) > 32 {
                big.push(i as u32);
                is_big[i] = true;
                continue;
            }
            for gy in y0..=y1 {
                for gx in x0..=x1 {
                    counts[gy * nx + gx + 1] += 1;
                }
            }
        }
        for i in 1..counts.len() {
            counts[i] += counts[i - 1];
        }
        let total = counts[nx * ny] as usize;
        let mut items = vec![0u32; total];
        let mut cursor = counts.clone();
        for i in 0..n {
            if is_big[i] {
                continue;
            }
            let (x0, x1, y0, y1) = cellrange(self.enc.mid[i], rad[i]);
            for gy in y0..=y1 {
                for gx in x0..=x1 {
                    let c = gy * nx + gx;
                    items[cursor[c] as usize] = i as u32;
                    cursor[c] += 1;
                }
            }
        }
        self.enc.minx = minx;
        self.enc.miny = miny;
        self.enc.inv = inv;
        self.enc.nx = nx;
        self.enc.ny = ny;
        self.enc.starts = counts;
        self.enc.items = items;
        self.enc.big = big;
    }
}
