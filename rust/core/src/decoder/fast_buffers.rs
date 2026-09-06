// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Fast STEP list decoding into caller-owned scratch (#3988). The owned-return
//! accessors use the same fill routines; only scratch ownership differs.

use super::{parse_cartesian_point_inline, EntityDecoder};

impl EntityDecoder<'_> {
    /// Extract entity reference IDs from a raw list attribute, in authored order.
    #[inline]
    pub fn get_entity_ref_list_fast(&mut self, entity_id: u32) -> Option<Vec<u32>> {
        let mut ids = Vec::new();
        self.get_entity_ref_list_fast_into(entity_id, &mut ids)?;
        Some(ids)
    }

    /// Replace `ids` with the same list as [`Self::get_entity_ref_list_fast`],
    /// reusing its allocation. Duplicates retain authored order; oversized refs
    /// are dropped. On `None`, `ids` is empty. The caller owns the scratch lifetime.
    #[inline]
    pub fn get_entity_ref_list_fast_into(&mut self, entity_id: u32, ids: &mut Vec<u32>) -> Option<()> {
        ids.clear();
        let bytes = self.get_raw_bytes(entity_id)?;

        // Pattern: IFCTYPE((#id1,#id2,...)); or IFCTYPE((#id1,#id2,...),other);
        let mut i = 0;
        let len = bytes.len();

        // Skip to first '(' after '='
        while i < len && bytes[i] != b'(' {
            i += 1;
        }
        if i >= len {
            return None;
        }
        i += 1; // Skip first '('

        // Skip to second '(' for the list
        while i < len && bytes[i] != b'(' {
            i += 1;
        }
        if i >= len {
            return None;
        }
        i += 1; // Skip second '('

        // Parse entity IDs
        ids.reserve(32);

        while i < len {
            // Skip whitespace and commas
            while i < len
                && (bytes[i] == b' ' || bytes[i] == b',' || bytes[i] == b'\n' || bytes[i] == b'\r')
            {
                i += 1;
            }

            if i >= len || bytes[i] == b')' {
                break;
            }

            // Expect '#' followed by number
            if bytes[i] == b'#' {
                i += 1;
                let start = i;
                while i < len && bytes[i].is_ascii_digit() {
                    i += 1;
                }
                if i > start {
                    // Shared checked accumulator (#3421): an oversized id is dropped, not wrapped.
                    if let Some(id) = crate::express_id::parse_express_id(&bytes[start..i]) {
                        ids.push(id);
                    }
                }
            } else {
                i += 1; // Skip unknown character
            }
        }

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
        // Ensure index is built once
        self.build_index();
        let index = self.entity_index.as_ref()?;
        let bytes_full = self.content;

        // Get polyloop raw bytes
        let (start, end) = index.lookup(entity_id)?;
        let bytes = &bytes_full[start..end];

        // IFCPOLYLOOP((#id1,#id2,#id3,...));
        let mut i = 0;
        let len = bytes.len();

        // Skip to first '(' after '='
        while i < len && bytes[i] != b'(' {
            i += 1;
        }
        if i >= len {
            return None;
        }
        i += 1; // Skip first '('

        // Skip to second '(' for the point list
        while i < len && bytes[i] != b'(' {
            i += 1;
        }
        if i >= len {
            return None;
        }
        i += 1; // Skip second '('

        // Parse point IDs and fetch coordinates (with caching)
        // CRITICAL: Track expected count to ensure all points are resolved
        coords.reserve(8);
        let mut expected_count = 0u32;

        while i < len {
            // Skip whitespace and commas
            while i < len
                && (bytes[i] == b' ' || bytes[i] == b',' || bytes[i] == b'\n' || bytes[i] == b'\r')
            {
                i += 1;
            }

            if i >= len || bytes[i] == b')' {
                break;
            }

            // Expect '#' followed by number
            if bytes[i] == b'#' {
                i += 1;
                let id_start = i;
                while i < len && bytes[i].is_ascii_digit() {
                    i += 1;
                }
                if i > id_start {
                    expected_count += 1; // Count every point ID we encounter

                    // Shared checked accumulator (#3421): `expected_count`
                    // was already bumped, so a refused id here trips the
                    // `coords.len() == expected_count` check below, same as
                    // any other missing point.
                    if let Some(point_id) =
                        crate::express_id::parse_express_id(&bytes[id_start..i])
                    {
                        // Check cache first
                        if let Some(&coord) = self.point_cache.get(&point_id) {
                            self.point_cache_hits += 1;
                            coords.push(coord);
                        } else {
                            // Not in cache - parse and cache
                            if let Some((pt_start, pt_end)) = index.lookup(point_id) {
                                if let Some(coord) =
                                    parse_cartesian_point_inline(&bytes_full[pt_start..pt_end])
                                {
                                    self.point_cache_misses += 1;
                                    self.point_cache.insert(point_id, coord);
                                    coords.push(coord);
                                }
                            }
                        }
                    }
                }
            } else {
                i += 1; // Skip unknown character
            }
        }

        // CRITICAL: Return None if ANY point failed to resolve
        // This matches the old behavior where missing points invalidated the whole polygon
        if coords.len() >= 3 && coords.len() == expected_count as usize {
            Some(())
        } else {
            coords.clear();
            None
        }
    }
}

#[cfg(test)]
#[path = "fast_buffers_tests.rs"]
mod tests;
