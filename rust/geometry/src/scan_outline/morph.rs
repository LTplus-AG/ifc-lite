// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Binary morphology on the occupancy mask (`1` solid, `0` empty).
//!
//! Disk dilation and erosion run through an exact squared Euclidean distance
//! transform (the separable lower-envelope-of-parabolas method of Felzenszwalb
//! and Huttenlocher), so their cost does not depend on the radius. Component
//! labelling is an explicit-queue flood fill, never recursion.

use std::collections::VecDeque;

/// Stand-in for "no site on this line" in the distance transform.
const FAR: f64 = 1e20;

/// Squared distance from every cell to the nearest cell where `is_site`.
pub(super) fn distance_sq(mask: &[u8], w: usize, h: usize, is_site: impl Fn(u8) -> bool) -> Vec<f32> {
    let mut out = vec![0f32; w * h];
    let n = w.max(h);
    let mut f = vec![0f64; n];
    let mut d = vec![0f64; n];
    let mut v = vec![0usize; n];
    let mut z = vec![0f64; n + 1];
    // Columns first.
    for x in 0..w {
        for y in 0..h {
            f[y] = if is_site(mask[y * w + x]) { 0.0 } else { FAR };
        }
        envelope_1d(&f[..h], &mut d[..h], &mut v, &mut z);
        for y in 0..h {
            out[y * w + x] = d[y] as f32;
        }
    }
    // Then rows over the column result.
    for y in 0..h {
        for x in 0..w {
            f[x] = out[y * w + x] as f64;
        }
        envelope_1d(&f[..w], &mut d[..w], &mut v, &mut z);
        for x in 0..w {
            out[y * w + x] = d[x] as f32;
        }
    }
    out
}

/// 1D squared distance transform of sampled function `f` into `d`.
fn envelope_1d(f: &[f64], d: &mut [f64], v: &mut [usize], z: &mut [f64]) {
    let n = f.len();
    if n == 0 {
        return;
    }
    let mut k = 0usize;
    v[0] = 0;
    z[0] = f64::NEG_INFINITY;
    z[1] = f64::INFINITY;
    for q in 1..n {
        loop {
            let p = v[k];
            let s = ((f[q] + (q * q) as f64) - (f[p] + (p * p) as f64)) / (2.0 * (q as f64 - p as f64));
            if s <= z[k] && k > 0 {
                k -= 1;
                continue;
            }
            if s <= z[k] {
                // k == 0 and the new parabola dominates from -inf.
                v[0] = q;
                z[0] = f64::NEG_INFINITY;
                z[1] = f64::INFINITY;
                break;
            }
            k += 1;
            v[k] = q;
            z[k] = s;
            z[k + 1] = f64::INFINITY;
            break;
        }
    }
    k = 0;
    for (q, dq) in d.iter_mut().enumerate().take(n) {
        while z[k + 1] < q as f64 {
            k += 1;
        }
        let p = v[k];
        let diff = q as f64 - p as f64;
        *dq = diff * diff + f[p];
    }
}

/// Dilate solid cells by a disk of `radius` cells.
fn dilate(mask: &mut [u8], w: usize, h: usize, radius: usize) {
    if radius == 0 {
        return;
    }
    let r2 = (radius * radius) as f32;
    let dist = distance_sq(mask, w, h, |m| m != 0);
    for (m, d) in mask.iter_mut().zip(&dist) {
        *m = u8::from(*d <= r2);
    }
}

/// Erode solid cells by a disk of `radius` cells.
fn erode(mask: &mut [u8], w: usize, h: usize, radius: usize) {
    if radius == 0 {
        return;
    }
    let r2 = (radius * radius) as f32;
    let dist = distance_sq(mask, w, h, |m| m == 0);
    for (m, d) in mask.iter_mut().zip(&dist) {
        *m = u8::from(*d > r2);
    }
}

/// Closing that bridges gaps up to about `2 * radius` cells: dilate by
/// `radius`, erode by one cell less. The plain closing (erode by `radius`)
/// re-opens a gap of even one cell in a one-cell-wide line, because the
/// empty cell `radius` away beside the gap is never reached by the dilation;
/// eroding one cell less keeps such lines joined, at the price of a one-cell
/// outward bias that the snapping stage removes by refitting to the points.
pub(super) fn close(mask: &mut [u8], w: usize, h: usize, radius: usize) {
    dilate(mask, w, h, radius);
    erode(mask, w, h, radius.saturating_sub(1));
}

/// Opening by reconstruction: erode by `radius` to find the cores that can
/// hold the disk, then keep every 8-connected blob that contains a core, in
/// full. Speckle goes; surviving shapes keep their corners and thin parts.
pub(super) fn open_by_reconstruction(mask: &mut [u8], w: usize, h: usize, radius: u32) {
    if radius == 0 {
        return;
    }
    let seeds = if radius == 1 {
        // The radius-1 disk is the plus: a cell and its four neighbours.
        let mut seeds = vec![0u8; w * h];
        for y in 1..h.saturating_sub(1) {
            for x in 1..w - 1 {
                let c = y * w + x;
                if mask[c] != 0 && mask[c - 1] != 0 && mask[c + 1] != 0 && mask[c - w] != 0 && mask[c + w] != 0 {
                    seeds[c] = 1;
                }
            }
        }
        seeds
    } else {
        let mut seeds = mask.to_vec();
        erode(&mut seeds, w, h, radius as usize);
        seeds
    };
    let mut keep = vec![0u8; w * h];
    let mut queue = VecDeque::new();
    for (i, s) in seeds.iter().enumerate() {
        if *s != 0 && keep[i] == 0 {
            keep[i] = 1;
            queue.push_back(i);
            while let Some(c) = queue.pop_front() {
                for n in neighbours8(c, w, h).into_iter().flatten() {
                    if mask[n] != 0 && keep[n] == 0 {
                        keep[n] = 1;
                        queue.push_back(n);
                    }
                }
            }
        }
    }
    mask.copy_from_slice(&keep);
}

/// Fill every 2×2 block whose solid cells touch only diagonally. Afterwards
/// 4- and 8-connectivity agree for both colours, so every lattice vertex lies
/// on at most one boundary loop and the traced loops are disjoint and simple.
pub(super) fn fill_saddles(mask: &mut [u8], w: usize, h: usize) {
    if w < 2 || h < 2 {
        return;
    }
    // One scan finds the saddles; a fix can only create new ones in the
    // blocks around it, so only those are re-checked. Each fix turns at least
    // one empty cell solid, which bounds the loop by the cell count.
    let mut work: Vec<(usize, usize)> = Vec::new();
    for y in 0..h - 1 {
        for x in 0..w - 1 {
            if is_saddle(mask, w, x, y) {
                work.push((x, y));
            }
        }
    }
    while let Some((x, y)) = work.pop() {
        if !is_saddle(mask, w, x, y) {
            continue;
        }
        for (cx, cy) in [(x, y), (x + 1, y), (x, y + 1), (x + 1, y + 1)] {
            mask[cy * w + cx] = 1;
        }
        for by in y.saturating_sub(1)..=(y + 1).min(h - 2) {
            for bx in x.saturating_sub(1)..=(x + 1).min(w - 2) {
                if is_saddle(mask, w, bx, by) {
                    work.push((bx, by));
                }
            }
        }
    }
}

#[inline]
fn is_saddle(mask: &[u8], w: usize, x: usize, y: usize) -> bool {
    let a = mask[y * w + x] != 0;
    let b = mask[y * w + x + 1] != 0;
    let c = mask[(y + 1) * w + x] != 0;
    let d = mask[(y + 1) * w + x + 1] != 0;
    (a && d && !b && !c) || (b && c && !a && !d)
}

/// 4-connected labels of the cells whose value equals `colour`; other cells
/// get `u32::MAX`. Returns the labels and each label's cell count.
pub(super) fn label4(mask: &[u8], w: usize, h: usize, colour: u8) -> (Vec<u32>, Vec<usize>) {
    let mut labels = vec![u32::MAX; w * h];
    let mut sizes = Vec::new();
    let mut queue = VecDeque::new();
    for start in 0..w * h {
        if mask[start] != colour || labels[start] != u32::MAX {
            continue;
        }
        let id = sizes.len() as u32;
        let mut size = 0usize;
        labels[start] = id;
        queue.push_back(start);
        while let Some(c) = queue.pop_front() {
            size += 1;
            for n in neighbours4(c, w, h).into_iter().flatten() {
                if mask[n] == colour && labels[n] == u32::MAX {
                    labels[n] = id;
                    queue.push_back(n);
                }
            }
        }
        sizes.push(size);
    }
    (labels, sizes)
}

/// Component labels of the filtered mask, for the contour tracer.
pub(super) struct Labels {
    /// 4-connected solid component per cell (`u32::MAX` on empty cells).
    pub solid: Vec<u32>,
    /// 4-connected empty region per cell (`u32::MAX` on solid cells).
    pub empty: Vec<u32>,
    /// The empty region outside everything (it holds cell 0, always padding).
    pub outside: u32,
    pub dropped: usize,
    pub filled: usize,
}

/// Clear solid components under `min_solid` cells, then fill enclosed empty
/// regions under `min_empty` cells, and return the labels of the result.
/// A filled hole is enclosed by exactly one solid component (the mask is
/// saddle-free), whose label its cells take.
pub(super) fn filter_components(mask: &mut [u8], w: usize, h: usize, min_solid: usize, min_empty: usize) -> Labels {
    let (mut solid, sizes) = label4(mask, w, h, 1);
    let small: Vec<bool> = sizes.iter().map(|&s| s < min_solid).collect();
    for (m, l) in mask.iter_mut().zip(solid.iter_mut()) {
        if *l != u32::MAX && small[*l as usize] {
            *m = 0;
            *l = u32::MAX;
        }
    }
    let dropped = small.iter().filter(|&&s| s).count();
    let (mut empty, sizes) = label4(mask, w, h, 0);
    let outside = empty.first().copied().unwrap_or(u32::MAX);
    let fill: Vec<bool> = sizes.iter().enumerate().map(|(id, &s)| id as u32 != outside && s < min_empty).collect();
    let filled = fill.iter().filter(|&&f| f).count();
    if filled > 0 {
        let mut owner = vec![u32::MAX; sizes.len()];
        for c in 0..w * h {
            let e = empty[c];
            if e == u32::MAX || !fill[e as usize] || owner[e as usize] != u32::MAX {
                continue;
            }
            if let Some(n) = neighbours4(c, w, h).into_iter().flatten().find(|&n| solid[n] != u32::MAX) {
                owner[e as usize] = solid[n];
            }
        }
        for c in 0..w * h {
            let e = empty[c];
            if e != u32::MAX && fill[e as usize] {
                mask[c] = 1;
                solid[c] = owner[e as usize];
                empty[c] = u32::MAX;
            }
        }
    }
    Labels { solid, empty, outside, dropped, filled }
}

#[inline]
fn neighbours4(c: usize, w: usize, h: usize) -> [Option<usize>; 4] {
    let (x, y) = (c % w, c / w);
    [
        (x > 0).then(|| c - 1),
        (x + 1 < w).then(|| c + 1),
        (y > 0).then(|| c - w),
        (y + 1 < h).then(|| c + w),
    ]
}

#[inline]
fn neighbours8(c: usize, w: usize, h: usize) -> [Option<usize>; 8] {
    let (x, y) = (c % w, c / w);
    let (l, r, d, u) = (x > 0, x + 1 < w, y > 0, y + 1 < h);
    [
        l.then(|| c - 1),
        r.then(|| c + 1),
        d.then(|| c - w),
        u.then(|| c + w),
        (l && d).then(|| c - w - 1),
        (r && d).then(|| c - w + 1),
        (l && u).then(|| c + w - 1),
        (r && u).then(|| c + w + 1),
    ]
}

#[cfg(test)]
#[path = "morph_tests.rs"]
mod tests;
