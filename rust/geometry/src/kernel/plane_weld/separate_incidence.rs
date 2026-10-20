// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The opening weld's exact-incidence guards (#6940, #7635).
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
//! That the corner starts as a host vertex is not a given: in some vertex
//! frames it arrives one snap step off, on neither wall, and this guard has
//! nothing exact to keep. The void router makes the two one vertex again
//! before it extends the cutter (`router/voids/synthesis/host_vertices.rs`);
//! the two rules are needed together, and neither closes the slabs alone.
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
//! depends on its original geometry: not on what was decided for another
//! vertex. The finite certificate below also reads original cutter edges.
//!
//! # Finite source-wall certificate (#7635)
//!
//! A distant target can leave the source plane's band beyond the existing
//! wall. Mutual coincidence then fails even though welding would break an
//! exact finite wall incidence. The additional `refuses_finite` rule requires
//! finite, noncollapsed original operands with exactly one opposite pair of
//! uses per edge. This necessary closed-edge prerequisite does not certify
//! solid validity or vertex manifoldness. Uncertified inputs retain the
//! established coincidence rule. The local certificate then requires
//! a complete manifold host arris contained in an original manifold cutter
//! arris, with an incident cutter face exactly coplanar with the source face.
//! Both arrises have two opposite edge uses and noncoplanar incident faces.
//! The entire source face must remain inside the target's existing band, and
//! the same connectivity test must certify separate surfaces. A common line
//! without finite containment, or crossing cutter faces, supplies no proof.
//!
//! # What it deliberately leaves alone
//!
//! * Without the finite source-wall certificate, a target that does not
//!   coincide with `g` (the perpendicular end face of
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

pub(super) use super::selection::Face;
use crate::kernel::budget::incidence_work as work;
use rustc_hash::{FxHashMap, FxHashSet};

/// Exact-position key. `+ 0.0` folds `-0.0` onto `0.0`, so two vertices that
/// compare equal as `f64` share a key.
pub(super) type Key = [u64; 3];
pub(super) fn key(p: &[f64; 3]) -> Key {
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
#[cfg(test)]
fn coincide(a: &Face, b: &Face) -> bool {
    in_band_of(a, b) && in_band_of(b, a)
}

// Reserve the three possible vertex-plane checks before entering the exact
// original short-circuit predicate. Unused reserved units are not refunded.
fn checked_band(a: &Face, b: &Face) -> Result<bool, work::Exhausted> {
    work::spend(a.t.len())?;
    Ok(in_band_of(a, b))
}

/// The guard over one host: [`Guard::refuses`] is the rule in the module docs.
/// Faces are named by their index in the slice it was built over.
pub(super) struct Guard<'a> {
    faces: &'a [Face],
    source_host: &'a [super::Tri],
    finite_edges: Option<super::finite::Edges>,
    /// The host faces at each vertex position. Built on first need: most
    /// cutters never reach a coinciding pair.
    at: Option<FxHashMap<Key, Vec<usize>>>,
    /// The last question asked, `(target, faces left)`, and its answer.
    /// Consecutive cutter vertices usually repeat it.
    last: Option<(usize, Vec<usize>, bool)>,
    /// Actual adjacency entries visited by the last joined traversal.
    #[cfg(test)]
    adjacency_entries: usize,
}

impl<'a> Guard<'a> {
    pub(super) fn new(faces: &'a [Face], source_host: &'a [super::Tri]) -> Self {
        Guard {
            faces,
            source_host,
            finite_edges: None,
            at: None,
            last: None,
            #[cfg(test)]
            adjacency_entries: 0,
        }
    }

    /// Is `target` joined to any face of `left` by a chain of host faces,
    /// each sharing a vertex with the next and lying wholly within the band
    /// of the plane of `target` or of a face of `left`?
    ///
    /// Walks outward from `target` and stops at the first face of `left`, so
    /// each vertex adjacency list expands once, including at high-valence
    /// vertices. Face band tests run at most once per encountered face,
    /// each against at most `1 + left.len()` planes.
    fn joined(&mut self, target: usize, left: &[usize]) -> Result<bool, work::Exhausted> {
        #[cfg(test)]
        { self.adjacency_entries = 0; }
        let faces = self.faces;
        if self.at.is_none() {
            let mut at: FxHashMap<Key, Vec<usize>> = FxHashMap::default();
            for (i, h) in faces.iter().enumerate() {
                for p in &h.t {
                    work::spend(1)?;
                    at.entry(key(p)).or_default().push(i);
                }
            }
            self.at = Some(at);
        }
        let at = self.at.as_ref().expect("complete adjacency index");
        let mut left_set = FxHashSet::default();
        for &g in left { work::spend(1)?; left_set.insert(g); }
        let near = |h: usize| -> Result<bool, work::Exhausted> {
            if checked_band(&faces[h], &faces[target])? { return Ok(true); }
            for &g in left {
                if checked_band(&faces[h], &faces[g])? { return Ok(true); }
            }
            Ok(false)
        };
        let mut seen: FxHashSet<usize> = [target].into_iter().collect();
        let mut expanded_vertices: FxHashSet<Key> = FxHashSet::default();
        let mut stack = vec![target];
        while let Some(a) = stack.pop() {
            for p in &faces[a].t {
                work::spend(1)?;
                let k = key(p);
                if !expanded_vertices.insert(k) {
                    continue;
                }
                for &b in at.get(&k).map_or(&[][..], Vec::as_slice) {
                    work::spend(1)?;
                    #[cfg(test)]
                    { self.adjacency_entries += 1; }
                    if !seen.insert(b) {
                        continue;
                    }
                    if left_set.contains(&b) {
                        return Ok(true);
                    }
                    if near(b)? {
                        stack.push(b);
                    }
                }
            }
        }
        Ok(false)
    }

    /// Admit only the original complete closed edge soup. `Face::new` can
    /// omit invalid faces, so its filtered list cannot establish this fact.
    /// The same lazy map supplies the finite arris queries below.
    fn finite_edges(&mut self) -> Result<&super::finite::Edges, work::Exhausted> {
        if self.finite_edges.is_none() {
            self.finite_edges = Some(super::finite::Edges::new(self.source_host.iter())?);
        }
        Ok(self.finite_edges.as_ref().expect("complete finite edge index"))
    }

    pub(super) fn closed_edge_incidence(&mut self) -> Result<bool, work::Exhausted> {
        Ok(self.finite_edges()?.closed_edge_incidence())
    }

    /// #7635: a finite cutter arris contains an existing host arris. A remote
    /// target need not stay near the host plane beyond that finite incidence,
    /// but the whole source face must still be in its existing weld band.
    /// An incident cutter face must be exactly coplanar with this source face.
    /// Connected creased surfaces retain the original weld policy.
    pub(super) fn refuses_finite(
        &mut self, v: &[f64; 3], w: &[f64; 3], target: usize, on: &[usize],
        cutter: &super::finite::CutterEdges,
    ) -> Result<bool, work::Exhausted> {
        let faces = self.faces;
        let mut left = Vec::new();
        for &g in on {
            work::spend(1)?;
            if faces[g].raw_offset(w) == 0.0 || !checked_band(&faces[g], &faces[target])? {
                continue;
            }
            for i in 0..3 {
                work::spend(1)?;
                let (a, b) = (&faces[g].t[i], &faces[g].t[(i + 1) % 3]);
                if cutter.contains(v, a, b, &faces[g].t)?
                    && self.finite_edges()?.is_arris(a, b)
                {
                    left.push(g);
                    break;
                }
            }
        }
        if left.is_empty() { Ok(false) } else { self.separate(target, left) }
    }

    /// Would welding a vertex to `w`, on face `target`'s plane, take it off a
    /// host face in `on` (the faces it is exactly on) and onto a separate
    /// surface that coincides with that face?
    ///
    /// One facet of `target`'s own surface among the coinciding faces the weld
    /// would leave withdraws the refusal: the vertex then sits on a creased
    /// face, the case this guard does not decide.
    pub(super) fn refuses(&mut self, w: &[f64; 3], target: usize, on: &[usize]) -> Result<bool, work::Exhausted> {
        let faces = self.faces;
        let mut left = Vec::new();
        for &g in on {
            work::spend(1)?;
            if faces[g].raw_offset(w) != 0.0 && checked_band(&faces[target], &faces[g])?
                && checked_band(&faces[g], &faces[target])? { left.push(g); }
        }
        if left.is_empty() {
            return Ok(false); // the weld leaves no face it coincides with
        }
        self.separate(target, left)
    }

    fn separate(&mut self, target: usize, left: Vec<usize>) -> Result<bool, work::Exhausted> {
        work::spend(left.len())?; // bound the cached question comparison too
        if self
            .last
            .as_ref()
            .is_none_or(|(t, l, _)| *t != target || *l != left)
        {
            let joined = self.joined(target, &left)?;
            self.last = Some((target, left, joined));
        }
        Ok(self.last.as_ref().is_some_and(|(_, _, joined)| !joined))
    }
}


impl Guard<'_> {
    pub(super) fn retains(&mut self, original: [f64; 3], target: [f64; 3], selected: super::Tri, cutter: Option<&super::finite::CutterEdges>) -> Result<bool, work::Exhausted> {
        let mut face_index = None;
        let mut on = Vec::new();
        for (i, face) in self.faces.iter().enumerate() {
            work::spend(1)?;
            if face_index.is_none() && face.t == selected { face_index = Some(i); }
            if face.raw_offset(&original) == 0.0 { on.push(i); }
        }
        let index = face_index.expect("selected nondegenerate host face is present");
        if self.refuses(&target, index, &on)? { return Ok(false); }
        if let Some(edges) = cutter {
            if !on.is_empty() && edges.closed_edge_incidence()
                && self.refuses_finite(&original, &target, index, &on, edges)?
                && self.closed_edge_incidence()? { return Ok(false); }
        }
        Ok(true)
    }
}

#[cfg(test)]
#[path = "separate_incidence_tests.rs"]
mod tests;
