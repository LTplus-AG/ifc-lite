// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Fast STEP list decoding into caller-owned scratch (#3988). The owned-return
//! accessors use the same fill routines; only scratch ownership differs.

use super::{parse_cartesian_point_inline, EntityDecoder};
use crate::parser::StepRecord;

impl EntityDecoder<'_> {
    /// Extract entity reference IDs from a raw list attribute, in authored order.
    #[inline]
    pub fn get_entity_ref_list_fast(&mut self, entity_id: u32) -> Option<Vec<u32>> {
        let mut ids = Vec::new();
        self.get_entity_ref_list_fast_into(entity_id, &mut ids)?;
        Some(ids)
    }

    /// Replace `ids` with the same list as [`Self::get_entity_ref_list_fast`],
    /// reusing its allocation. Duplicates retain authored order. An item that
    /// is not exactly one reference (an id above `u32::MAX` included) refuses
    /// the whole list: a shell with a face dropped is an open shell, not a
    /// smaller one (D3). On `None`, `ids` is empty. The caller owns the scratch lifetime.
    #[inline]
    pub fn get_entity_ref_list_fast_into(&mut self, entity_id: u32, ids: &mut Vec<u32>) -> Option<()> {
        // Pattern: IFCTYPE((#id1,#id2,...)); or IFCTYPE((#id1,#id2,...),other);
        ids.clear();
        ids.reserve(32);
        StepRecord::parse(self.get_raw_bytes(entity_id)?)?.ref_list_at(0, ids)?;
        if ids.is_empty() {
            None
        } else {
            Some(())
        }
    }

    /// Extract PolyLoop coordinates with the decoder's existing point cache.
    #[inline]
    pub fn get_polyloop_coords_cached(&mut self, entity_id: u32) -> Option<Vec<(f64, f64, f64)>> {
        let mut coords = Vec::new();
        self.get_polyloop_coords_cached_into(entity_id, &mut coords)?;
        Some(coords)
    }

    /// Replace `coords` with [`Self::get_polyloop_coords_cached`]'s ordered result,
    /// reusing its allocation and the same point-cache policy and counters.
    /// Missing/oversized point refs invalidate the whole loop. On `None`, the
    /// buffer is empty; resolved points remain cached, as with the owned accessor.
    #[inline]
    pub fn get_polyloop_coords_cached_into(
        &mut self, entity_id: u32, coords: &mut Vec<(f64, f64, f64)>,
    ) -> Option<()> {
        coords.clear();
        // Builds the index once and refuses a span outside the content (#4697).
        let bytes = self.get_raw_bytes(entity_id)?;
        let index = self.entity_index.as_ref()?;
        let bytes_full = self.content;

        // IFCPOLYLOOP((#id1,#id2,#id3,...)); every item must be one reference
        // that names a point, or the whole loop is refused.
        coords.reserve(8);
        let point_cache = &mut self.point_cache;
        let (hits, misses) = (&mut self.point_cache_hits, &mut self.point_cache_misses);
        let read = StepRecord::parse(bytes)?.try_each_ref_at(0, |point_id| {
            if let Some(&coord) = point_cache.get(&point_id) {
                *hits += 1;
                coords.push(coord);
                return true;
            }
            // Not in cache - parse and cache; a point that does not resolve
            // invalidates the whole polygon.
            let Some(coord) = index
                .lookup(point_id)
                .and_then(|(start, end)| bytes_full.get(start..end))
                .and_then(parse_cartesian_point_inline)
            else {
                return false;
            };
            *misses += 1;
            point_cache.insert(point_id, coord);
            coords.push(coord);
            true
        });
        if read.is_some() && coords.len() >= 3 {
            Some(())
        } else {
            coords.clear();
            None
        }
    }
}

impl EntityDecoder<'_> {
    /// Why a polyloop's fast read failed, when the reason is input admission
    /// (#7678): the counted refusal for the first point that holds a REAL `f64`
    /// cannot represent (`1.E400`), in either decoder mode. `None` when no
    /// point does, so a caller keeps its own policy for a genuinely corrupt
    /// loop. Lets a reader that skips an unreadable loop fail the whole item
    /// instead of silently opening a closed shell.
    pub fn polyloop_refusal(&mut self, loop_id: u32) -> Option<crate::Error> {
        for point_id in self.get_polyloop_point_ids_fast(loop_id)? {
            let Ok(point) = self.decode_by_id_lossless(point_id) else { continue };
            let holds_overflow = point.get(0).and_then(|a| a.as_list()).is_some_and(|coords| {
                coords.iter().any(|v| v.as_float().is_some_and(|f| !f.is_finite()))
            });
            if holds_overflow {
                return Some(self.refuse_record(point_id));
            }
        }
        None
    }
}

#[cfg(test)]
#[path = "fast_buffers_tests.rs"]
mod tests;
