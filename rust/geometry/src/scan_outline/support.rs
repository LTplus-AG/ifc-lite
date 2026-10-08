// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Keep moved edges on the evidence: every point of an output edge must lie
//! within a tolerance of the traced cell boundary.
//!
//! Snapping and squaring work on lines, and two lines can meet far from where
//! the scan has anything (a merged wall extended across a narrow gap, a
//! corner rebuilt from two unrelated faces). A ring can stay simple and still
//! cut through empty space that way. Checking each edge sample against the
//! boundary cells of the final mask within the tolerance lets the repair loop
//! treat such an edge like a crossing and undo the move. The search is local
//! (a disk of the tolerance radius per sample), so its cost follows the
//! outline length, not the grid size.

use super::grid::GridGeometry;
use super::topology::EdgeRef;

pub(super) struct Support {
    geo: GridGeometry,
    /// `1` on boundary cells (a 4-neighbour of the other colour).
    boundary: Vec<u8>,
    /// Cell offsets within the tolerance disk.
    disk: Vec<(isize, isize)>,
}

impl Support {
    pub fn new(mask: &[u8], geo: &GridGeometry, tolerance_cells: f64) -> Self {
        let (w, h) = (geo.width, geo.height);
        let mut boundary = vec![0u8; w * h];
        for y in 0..h {
            for x in 0..w {
                let c = y * w + x;
                let m = mask[c];
                let differs = (x > 0 && mask[c - 1] != m)
                    || (x + 1 < w && mask[c + 1] != m)
                    || (y > 0 && mask[c - w] != m)
                    || (y + 1 < h && mask[c + w] != m);
                boundary[c] = u8::from(differs);
            }
        }
        // +0.75: a continuous position against cell-centre distances.
        let r = tolerance_cells + 0.75;
        let ri = r.ceil() as isize;
        let mut disk = Vec::new();
        for dj in -ri..=ri {
            for di in -ri..=ri {
                if ((di * di + dj * dj) as f64) <= r * r {
                    disk.push((di, dj));
                }
            }
        }
        // Nearest offsets first: a supported sample usually stops early.
        disk.sort_by_key(|&(di, dj)| di * di + dj * dj);
        Self { geo: *geo, boundary, disk }
    }

    /// Whether a boundary cell lies within the tolerance of `p`.
    fn supported(&self, p: [f64; 2]) -> bool {
        let g = &self.geo;
        let i = ((p[0] - g.x0) / g.cell).floor();
        let j = ((p[1] - g.y0) / g.cell).floor();
        if !(i.is_finite() && j.is_finite()) {
            return false;
        }
        let (i, j) = (i as isize, j as isize);
        self.disk.iter().any(|&(di, dj)| {
            let (x, y) = (i + di, j + dj);
            x >= 0 && y >= 0 && (x as usize) < g.width && (y as usize) < g.height && self.boundary[y as usize * g.width + x as usize] != 0
        })
    }

    /// Edges with a sample farther than the tolerance from the boundary.
    pub fn unsupported_edges(&self, rings: &[Vec<[f64; 2]>]) -> Vec<EdgeRef> {
        let mut out = Vec::new();
        for (r, ring) in rings.iter().enumerate() {
            let n = ring.len();
            for k in 0..n {
                let (a, b) = (ring[k], ring[(k + 1) % n]);
                let len_cells = (b[0] - a[0]).hypot(b[1] - a[1]) / self.geo.cell;
                let steps = (len_cells.ceil() as usize).clamp(1, 1 << 20);
                let off = (0..=steps).any(|s| {
                    let t = s as f64 / steps as f64;
                    !self.supported([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])])
                });
                if off {
                    out.push(EdgeRef { ring: r, edge: k });
                }
            }
        }
        out
    }
}
