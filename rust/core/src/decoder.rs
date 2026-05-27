// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Entity Decoder - On-demand entity parsing
//!
//! Lazily decode IFC entities from byte offsets without loading entire file into memory.

use crate::error::{Error, Result};
use crate::parser::{parse_entity, EntityScanner};
use crate::schema_gen::{AttributeValue, DecodedEntity};
use rustc_hash::FxHashMap;
use std::sync::Arc;

/// Pre-built entity index type
pub type EntityIndex = FxHashMap<u32, (usize, usize)>;

/// Build an entity index from content.
///
/// This intentionally shares `EntityScanner`'s HEADER skipping and quoted-string
/// semantics so scan iteration and decoder lookup cannot disagree on malformed
/// headers or semicolons embedded inside STEP strings.
#[inline]
pub fn build_entity_index(content: &str) -> EntityIndex {
    let estimated_entities = content.len() / 50;
    let mut index = FxHashMap::with_capacity_and_hasher(estimated_entities, Default::default());
    let mut scanner = EntityScanner::new(content);
    while let Some((id, _type_name, start, end)) = scanner.next_entity() {
        index.insert(id, (start, end));
    }

    index
}

/// Entity decoder for lazy parsing - uses Arc for efficient cache sharing
pub struct EntityDecoder<'a> {
    content: &'a str,
    /// Cache of decoded entities (entity_id -> `Arc<DecodedEntity>`)
    /// Using Arc avoids expensive clones on cache hits
    cache: FxHashMap<u32, Arc<DecodedEntity>>,
    /// Index of entity offsets (entity_id -> (start, end))
    /// Can be pre-built or built lazily
    /// Using Arc to allow sharing across threads without cloning the HashMap
    entity_index: Option<Arc<EntityIndex>>,
    /// Cache of cartesian point coordinates for FacetedBrep optimization
    /// Only populated when using get_polyloop_coords_cached
    point_cache: FxHashMap<u32, (f64, f64, f64)>,
}

impl<'a> EntityDecoder<'a> {
    /// Create new decoder
    pub fn new(content: &'a str) -> Self {
        Self {
            content,
            cache: FxHashMap::default(),
            entity_index: None,
            point_cache: FxHashMap::default(),
        }
    }

    /// Create decoder with pre-built index (faster for repeated lookups)
    pub fn with_index(content: &'a str, index: EntityIndex) -> Self {
        Self {
            content,
            cache: FxHashMap::default(),
            entity_index: Some(Arc::new(index)),
            point_cache: FxHashMap::default(),
        }
    }

    /// Create decoder with shared Arc index (for parallel processing)
    pub fn with_arc_index(content: &'a str, index: Arc<EntityIndex>) -> Self {
        Self {
            content,
            cache: FxHashMap::default(),
            entity_index: Some(index),
            point_cache: FxHashMap::default(),
        }
    }

    /// Build entity index for O(1) lookups
    /// This scans the file once and maps entity IDs to byte offsets
    fn build_index(&mut self) {
        if self.entity_index.is_some() {
            return; // Already built
        }
        self.entity_index = Some(Arc::new(build_entity_index(self.content)));
    }

    /// Decode entity at byte offset
    /// Returns cached entity if already decoded
    ///
    /// Validates the `(start, end)` span against `self.content.len()` before
    /// slicing. Out-of-range or inverted spans return `Error::parse` instead
    /// of panicking — callers (e.g. `decode_and_cache`, `decode_at_with_id`,
    /// the streaming pre-pass shard mergers) hand us spans derived from
    /// untrusted/streamed entity-index data, and a malformed span must not
    /// take down the whole worker.
    #[inline]
    pub fn decode_at(&mut self, start: usize, end: usize) -> Result<DecodedEntity> {
        let content_len = self.content.len();
        if start > end || end > content_len {
            return Err(Error::parse(
                0,
                format!(
                    "decode_at: invalid byte span ({}, {}) for content length {}",
                    start, end, content_len,
                ),
            ));
        }
        let line = &self.content[start..end];
        let (id, ifc_type, tokens) = parse_entity(line).map_err(|e| {
            // Add debug info about what failed to parse
            Error::parse(
                0,
                format!(
                    "Failed to parse entity: {:?}, input: {:?}",
                    e,
                    &line[..line.len().min(100)]
                ),
            )
        })?;

        // Check cache first - return clone of inner DecodedEntity
        if let Some(entity_arc) = self.cache.get(&id) {
            return Ok(entity_arc.as_ref().clone());
        }

        // Convert tokens to AttributeValues
        let attributes = tokens
            .iter()
            .map(|token| AttributeValue::from_token(token))
            .collect();

        let entity = DecodedEntity::new(id, ifc_type, attributes);
        self.cache.insert(id, Arc::new(entity.clone()));
        Ok(entity)
    }

    /// Decode entity at byte offset with known ID (faster - checks cache before parsing)
    /// Use this when the scanner provides the entity ID to avoid re-parsing cached entities
    #[inline]
    pub fn decode_at_with_id(
        &mut self,
        id: u32,
        start: usize,
        end: usize,
    ) -> Result<DecodedEntity> {
        // Check cache first - avoid parsing if already decoded
        if let Some(entity_arc) = self.cache.get(&id) {
            return Ok(entity_arc.as_ref().clone());
        }

        // Not in cache, parse and cache
        self.decode_at(start, end)
    }

    /// Decode entity by ID - O(1) lookup using entity index
    #[inline]
    pub fn decode_by_id(&mut self, entity_id: u32) -> Result<DecodedEntity> {
        // Check cache first - return clone of inner DecodedEntity
        if let Some(entity_arc) = self.cache.get(&entity_id) {
            return Ok(entity_arc.as_ref().clone());
        }

        // Build index if not already built
        self.build_index();

        // O(1) lookup in index
        let (start, end) = self
            .entity_index
            .as_ref()
            .and_then(|idx| idx.get(&entity_id).copied())
            .ok_or_else(|| Error::parse(0, format!("Entity #{} not found", entity_id)))?;

        self.decode_at(start, end)
    }

    /// Resolve entity reference (follow #ID)
    /// Returns None for null/derived values
    #[inline]
    pub fn resolve_ref(&mut self, attr: &AttributeValue) -> Result<Option<DecodedEntity>> {
        match attr.as_entity_ref() {
            Some(id) => Ok(Some(self.decode_by_id(id)?)),
            None => Ok(None),
        }
    }

    /// Resolve list of entity references
    pub fn resolve_ref_list(&mut self, attr: &AttributeValue) -> Result<Vec<DecodedEntity>> {
        let list = attr
            .as_list()
            .ok_or_else(|| Error::parse(0, "Expected list".to_string()))?;

        let mut entities = Vec::with_capacity(list.len());
        for item in list {
            if let Some(id) = item.as_entity_ref() {
                entities.push(self.decode_by_id(id)?);
            }
        }
        Ok(entities)
    }

    /// Get cached entity (without decoding)
    pub fn get_cached(&self, entity_id: u32) -> Option<DecodedEntity> {
        self.cache.get(&entity_id).map(|arc| arc.as_ref().clone())
    }

    /// Reserve cache capacity to avoid HashMap resizing during processing.
    /// For a 487 MB file with 208 K building elements, the cache can grow to
    /// 300 K+ entries (elements + representation chains + placements).
    /// Pre-allocating avoids ~6 resize-and-rehash operations that each copy
    /// all entries, reducing both peak memory spikes and timing variance.
    pub fn reserve_cache(&mut self, additional: usize) {
        self.cache.reserve(additional);
    }

    /// Inject a pre-warmed Arc-shared cache into this decoder's local cache.
    ///
    /// Used by the de-normalized parallel path (Option 1 of the
    /// single-controller-rayon-design): a serial pre-pass builds a
    /// shared `Arc<FxHashMap<u32, Arc<DecodedEntity>>>` containing all
    /// entities reachable from the jobs. Each rayon task then injects
    /// that shared cache into its own decoder via this method, so the
    /// per-task hot path hits in-WASM-heap Arc handles instead of
    /// SAB-imported atomic memory.
    ///
    /// Cost: one Arc::clone per cached entry (atomic refcount bump).
    /// For a typical 100K-entry cache × 9 rayon tasks = 900K atomics
    /// total, ~90 ms wall (incurred ONCE at task setup; the parallel
    /// hot path then runs lock-free against the populated cache).
    pub fn inject_shared_cache(&mut self, shared: &FxHashMap<u32, Arc<DecodedEntity>>) {
        self.cache.reserve(shared.len());
        for (&id, entity) in shared.iter() {
            self.cache.insert(id, Arc::clone(entity));
        }
    }

    /// Decode + cache without returning. Used by the pre-warm pass to
    /// populate a shared cache. Returns the cached Arc so the caller
    /// can chase references without re-decoding.
    pub fn decode_and_cache(
        &mut self,
        id: u32,
        start: usize,
        end: usize,
    ) -> Result<Arc<DecodedEntity>> {
        if let Some(arc) = self.cache.get(&id) {
            return Ok(Arc::clone(arc));
        }
        let _ = self.decode_at(start, end)?;
        Ok(Arc::clone(self.cache.get(&id).ok_or_else(|| {
            Error::parse(0, "decode_at didn't populate cache".to_string())
        })?))
    }

    /// Drain the populated cache out of this decoder for sharing across
    /// rayon tasks. After calling this, the decoder is empty (cache
    /// moved out); callers typically then drop the decoder.
    pub fn drain_cache(&mut self) -> FxHashMap<u32, Arc<DecodedEntity>> {
        std::mem::take(&mut self.cache)
    }

    /// Clear all caches to free memory
    pub fn clear_cache(&mut self) {
        self.cache.clear();
        self.point_cache.clear();
    }

    /// Clear only the point coordinate cache (used after BREP preprocessing).
    /// The entity cache is preserved for subsequent geometry processing.
    pub fn clear_point_cache(&mut self) {
        self.point_cache.clear();
    }

    /// Get cache size
    pub fn cache_size(&self) -> usize {
        self.cache.len()
    }

    /// Get raw bytes for an entity (for direct/fast parsing)
    /// Returns the full entity line including type and attributes
    #[inline]
    pub fn get_raw_bytes(&mut self, entity_id: u32) -> Option<&'a [u8]> {
        self.build_index();
        let (start, end) = self.entity_index.as_ref()?.get(&entity_id).copied()?;
        Some(&self.content.as_bytes()[start..end])
    }

    /// Get raw content string for an entity
    #[inline]
    pub fn get_raw_content(&mut self, entity_id: u32) -> Option<&'a str> {
        self.build_index();
        let (start, end) = self.entity_index.as_ref()?.get(&entity_id).copied()?;
        Some(&self.content[start..end])
    }

    /// Fast extraction of first entity ref from raw bytes
    /// Useful for BREP -> shell ID, Face -> FaceBound, etc.
    /// Returns the first entity reference ID found in the entity
    #[inline]
    pub fn get_first_entity_ref_fast(&mut self, entity_id: u32) -> Option<u32> {
        let bytes = self.get_raw_bytes(entity_id)?;
        let len = bytes.len();
        let mut i = 0;

        // Skip to first '(' after '='
        while i < len && bytes[i] != b'(' {
            i += 1;
        }
        if i >= len {
            return None;
        }
        i += 1; // Skip first '('

        // Find first '#' which is the entity ref
        while i < len {
            // Skip whitespace
            while i < len && (bytes[i] == b' ' || bytes[i] == b'\n' || bytes[i] == b'\r') {
                i += 1;
            }

            if i >= len {
                return None;
            }

            if bytes[i] == b'#' {
                i += 1;
                let start = i;
                while i < len && bytes[i].is_ascii_digit() {
                    i += 1;
                }
                if i > start {
                    let mut id = 0u32;
                    for &b in &bytes[start..i] {
                        id = id.wrapping_mul(10).wrapping_add((b - b'0') as u32);
                    }
                    return Some(id);
                }
            }
            i += 1;
        }

        None
    }

    /// Fast extraction of entity reference IDs from a list attribute in raw bytes
    /// Useful for getting face list from ClosedShell, bounds from Face, etc.
    /// Returns list of entity IDs
    #[inline]
    pub fn get_entity_ref_list_fast(&mut self, entity_id: u32) -> Option<Vec<u32>> {
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
        let mut ids = Vec::with_capacity(32);

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
                    // Fast integer parsing directly from ASCII digits
                    let mut id = 0u32;
                    for &b in &bytes[start..i] {
                        id = id.wrapping_mul(10).wrapping_add((b - b'0') as u32);
                    }
                    ids.push(id);
                }
            } else {
                i += 1; // Skip unknown character
            }
        }

        if ids.is_empty() {
            None
        } else {
            Some(ids)
        }
    }

    /// Fast extraction of PolyLoop point IDs directly from raw bytes
    /// Bypasses full entity decoding for BREP optimization
    /// Returns list of entity IDs for CartesianPoints
    #[inline]
    pub fn get_polyloop_point_ids_fast(&mut self, entity_id: u32) -> Option<Vec<u32>> {
        let bytes = self.get_raw_bytes(entity_id)?;

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

        // Parse point IDs
        let mut point_ids = Vec::with_capacity(8); // Most faces have 3-8 vertices

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
                    // Fast integer parsing directly from ASCII digits
                    let mut id = 0u32;
                    for &b in &bytes[start..i] {
                        id = id.wrapping_mul(10).wrapping_add((b - b'0') as u32);
                    }
                    point_ids.push(id);
                }
            } else {
                i += 1; // Skip unknown character
            }
        }

        if point_ids.is_empty() {
            None
        } else {
            Some(point_ids)
        }
    }

    /// Fast extraction of CartesianPoint coordinates directly from raw bytes
    /// Bypasses full entity decoding for ~3x speedup on BREP-heavy files
    /// Returns (x, y, z) as f64 tuple
    #[inline]
    pub fn get_cartesian_point_fast(&mut self, entity_id: u32) -> Option<(f64, f64, f64)> {
        let bytes = self.get_raw_bytes(entity_id)?;

        // Find opening paren for coordinates: IFCCARTESIANPOINT((x,y,z));
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

        // Skip to second '(' for the coordinate list
        while i < len && bytes[i] != b'(' {
            i += 1;
        }
        if i >= len {
            return None;
        }
        i += 1; // Skip second '('

        // Parse x coordinate
        let x = parse_next_float(&bytes[i..], &mut i)?;

        // Parse y coordinate
        let y = parse_next_float(&bytes[i..], &mut i)?;

        // Parse z coordinate (optional for 2D points, default to 0)
        let z = parse_next_float(&bytes[i..], &mut i).unwrap_or(0.0);

        Some((x, y, z))
    }

    /// Fast extraction of FaceBound info directly from raw bytes
    /// Returns (loop_id, orientation, is_outer_bound)
    /// Bypasses full entity decoding for BREP optimization
    #[inline]
    pub fn get_face_bound_fast(&mut self, entity_id: u32) -> Option<(u32, bool, bool)> {
        let bytes = self.get_raw_bytes(entity_id)?;
        let len = bytes.len();

        // Find '=' to locate start of type name, and '(' for end
        let mut eq_pos = 0;
        while eq_pos < len && bytes[eq_pos] != b'=' {
            eq_pos += 1;
        }
        if eq_pos >= len {
            return None;
        }

        // Check if this is an outer bound by looking for "OUTER" in the type name
        // IFCFACEOUTERBOUND vs IFCFACEBOUND
        // The type name is between '=' and '('
        let mut is_outer = false;
        let mut i = eq_pos + 1;
        // Look for "OUTER" pattern (must check for the full word, not just 'O')
        while i + 4 < len && bytes[i] != b'(' {
            if bytes[i] == b'O'
                && bytes[i + 1] == b'U'
                && bytes[i + 2] == b'T'
                && bytes[i + 3] == b'E'
                && bytes[i + 4] == b'R'
            {
                is_outer = true;
                break;
            }
            i += 1;
        }
        // Continue to find the '(' if we haven't already
        while i < len && bytes[i] != b'(' {
            i += 1;
        }
        if i >= len {
            return None;
        }

        i += 1; // Skip first '('

        // Skip whitespace
        while i < len && (bytes[i] == b' ' || bytes[i] == b'\n' || bytes[i] == b'\r') {
            i += 1;
        }

        // Expect '#' for loop entity ref
        if i >= len || bytes[i] != b'#' {
            return None;
        }
        i += 1;

        // Parse loop ID
        let start = i;
        while i < len && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i <= start {
            return None;
        }
        let mut loop_id = 0u32;
        for &b in &bytes[start..i] {
            loop_id = loop_id.wrapping_mul(10).wrapping_add((b - b'0') as u32);
        }

        // Find orientation after comma - default to true (.T.)
        // Skip to comma
        while i < len && bytes[i] != b',' {
            i += 1;
        }
        i += 1; // Skip comma

        // Skip whitespace
        while i < len && (bytes[i] == b' ' || bytes[i] == b'\n' || bytes[i] == b'\r') {
            i += 1;
        }

        // Check for .F. (false) or .T. (true)
        let orientation = if i + 2 < len && bytes[i] == b'.' && bytes[i + 2] == b'.' {
            bytes[i + 1] != b'F'
        } else {
            true // Default to true
        };

        Some((loop_id, orientation, is_outer))
    }

    /// Fast extraction of PolyLoop COORDINATES directly from raw bytes
    /// This is the ultimate fast path - extracts all coordinates in one go
    /// Avoids N+1 HashMap lookups by batching point extraction
    /// Returns Vec of (x, y, z) coordinate tuples
    #[inline]
    pub fn get_polyloop_coords_fast(&mut self, entity_id: u32) -> Option<Vec<(f64, f64, f64)>> {
        // Ensure index is built once
        self.build_index();
        let index = self.entity_index.as_ref()?;
        let bytes_full = self.content.as_bytes();

        // Get polyloop raw bytes
        let (start, end) = index.get(&entity_id).copied()?;
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

        // Parse point IDs and immediately fetch coordinates
        let mut coords = Vec::with_capacity(8); // Most faces have 3-8 vertices

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
                    // Fast integer parsing directly from ASCII digits
                    let mut point_id = 0u32;
                    for &b in &bytes[id_start..i] {
                        point_id = point_id.wrapping_mul(10).wrapping_add((b - b'0') as u32);
                    }

                    // INLINE: Get cartesian point coordinates directly
                    // This avoids the overhead of calling get_cartesian_point_fast for each point
                    if let Some((pt_start, pt_end)) = index.get(&point_id).copied() {
                        if let Some(coord) =
                            parse_cartesian_point_inline(&bytes_full[pt_start..pt_end])
                        {
                            coords.push(coord);
                        }
                    }
                }
            } else {
                i += 1; // Skip unknown character
            }
        }

        if coords.len() >= 3 {
            Some(coords)
        } else {
            None
        }
    }

    /// Fast extraction of PolyLoop COORDINATES with point caching
    /// Uses a cache to avoid re-parsing the same cartesian points
    /// For files with many faces sharing points, this can be 2-3x faster
    #[inline]
    pub fn get_polyloop_coords_cached(&mut self, entity_id: u32) -> Option<Vec<(f64, f64, f64)>> {
        // Ensure index is built once
        self.build_index();
        let index = self.entity_index.as_ref()?;
        let bytes_full = self.content.as_bytes();

        // Get polyloop raw bytes
        let (start, end) = index.get(&entity_id).copied()?;
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
        let mut coords = Vec::with_capacity(8);
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

                    // Fast integer parsing directly from ASCII digits
                    let mut point_id = 0u32;
                    for &b in &bytes[id_start..i] {
                        point_id = point_id.wrapping_mul(10).wrapping_add((b - b'0') as u32);
                    }

                    // Check cache first
                    if let Some(&coord) = self.point_cache.get(&point_id) {
                        coords.push(coord);
                    } else {
                        // Not in cache - parse and cache
                        if let Some((pt_start, pt_end)) = index.get(&point_id).copied() {
                            if let Some(coord) =
                                parse_cartesian_point_inline(&bytes_full[pt_start..pt_end])
                            {
                                self.point_cache.insert(point_id, coord);
                                coords.push(coord);
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
            Some(coords)
        } else {
            None
        }
    }
}

/// Parse cartesian point coordinates inline from raw bytes
/// Used by get_polyloop_coords_fast for maximum performance
#[inline]
fn parse_cartesian_point_inline(bytes: &[u8]) -> Option<(f64, f64, f64)> {
    let len = bytes.len();
    let mut i = 0;

    // Skip to first '(' after '='
    while i < len && bytes[i] != b'(' {
        i += 1;
    }
    if i >= len {
        return None;
    }
    i += 1; // Skip first '('

    // Skip to second '(' for the coordinate list
    while i < len && bytes[i] != b'(' {
        i += 1;
    }
    if i >= len {
        return None;
    }
    i += 1; // Skip second '('

    // Parse x coordinate
    let x = parse_float_inline(&bytes[i..], &mut i)?;

    // Parse y coordinate
    let y = parse_float_inline(&bytes[i..], &mut i)?;

    // Parse z coordinate (optional for 2D points, default to 0)
    let z = parse_float_inline(&bytes[i..], &mut i).unwrap_or(0.0);

    Some((x, y, z))
}

/// Parse float inline - simpler version for batch coordinate extraction
#[inline]
fn parse_float_inline(bytes: &[u8], offset: &mut usize) -> Option<f64> {
    let len = bytes.len();
    let mut i = 0;

    // Skip whitespace and commas
    while i < len
        && (bytes[i] == b' ' || bytes[i] == b',' || bytes[i] == b'\n' || bytes[i] == b'\r')
    {
        i += 1;
    }

    if i >= len || bytes[i] == b')' {
        return None;
    }

    // Parse float using fast_float
    match fast_float2::parse_partial::<f64, _>(&bytes[i..]) {
        Ok((value, consumed)) if consumed > 0 => {
            *offset += i + consumed;
            Some(value)
        }
        _ => None,
    }
}

/// Parse next float from bytes, advancing position past it
#[inline]
fn parse_next_float(bytes: &[u8], offset: &mut usize) -> Option<f64> {
    let len = bytes.len();
    let mut i = 0;

    // Skip whitespace and commas
    while i < len
        && (bytes[i] == b' ' || bytes[i] == b',' || bytes[i] == b'\n' || bytes[i] == b'\r')
    {
        i += 1;
    }

    if i >= len || bytes[i] == b')' {
        return None;
    }

    // Parse float using fast_float
    match fast_float2::parse_partial::<f64, _>(&bytes[i..]) {
        Ok((value, consumed)) if consumed > 0 => {
            *offset += i + consumed;
            Some(value)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::IfcType;

    #[test]
    fn test_decode_entity() {
        let content = r#"
#1=IFCPROJECT('2vqT3bvqj9RBFjLlXpN8n9',$,$,$,$,$,$,$,$);
#2=IFCWALL('3a4T3bvqj9RBFjLlXpN8n0',$,$,$,'Wall-001',$,#3,#4);
#3=IFCLOCALPLACEMENT($,#4);
#4=IFCAXIS2PLACEMENT3D(#5,$,$);
#5=IFCCARTESIANPOINT((0.,0.,0.));
"#;

        let mut decoder = EntityDecoder::new(content);

        // Find entity #2
        let start = content.find("#2=").unwrap();
        let end = content[start..].find(';').unwrap() + start + 1;

        let entity = decoder.decode_at(start, end).unwrap();
        assert_eq!(entity.id, 2);
        assert_eq!(entity.ifc_type, IfcType::IfcWall);
        assert_eq!(entity.attributes.len(), 8);
        assert_eq!(entity.get_string(4), Some("Wall-001"));
        assert_eq!(entity.get_ref(6), Some(3));
        assert_eq!(entity.get_ref(7), Some(4));
    }

    #[test]
    fn test_decode_by_id() {
        let content = r#"
#1=IFCPROJECT('guid',$,$,$,$,$,$,$,$);
#5=IFCWALL('guid2',$,$,$,'Wall-001',$,$,$);
#10=IFCDOOR('guid3',$,$,$,'Door-001',$,$,$);
"#;

        let mut decoder = EntityDecoder::new(content);

        let entity = decoder.decode_by_id(5).unwrap();
        assert_eq!(entity.id, 5);
        assert_eq!(entity.ifc_type, IfcType::IfcWall);
        assert_eq!(entity.get_string(4), Some("Wall-001"));

        // Should be cached now
        assert_eq!(decoder.cache_size(), 1);
        let cached = decoder.get_cached(5).unwrap();
        assert_eq!(cached.id, 5);
    }

    #[test]
    fn test_build_entity_index_matches_scanner_header_semantics() {
        let content = "ISO-10303-21;\nHEADER;\n\
FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');\n\
FILE_NAME('26-IFC\\X2\\00B1\\X0\\2#.ifc','2026-04-29T18:21:27',$,$,'CATIA','CATIA',$);\n\
FILE_SCHEMA(('IFC4'));\nENDSEC;\n\
DATA;\n\
#1=IFCPROJECT('guid',$,$,$,$,$,$,$,$);\n\
#2=IFCWALL('guid2',$,$,$,'Wall; with semicolon',$,$,$);\n\
ENDSEC;\nEND-ISO-10303-21;\n";

        let index = build_entity_index(content);

        assert_eq!(index.len(), 2);
        assert!(!index.contains_key(&26));
        let (start, end) = index.get(&2).copied().unwrap();
        assert_eq!(
            &content[start..end],
            "#2=IFCWALL('guid2',$,$,$,'Wall; with semicolon',$,$,$);"
        );
    }

    #[test]
    fn test_decode_by_id_handles_quoted_semicolon_from_shared_index() {
        let content = "#1=IFCWALL('guid',$,$,$,'Wall; with semicolon',$,$,$);\n";
        let mut decoder = EntityDecoder::new(content);

        let wall = decoder.decode_by_id(1).unwrap();

        assert_eq!(wall.id, 1);
        assert_eq!(wall.ifc_type, IfcType::IfcWall);
        assert_eq!(wall.get_string(4), Some("Wall; with semicolon"));
    }

    #[test]
    fn test_resolve_ref() {
        let content = r#"
#1=IFCPROJECT('guid',$,$,$,$,$,$,$,$);
#2=IFCWALL('guid2',$,$,$,$,$,#1,$);
"#;

        let mut decoder = EntityDecoder::new(content);

        let wall = decoder.decode_by_id(2).unwrap();
        let placement_attr = wall.get(6).unwrap();

        let referenced = decoder.resolve_ref(placement_attr).unwrap().unwrap();
        assert_eq!(referenced.id, 1);
        assert_eq!(referenced.ifc_type, IfcType::IfcProject);
    }

    #[test]
    fn test_resolve_ref_list() {
        let content = r#"
#1=IFCPROJECT('guid',$,$,$,$,$,$,$,$);
#2=IFCWALL('guid1',$,$,$,$,$,$,$);
#3=IFCDOOR('guid2',$,$,$,$,$,$,$);
#4=IFCRELCONTAINEDINSPATIALSTRUCTURE('guid3',$,$,$,(#2,#3),$,#1);
"#;

        let mut decoder = EntityDecoder::new(content);

        let rel = decoder.decode_by_id(4).unwrap();
        let elements_attr = rel.get(4).unwrap();

        let elements = decoder.resolve_ref_list(elements_attr).unwrap();
        assert_eq!(elements.len(), 2);
        assert_eq!(elements[0].id, 2);
        assert_eq!(elements[0].ifc_type, IfcType::IfcWall);
        assert_eq!(elements[1].id, 3);
        assert_eq!(elements[1].ifc_type, IfcType::IfcDoor);
    }

    #[test]
    fn test_cache() {
        let content = r#"
#1=IFCPROJECT('guid',$,$,$,$,$,$,$,$);
#2=IFCWALL('guid2',$,$,$,$,$,$,$);
"#;

        let mut decoder = EntityDecoder::new(content);

        assert_eq!(decoder.cache_size(), 0);

        decoder.decode_by_id(1).unwrap();
        assert_eq!(decoder.cache_size(), 1);

        decoder.decode_by_id(2).unwrap();
        assert_eq!(decoder.cache_size(), 2);

        // Decode same entity - should use cache
        decoder.decode_by_id(1).unwrap();
        assert_eq!(decoder.cache_size(), 2);

        decoder.clear_cache();
        assert_eq!(decoder.cache_size(), 0);
    }
}
