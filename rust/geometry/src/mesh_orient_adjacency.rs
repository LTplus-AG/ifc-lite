// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Edge incidence construction and traversal for the canonical mesh orienter.

use rustc_hash::FxHashMap;
use std::collections::hash_map::Entry;

const NONE: usize = usize::MAX;
type Edge = (u32, u32);

/// One byte buffer serves both widths, so switching mesh size cannot retain two
/// independent neighbor allocations. Stored values are half-edge offsets; the
/// maximum value in each width is reserved for no traversable neighbor.
#[derive(Default)]
struct Links { bytes: Vec<u8>, width: usize }

impl Links {
    fn reset(&mut self, slots: usize) {
        self.width = if slots <= u16::MAX as usize { 2 } else { 4 };
        self.bytes.clear();
        self.bytes.reserve_exact(slots * self.width);
        self.bytes.resize(slots * self.width, 0xff);
    }

    #[inline]
    fn get(&self, slot: usize) -> usize {
        let start = slot * self.width;
        if self.width == 2 {
            let value = u16::from_ne_bytes(self.bytes[start..start + 2].try_into().unwrap());
            if value == u16::MAX { NONE } else { value as usize }
        } else {
            let value = u32::from_ne_bytes(self.bytes[start..start + 4].try_into().unwrap());
            if value == u32::MAX { NONE } else { value as usize }
        }
    }

    #[inline]
    fn set(&mut self, slot: usize, value: usize) {
        let start = slot * self.width;
        if self.width == 2 {
            self.bytes[start..start + 2].copy_from_slice(&(value as u16).to_ne_bytes());
        } else {
            self.bytes[start..start + 4].copy_from_slice(&(value as u32).to_ne_bytes());
        }
    }
}

/// Dense meshes keep only their first half-edge in the construction map. After
/// a third incidence, NONE means permanently non-manifold. The extraordinary
/// `>u32::MAX` half-edge domain retains exact historical incidence wrap behavior
/// using the same traversal and the original two-word map value (#3988).
enum Storage {
    Dense { first: FxHashMap<Edge, usize>, links: Links },
    Wide(FxHashMap<Edge, EdgeInc>),
}

pub(super) struct EdgeAdjacency {
    storage: Storage,
    #[cfg(test)]
    force_wide: bool,
}

impl Default for EdgeAdjacency {
    fn default() -> Self {
        Self {
            storage: Storage::Dense { first: FxHashMap::default(), links: Links::default() },
            #[cfg(test)]
            force_wide: false,
        }
    }
}

impl EdgeAdjacency {
    pub(super) fn reset(&mut self, triangles: usize) {
        let slots = triangles * 3;
        let wide = slots > u32::MAX as usize;
        #[cfg(test)]
        let wide = wide || self.force_wide;
        if wide != matches!(self.storage, Storage::Wide(_)) {
            // Replacing the variant drops the unused representation; no second
            // large retained map survives an extraordinary-domain transition.
            self.storage = if wide { Storage::Wide(FxHashMap::default()) }
                else { Storage::Dense { first: FxHashMap::default(), links: Links::default() } };
        }
        match &mut self.storage {
            Storage::Dense { first, links } => {
                first.clear();
                first.reserve(triangles * 2);
                links.reset(slots);
            }
            Storage::Wide(edges) => {
                edges.clear();
                edges.reserve(triangles * 2);
            }
        }
    }

    pub(super) fn push(&mut self, edge: Edge, slot: usize) {
        match &mut self.storage {
            Storage::Dense { first, links } => match first.entry(edge) {
                Entry::Vacant(entry) => { entry.insert(slot); }
                Entry::Occupied(mut entry) => {
                    let previous = *entry.get();
                    if previous == NONE { return; }
                    let paired = links.get(previous);
                    if paired == NONE {
                        links.set(previous, slot);
                        links.set(slot, previous);
                    } else {
                        // Invalidate both earlier incidences on the third, even
                        // when they are repeated edges of the same triangle.
                        links.set(previous, NONE);
                        links.set(paired, NONE);
                        *entry.get_mut() = NONE;
                    }
                }
            },
            Storage::Wide(edges) => { edges.entry(edge).or_default().push(slot / 3); }
        }
    }

    /// Return closed-edge status and the original neighbor order. A dense edge
    /// has at most one other triangle; repeated incidences of the same triangle
    /// yield that triangle and are skipped by the unchanged caller.
    #[inline]
    pub(super) fn neighbors(&self, edge: Edge, slot: usize) -> (bool, [usize; 2]) {
        match &self.storage {
            Storage::Dense { links, .. } => {
                let neighbor = links.get(slot);
                (neighbor != NONE, [if neighbor == NONE { NONE } else { neighbor / 3 }, NONE])
            }
            Storage::Wide(edges) => {
                let inc = &edges[&edge];
                let mut neighbors = [NONE; 2];
                if inc.count() <= 2 {
                    for (target, &source) in neighbors.iter_mut().zip(inc.incident()) { *target = source; }
                }
                (inc.count() == 2, neighbors)
            }
        }
    }

    #[cfg(test)]
    pub(super) fn wide_for_test() -> Self {
        Self { storage: Storage::Wide(FxHashMap::default()), force_wide: true }
    }
}

/// #3988: two incident triangles fit in two words. Once there are more than
/// two, traversal skips the edge, so the first word can hold the incidence
/// count instead. Triangle indices are below `indices.len() / 3`, hence cannot
/// equal either sentinel, including on wasm32. Preserve u32 overflow behavior.
#[derive(Clone, Copy)]
pub(super) struct EdgeInc { pub(super) tris: [usize; 2] }

impl Default for EdgeInc {
    fn default() -> Self { Self { tris: [usize::MAX; 2] } }
}

impl EdgeInc {
    pub(super) const NONMANIFOLD: usize = usize::MAX - 1;

    #[inline]
    pub(super) fn push(&mut self, t: usize) {
        if self.tris[1] == Self::NONMANIFOLD {
            let count = self.tris[0] as u32 + 1;
            if count == 0 { *self = Self::default(); }
            else { self.tris[0] = count as usize; }
        } else if self.tris[0] == usize::MAX {
            self.tris[0] = t;
        } else if self.tris[1] == usize::MAX {
            self.tris[1] = t;
        } else {
            self.tris = [3, Self::NONMANIFOLD];
        }
    }

    #[inline]
    pub(super) fn count(&self) -> u32 {
        if self.tris[1] == Self::NONMANIFOLD { self.tris[0] as u32 }
        else if self.tris[0] == usize::MAX { 0 }
        else if self.tris[1] == usize::MAX { 1 }
        else { 2 }
    }

    /// Called only after the non-manifold path has been skipped.
    #[inline]
    pub(super) fn incident(&self) -> &[usize] { &self.tris[..self.count() as usize] }
}
