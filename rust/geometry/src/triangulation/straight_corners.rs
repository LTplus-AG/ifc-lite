// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Corners every face of a polygonal set agrees are straight.
//!
//! A ring corner lying on the segment between its neighbours adds no shape. It
//! only decides whether the two ring edges meeting there are triangle edges: an
//! ear-clipper keeps the corner on one projection and cuts a zero-area ear
//! (which the CSG hygiene drops, together with both edges) or filters it out on
//! another, so the same face set closed under one triangulator and tore under
//! the other (rvt01 #11477, #11168, MiniBIM walls; #7809, #7826).
//!
//! The choice cannot be made face by face: dropping the corner from one face
//! while its neighbour keeps it opens a T-junction, and keeping it where the
//! neighbour dropped it does the same. A corner is therefore dissolved from
//! EVERY face that carries it, or from none, and only when each of them sees it
//! straight. A face set that splits a long edge in all its faces and has a real
//! corner there in one of them keeps its split; a chain that is merely
//! collinear everywhere is merged once, consistently, and no ear-clipper can
//! tear it.
//!
//! Where the merge applies is bounded by what the census measured. Corners of
//! small faces ([`SMALL_RING_CORNERS`]) always dissolve. A larger face (a wall
//! elevation with door notches, up to [`MAX_RING_CORNERS`]) gives up a corner
//! only where the exact-axis ear-clip actually loses a ring edge there, and a
//! face beyond that, or one with holes, pins all its corners. Merging more
//! than that moved voided walls across the 1 mm topology snap and tore hosts
//! that were closed (MiniBIM #150695, rvt01 #26166, #26832, #37455).

use crate::Point3;
use rustc_hash::FxHashMap;

/// Offset of a corner from the line through its neighbours, relative to the
/// neighbours' distance, below which the corner counts as straight (`1e-6`:
/// 1 micrometre per metre, far under the 1 mm topology snap).
const STRAIGHT_TOLERANCE: f64 = 1e-6;

/// Height of a triangle, relative to its longest edge, at or below which
/// [`StraightCorners::settle`] calls it a zero-area ear. Looser than
/// [`STRAIGHT_TOLERANCE`]: the positions are f32, so a corner the straightness
/// test rejects as noise (rebased georeferenced points carry ~1e-5 of it) can
/// still be cut as an ear whose winding is that noise. Erring here only keeps
/// a ring whole.
const SLIVER_TOLERANCE: f64 = 1e-4;

/// Rings up to this many corners dissolve every straight corner (the bound the
/// convex-polygon fast paths use for "a small face").
pub const SMALL_RING_CORNERS: usize = 8;

/// Rings above this many corners never take part.
pub const MAX_RING_CORNERS: usize = 32;

type Key = [u64; 3];

fn key(p: &Point3<f64>) -> Key {
    [p.x.to_bits(), p.y.to_bits(), p.z.to_bits()]
}

/// Is `b` on the segment `a`-`c` (strictly between, within tolerance)?
fn is_straight(a: &Point3<f64>, b: &Point3<f64>, c: &Point3<f64>) -> bool {
    let ac = c - a;
    let len2 = ac.norm_squared();
    if !(len2 > 0.0) {
        return false;
    }
    let ab = b - a;
    let t = ab.dot(&ac) / len2;
    if !(t > 0.0 && t < 1.0) {
        return false;
    }
    (ab - ac * t).norm() <= STRAIGHT_TOLERANCE * len2.sqrt()
}

/// Does the triangulation the polygonal processor gives this hole-free ring
/// (the quad split for four corners, the planar-face home past that) contain
/// a triangle whose height is within [`SLIVER_TOLERANCE`] of its longest
/// edge, i.e. a zero-area ear, or fewer triangles than the ring needs?
fn cuts_a_sliver(ring: &[Point3<f64>]) -> bool {
    let idx: Vec<u32> = match ring.len() {
        0..=3 => return false,
        4 => super::quad_split_3d(ring).to_vec(),
        _ => match super::triangulate_planar_face(ring, &[]) {
            Ok(idx) => idx,
            Err(_) => return false,
        },
    };
    idx.len() != 3 * (ring.len() - 2) || idx.chunks_exact(3).any(|t| {
        let [a, b, c] = [t[0], t[1], t[2]].map(|i| ring.get(i as usize));
        let (Some(a), Some(b), Some(c)) = (a, b, c) else { return false };
        let longest2 = (b - a).norm_squared().max((c - b).norm_squared()).max((a - c).norm_squared());
        (b - a).cross(&(c - a)).norm() <= SLIVER_TOLERANCE * longest2
    })
}

#[derive(Clone, Copy)]
struct Corner {
    /// Every ring that carries the position sees it straight.
    straight: bool,
    /// Some ring's exact-axis ear-clip loses a ring edge there.
    loses_edge: bool,
    /// Corners of the largest ring that carries it.
    largest_ring: usize,
}

impl Corner {
    fn dissolves(&self) -> bool {
        self.straight && (self.largest_ring <= SMALL_RING_CORNERS || self.loses_edge)
    }
}

type Cell = [i64; 3];

/// Straightness of every corner position over the rings noted so far.
#[derive(Default)]
pub struct StraightCorners {
    corners: FxHashMap<Key, Corner>,
    /// Weld cell size: positions closer than this may be one vertex to the
    /// mesh weld downstream, so a corner dissolves only when every position in
    /// its own and the neighbouring cells dissolves too. A near-duplicate that
    /// another face pins would otherwise keep a corner its twin dropped and
    /// open a T-junction. `0` (the default) compares exact positions only.
    weld: f64,
    cells: FxHashMap<Cell, Vec<Key>>,
}

impl StraightCorners {
    /// A set whose positions within `weld` of each other agree on every
    /// dissolve (see [`StraightCorners::weld`]). Grouping more positions only
    /// keeps more corners, so a generous `weld` is safe.
    pub fn with_weld(weld: f64) -> Self {
        Self { weld: if weld.is_finite() && weld > 0.0 { weld } else { 0.0 }, ..Self::default() }
    }

    fn cell(&self, p: &Point3<f64>) -> Cell {
        [p.x, p.y, p.z].map(|v| (v / self.weld).floor() as i64)
    }

    /// Record one ring. `keep_all` marks a ring whose corners must stay (a face
    /// with holes, which the caller does not filter): every corner of it is
    /// then a real corner for the set. So is every corner of a ring over
    /// [`MAX_RING_CORNERS`].
    pub fn note_ring(&mut self, ring: &[Point3<f64>], keep_all: bool) {
        let n = ring.len();
        let takes_part = !keep_all && (4..=MAX_RING_CORNERS).contains(&n);
        let straight: Vec<bool> = (0..n)
            .map(|i| takes_part && is_straight(&ring[(i + n - 1) % n], &ring[i], &ring[(i + 1) % n]))
            .collect();
        // Only a ring that has a straight corner needs the ear-clip asked.
        let loses_edge = if n > SMALL_RING_CORNERS && straight.contains(&true) {
            super::corners_losing_an_edge(ring)
        } else {
            vec![false; n]
        };
        for i in 0..n {
            let k = key(&ring[i]);
            let corner = self.corners.entry(k).or_insert_with(|| Corner {
                straight: true,
                loses_edge: false,
                largest_ring: 0,
            });
            let fresh = corner.largest_ring == 0;
            corner.straight &= straight[i];
            corner.loses_edge |= straight[i] && loses_edge[i];
            corner.largest_ring = corner.largest_ring.max(n);
            if fresh && self.weld > 0.0 {
                let c = self.cell(&ring[i]);
                self.cells.entry(c).or_default().push(k);
            }
        }
    }

    /// Does the corner at `p` leave every ring that carries it?
    fn dissolves(&self, p: &Point3<f64>) -> bool {
        if !self.corners.get(&key(p)).is_some_and(Corner::dissolves) {
            return false;
        }
        if self.weld == 0.0 {
            return true;
        }
        let [x, y, z] = self.cell(p);
        (-1..=1).all(|dx| {
            (-1..=1).all(|dy| {
                (-1..=1).all(|dz| {
                    let c = [x.saturating_add(dx), y.saturating_add(dy), z.saturating_add(dz)];
                    self.cells.get(&c).is_none_or(|keys| {
                        keys.iter().all(|k| self.corners.get(k).is_some_and(Corner::dissolves))
                    })
                })
            })
        })
    }

    /// Settle the set over its hole-free `rings` (the ones the caller filters).
    ///
    /// Which ears a triangulator cuts is decided on the whole ring, so it can
    /// change once some corners are gone: a reduced ring may cut a zero-area
    /// ear at a straight corner another face pins, which the whole ring never
    /// had (CSG hygiene drops that ear and both its ring edges, or its winding
    /// is noise). Such a ring keeps all its corners instead, which pins them
    /// in every other ring too, so this repeats until no ring changes. It
    /// only ever keeps more corners, so it ends, and at worst gives the face
    /// set back its authored rings.
    pub fn settle(&mut self, rings: &[Vec<Point3<f64>>]) {
        let mut pinned = vec![false; rings.len()];
        loop {
            let mut changed = false;
            for (r, ring) in rings.iter().enumerate() {
                if pinned[r] {
                    continue;
                }
                let Some(kept) = self.kept_corners(ring) else { continue };
                let reduced: Vec<Point3<f64>> = kept.iter().map(|&i| ring[i]).collect();
                if cuts_a_sliver(&reduced) {
                    for p in ring {
                        if let Some(c) = self.corners.get_mut(&key(p)) {
                            c.straight = false;
                        }
                    }
                    pinned[r] = true;
                    changed = true;
                }
            }
            if !changed {
                return;
            }
        }
    }

    /// The ring without the corners the whole set agrees to dissolve, as
    /// indices into `ring`, or `None` when nothing is dissolved (or fewer than
    /// three corners would remain, which keeps the ring whole).
    ///
    /// A ring left with four corners, one of them a straight corner another
    /// face pins, starts AT that corner: the quad split takes the `0-2`
    /// diagonal when vertices 1 and 3 agree in convexity (a straight one
    /// agrees with either), so a straight vertex 1 or 3 would be cut off as a
    /// zero-area ear of arbitrary winding. That ear is the tear this module
    /// removes; the ring it came from was ear-clipped whole, which never made it.
    pub fn kept_corners(&self, ring: &[Point3<f64>]) -> Option<Vec<usize>> {
        let mut kept: Vec<usize> = (0..ring.len()).filter(|&i| !self.dissolves(&ring[i])).collect();
        if !(kept.len() >= 3 && kept.len() < ring.len()) {
            return None;
        }
        if kept.len() == 4 {
            let at = |i: usize| &ring[kept[i % 4]];
            if let Some(s) = (0..4).find(|&i| is_straight(at(i + 3), at(i), at(i + 1))) {
                kept.rotate_left(s);
            }
        }
        Some(kept)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(x: f64, y: f64) -> Point3<f64> {
        Point3::new(x, y, 0.0)
    }

    #[test]
    fn a_corner_every_ring_sees_straight_is_dissolved_and_a_shared_corner_is_kept() {
        // Two rectangles sharing the edge x = 1, both splitting it at y = 1.
        let left = [p(0.0, 0.0), p(1.0, 0.0), p(1.0, 1.0), p(1.0, 2.0), p(0.0, 2.0)];
        let right = [p(1.0, 0.0), p(2.0, 0.0), p(2.0, 2.0), p(1.0, 2.0), p(1.0, 1.0)];
        let mut set = StraightCorners::default();
        set.note_ring(&left, false);
        set.note_ring(&right, false);
        assert_eq!(set.kept_corners(&left), Some(vec![0, 1, 3, 4]));
        assert_eq!(set.kept_corners(&right), Some(vec![0, 1, 2, 3]));

        // A third face turning at (1, 1) makes it a real corner: nothing goes.
        let cap = [p(1.0, 1.0), p(3.0, 1.0), p(3.0, 3.0), p(1.0, 3.0)];
        set.note_ring(&cap, false);
        assert_eq!(set.kept_corners(&left), None);
        assert_eq!(set.kept_corners(&right), None);
    }

    #[test]
    fn a_near_duplicate_another_face_pins_keeps_its_twin() {
        // `left` sees (1, 1) straight; a triangle turns at a position 1e-7
        // away, which the mesh weld will merge with it. Dropping (1, 1) from
        // `left` alone would open a T-junction against that triangle.
        let left = [p(0.0, 0.0), p(1.0, 0.0), p(1.0, 1.0), p(1.0, 2.0), p(0.0, 2.0)];
        let fan = [p(1.0, 1.0 + 1e-7), p(2.0, 0.0), p(2.0, 2.0)];
        let mut exact = StraightCorners::default();
        let mut welded = StraightCorners::with_weld(1e-5);
        for set in [&mut exact, &mut welded] {
            set.note_ring(&left, false);
            set.note_ring(&fan, false);
        }
        assert_eq!(exact.kept_corners(&left), Some(vec![0, 1, 3, 4]));
        assert_eq!(welded.kept_corners(&left), None);
    }

    #[test]
    fn a_ring_kept_whole_pins_its_corners() {
        let ring = [p(0.0, 0.0), p(1.0, 0.0), p(2.0, 0.0), p(2.0, 2.0), p(0.0, 2.0)];
        let hole_face = [p(1.0, 0.0), p(1.0, -1.0), p(0.0, -1.0), p(0.0, -0.5)];
        let mut set = StraightCorners::default();
        set.note_ring(&ring, false);
        assert_eq!(set.kept_corners(&ring), Some(vec![0, 2, 3, 4]));
        set.note_ring(&hole_face, true);
        assert_eq!(set.kept_corners(&ring), None);
    }

    #[test]
    fn a_spike_or_a_line_is_never_straight() {
        let spike = [p(0.0, 0.0), p(2.0, 0.0), p(1.0, 0.0), p(1.0, 1.0)];
        let mut set = StraightCorners::default();
        set.note_ring(&spike, false);
        assert_eq!(set.kept_corners(&spike), None);
        let line = [p(0.0, 0.0), p(1.0, 0.0), p(2.0, 0.0), p(3.0, 0.0)];
        let mut set = StraightCorners::default();
        set.note_ring(&line, false);
        assert_eq!(set.kept_corners(&line), None);
    }

    #[test]
    fn a_larger_ring_gives_up_a_corner_only_where_the_ear_clip_loses_an_edge() {
        // 9 corners: a chain on the bottom edge. The exact-axis ear-clip keeps
        // every ring edge of this simple ring, so nothing dissolves; the ring
        // over the bound pins even that.
        let wall = [
            p(0.0, 0.0), p(1.0, 0.0), p(2.0, 0.0), p(3.0, 0.0), p(4.0, 0.0),
            p(4.0, 1.0), p(3.0, 1.0), p(1.0, 1.0), p(0.0, 1.0),
        ];
        let mut set = StraightCorners::default();
        set.note_ring(&wall, false);
        assert!(wall.len() > SMALL_RING_CORNERS);
        assert_eq!(set.kept_corners(&wall), None);

        let mut huge = Vec::new();
        for i in 0..=MAX_RING_CORNERS as i32 {
            huge.push(p(f64::from(i), 0.0));
        }
        huge.extend([p(MAX_RING_CORNERS as f64, 1.0), p(0.0, 1.0)]);
        let mut set = StraightCorners::default();
        set.note_ring(&huge, false);
        assert_eq!(set.kept_corners(&huge), None);
    }
}
