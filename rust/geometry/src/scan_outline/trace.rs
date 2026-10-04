// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Cell-edge contour tracing with nesting.
//!
//! Every side between a solid and an empty cell is a directed boundary edge
//! with the solid cell on its LEFT, so an outer boundary runs counter-clockwise
//! and a hole clockwise. After `morph::fill_saddles` each lattice vertex has
//! at most one outgoing boundary edge, so following edges vertex to vertex
//! yields disjoint simple loops. Each loop records the solid component on its
//! left and the empty region on its right; from those the container of every
//! ring follows without any geometric test.

use super::grid::GridGeometry;
use super::morph::Labels;

/// Side bits of a cell, one per boundary edge it can own.
const BOTTOM: u8 = 1;
const RIGHT: u8 = 2;
const TOP: u8 = 4;
const LEFT: u8 = 8;

pub(super) struct Traced {
    /// Rings in plane coordinates, corners only (collinear lattice points
    /// dropped), no closing duplicate.
    pub rings: Vec<Vec<[f64; 2]>>,
    /// The ring directly containing each ring.
    pub parents: Vec<Option<usize>>,
}

/// Unit steps of the four edge directions: +x, +y, -x, -y.
const STEP: [(isize, isize); 4] = [(1, 0), (0, 1), (-1, 0), (0, -1)];

pub(super) fn trace_rings(mask: &[u8], labels: &Labels, geo: &GridGeometry) -> Traced {
    let (w, h) = (geo.width, geo.height);
    let solid = |x: isize, y: isize| -> bool {
        x >= 0 && y >= 0 && (x as usize) < w && (y as usize) < h && mask[y as usize * w + x as usize] != 0
    };
    let (fg_labels, bg_labels, outside) = (&labels.solid, &labels.empty, labels.outside);

    let mut visited = vec![0u8; w * h];
    let mut rings: Vec<Vec<[f64; 2]>> = Vec::new();
    // Per ring: (solid label on the left, empty label on the right, is hole).
    let mut sides: Vec<(u32, u32, bool)> = Vec::new();

    for y in 0..h as isize {
        for x in 0..w as isize {
            if !solid(x, y) {
                continue;
            }
            let c = y as usize * w + x as usize;
            // Only a bottom side starts a trace: every loop has one (its
            // lowest row's bottom edges), so nothing is missed.
            if solid(x, y - 1) || visited[c] & BOTTOM != 0 {
                continue;
            }
            let fg = fg_labels[c];
            // Padding keeps solid cells off row 0; guard it anyway.
            let bg = if y > 0 { bg_labels[(y as usize - 1) * w + x as usize] } else { outside };
            let lattice = follow(x, y, &solid, &mut visited, w);
            let ring: Vec<[f64; 2]> = lattice
                .iter()
                .map(|&(i, j)| [geo.x0 + i as f64 * geo.cell, geo.y0 + j as f64 * geo.cell])
                .collect();
            let hole = lattice_area2(&lattice) < 0;
            rings.push(ring);
            sides.push((fg, bg, hole));
        }
    }

    // A hole's container is the outer ring of the solid on its left; an outer
    // ring's container is the hole ring bounding the empty region on its right.
    let mut outer_of_fg = std::collections::HashMap::new();
    let mut hole_of_bg = std::collections::HashMap::new();
    for (i, &(fg, bg, hole)) in sides.iter().enumerate() {
        if hole {
            hole_of_bg.insert(bg, i);
        } else {
            outer_of_fg.insert(fg, i);
        }
    }
    let parents = sides
        .iter()
        .map(|&(fg, bg, hole)| {
            if hole {
                outer_of_fg.get(&fg).copied()
            } else if bg == outside {
                None
            } else {
                hole_of_bg.get(&bg).copied()
            }
        })
        .collect();
    Traced { rings, parents }
}

/// Follow one loop from the bottom edge of cell `(x, y)`; returns its corner
/// lattice vertices.
fn follow(
    x: isize,
    y: isize,
    solid: &impl Fn(isize, isize) -> bool,
    visited: &mut [u8],
    w: usize,
) -> Vec<(isize, isize)> {
    let start = (x, y);
    let start_dir = 0usize; // bottom edge of (x, y) runs +x from vertex (x, y)
    let mut v = start;
    let mut dir = start_dir;
    let mut corners = Vec::new();
    let mut prev_dir = usize::MAX;
    // Bounded by the edge count: every step marks a new edge visited and the
    // walk stops on returning to the start edge.
    let limit = visited.len() * 4 + 4;
    for _ in 0..limit {
        mark(v, dir, visited, w);
        if dir != prev_dir {
            corners.push(v);
        }
        prev_dir = dir;
        v = (v.0 + STEP[dir].0, v.1 + STEP[dir].1);
        dir = next_direction(v, dir, solid);
        if v == start && dir == start_dir {
            break;
        }
    }
    // The start vertex is a corner only when the closing edge turns into it.
    if prev_dir == start_dir && corners.len() > 1 {
        corners.remove(0);
    }
    corners
}

/// Outgoing boundary edge at lattice vertex `v`. Cells around it: NE = (x, y),
/// NW = (x-1, y), SW = (x-1, y-1), SE = (x, y-1).
fn next_direction(v: (isize, isize), incoming: usize, solid: &impl Fn(isize, isize) -> bool) -> usize {
    let (x, y) = v;
    let ne = solid(x, y);
    let nw = solid(x - 1, y);
    let sw = solid(x - 1, y - 1);
    let se = solid(x, y - 1);
    let out = [ne && !se, nw && !ne, sw && !nw, se && !sw];
    // Prefer the left turn, then straight, then right; saddle-free input has
    // exactly one candidate, the order only makes a stray saddle deterministic.
    for turn in [1usize, 0, 3] {
        let d = (incoming + turn) % 4;
        if out[d] {
            return d;
        }
    }
    incoming
}

/// Mark the edge leaving `v` in direction `dir` on the cell that owns it.
fn mark(v: (isize, isize), dir: usize, visited: &mut [u8], w: usize) {
    let (x, y) = v;
    let (cx, cy, bit) = match dir {
        0 => (x, y, BOTTOM),
        1 => (x - 1, y, RIGHT),
        2 => (x - 1, y - 1, TOP),
        _ => (x, y - 1, LEFT),
    };
    if cx >= 0 && cy >= 0 {
        let c = cy as usize * w + cx as usize;
        if c < visited.len() {
            visited[c] |= bit;
        }
    }
}

/// Twice the signed area of a lattice ring, exact in integers.
fn lattice_area2(ring: &[(isize, isize)]) -> i64 {
    let n = ring.len();
    let mut acc = 0i64;
    for i in 0..n {
        let (a, b) = (ring[i], ring[(i + 1) % n]);
        acc += a.0 as i64 * b.1 as i64 - b.0 as i64 * a.1 as i64;
    }
    acc
}
