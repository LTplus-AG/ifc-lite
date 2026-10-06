// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The subtract weld's exact-incidence guard (#6940).
//!
//! # What goes wrong without it
//!
//! The router extends an opening cutter through its host, so a cutter corner
//! that started as a host vertex is no longer one and the exact-vertex
//! exemption stops applying. The corner still lies EXACTLY on the host faces
//! it was extended along (a hole's own walls, when the opening fills a hole
//! the host profile already has). If a second host face runs within the weld
//! band of that corner, the nearest-plane search finds it, because faces the
//! vertex is exactly on are skipped as already reconciled, and the weld moves
//! the corner onto it and so OFF the wall it was on. Cutter wall and host
//! wall stop being coplanar by micrometres, and the arrangement tears.
//!
//! # The rule
//!
//! A weld of a vertex onto target face `f` is refused when the vertex is
//! exactly on a host face `g`, the weld would take it off `g`, and `f` and
//! `g` are two SEPARATE surfaces that COINCIDE at weld tolerance:
//!
//! * coincide: every vertex of `f` is within the band of `g`'s plane and
//!   every vertex of `g` within the band of `f`'s. Over their whole extent
//!   the two faces are what the weld itself calls one surface up to noise. No
//!   angle threshold is involved; the test reuses the band the weld already
//!   decides by ([`Face`]'s `band2`, the one value both read).
//! * separate: no chain of host faces joins `f` to `g`, each face sharing a
//!   vertex with the next (by exact position) and lying wholly within the
//!   band of `f`'s plane or of the plane of a coinciding face the vertex
//!   would leave. A face square or oblique to both ends the chain, so two
//!   hole walls are not joined through the cap they both meet. A sliver
//!   facet whose own plane is ill-conditioned still carries the chain: it is
//!   asked where its vertices are, not where its plane goes.
//!
//! "Exactly on" is the weld's own reading, [`Face::raw_offset`] `== 0.0`: the
//! `f64` evaluation the nearest-plane search skips a face by, not an exact
//! predicate.
//!
//! Why refusing is right there: the weld exists to make a vertex agree with a
//! surface it is noisily near. Here it already agrees EXACTLY with one copy of
//! that surface, and moving it to the other copy cannot make any cutter face
//! coplanar with anything (one moved corner does not carry a triangle onto a
//! plane) while it certainly ends the coplanarity the cutter already had.
//!
//! The host is not moved by the weld, so the answer for one cutter vertex
//! depends on that vertex and the host alone: not on the order of the host
//! faces, nor on what was decided for another vertex.
//!
//! # What it deliberately leaves alone
//!
//! * A target that does not coincide with `g` (the perpendicular end face of
//!   the original #1007 repro, any oblique face, a small facet whose plane
//!   leaves `g`'s band over `g`'s extent): that weld slides the vertex along
//!   `g` or reconciles a real second surface, and is the weld's purpose.
//! * CREASED faces: `f` and `g` coincide but such a chain joins them, so they
//!   are facets of one host face that the snap creased, neighbouring or
//!   further apart. A planar cutter face can be coplanar with only one facet,
//!   and which one it should follow depends on which facet it overlaps, not
//!   on where one corner sits. Refusing there too was measured on real hosts
//!   and is not settled: it closed one torn wall at the right volume, and it
//!   made another, torn before and after, newly depend on the triangulator's
//!   diagonal. So this guard does not decide it and the weld behaves as it
//!   did before; creased faces are not fixed here.
//! * A refused vertex is not welded at all. Trying the next-nearest in-band
//!   plane in `f`'s place was measured over the census corpus and changed no
//!   row, so it is not done.

use super::Face;
use rustc_hash::{FxHashMap, FxHashSet};

/// Exact-position key. `+ 0.0` folds `-0.0` onto `0.0`, so two vertices that
/// compare equal as `f64` share a key.
type Key = [u64; 3];
fn key(p: &[f64; 3]) -> Key {
    [
        (p[0] + 0.0).to_bits(),
        (p[1] + 0.0).to_bits(),
        (p[2] + 0.0).to_bits(),
    ]
}

/// Is every vertex of `a` within the band of `b`'s plane?
fn in_band_of(a: &Face, b: &Face) -> bool {
    a.t.iter().all(|p| {
        let d = b.raw_offset(p);
        (d * d) / b.nn <= b.band2
    })
}

/// In-band of each other over their whole extent.
fn coincide(a: &Face, b: &Face) -> bool {
    in_band_of(a, b) && in_band_of(b, a)
}

/// The guard over one host: [`Guard::refuses`] is the rule in the module docs.
/// Faces are named by their index in the slice it was built over.
pub(super) struct Guard<'a> {
    faces: &'a [Face],
    /// The host faces at each vertex position. Built on first need: most
    /// cutters never reach a coinciding pair.
    at: Option<FxHashMap<Key, Vec<usize>>>,
    /// The last question asked, `(target, faces left)`, and its answer.
    /// Consecutive cutter vertices usually repeat it.
    last: Option<(usize, Vec<usize>, bool)>,
}

impl<'a> Guard<'a> {
    pub(super) fn new(faces: &'a [Face]) -> Self {
        Guard {
            faces,
            at: None,
            last: None,
        }
    }

    /// Is `target` joined to any face of `left` by a chain of host faces,
    /// each sharing a vertex with the next and lying wholly within the band
    /// of the plane of `target` or of a face of `left`?
    ///
    /// Walks outward from `target` and stops at the first face of `left`, so
    /// the cost is the faces of `target`'s surface (and those bordering it)
    /// times the band tests of one face, at most `1 + left.len()`.
    fn joined(&mut self, target: usize, left: &[usize]) -> bool {
        let faces = self.faces;
        let at = self.at.get_or_insert_with(|| {
            let mut at: FxHashMap<Key, Vec<usize>> = FxHashMap::default();
            for (i, h) in faces.iter().enumerate() {
                h.t.iter()
                    .for_each(|p| at.entry(key(p)).or_default().push(i));
            }
            at
        });
        let near = |h: usize| {
            in_band_of(&faces[h], &faces[target])
                || left.iter().any(|&g| in_band_of(&faces[h], &faces[g]))
        };
        let mut seen: FxHashSet<usize> = [target].into_iter().collect();
        let mut stack = vec![target];
        while let Some(a) = stack.pop() {
            for p in &faces[a].t {
                for &b in at.get(&key(p)).map_or(&[][..], Vec::as_slice) {
                    if !seen.insert(b) {
                        continue;
                    }
                    if left.contains(&b) {
                        return true;
                    }
                    if near(b) {
                        stack.push(b);
                    }
                }
            }
        }
        false
    }

    /// Would welding a vertex to `w`, on face `target`'s plane, take it off a
    /// host face in `on` (the faces it is exactly on) and onto a separate
    /// surface that coincides with that face?
    ///
    /// One facet of `target`'s own surface among the coinciding faces the weld
    /// would leave withdraws the refusal: the vertex then sits on a creased
    /// face, the case this guard does not decide.
    pub(super) fn refuses(&mut self, w: &[f64; 3], target: usize, on: &[usize]) -> bool {
        let faces = self.faces;
        let left: Vec<usize> = on
            .iter()
            .copied()
            .filter(|&g| faces[g].raw_offset(w) != 0.0 && coincide(&faces[target], &faces[g]))
            .collect();
        if left.is_empty() {
            return false; // the weld leaves no face it coincides with
        }
        if self
            .last
            .as_ref()
            .is_none_or(|(t, l, _)| *t != target || *l != left)
        {
            let joined = self.joined(target, &left);
            self.last = Some((target, left, joined));
        }
        self.last.as_ref().is_some_and(|(_, _, joined)| !joined)
    }
}

#[cfg(test)]
#[path = "incidence_tests.rs"]
mod tests;
