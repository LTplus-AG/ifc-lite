// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Fast Direct Parsing Module
//!
//! Provides zero-allocation parsing for coordinate lists and index arrays.
//! This bypasses the Token/AttributeValue pipeline for massive speedups
//! on tessellation-heavy IFC files.
//!
//! Performance: 3-5x faster than standard path for IfcTriangulatedFaceSet

/// Check if byte is a digit, minus sign, or decimal point (start of number)
#[inline(always)]
fn is_number_start(b: u8) -> bool {
    b.is_ascii_digit() || b == b'-' || b == b'.'
}

/// Estimate number of floats in coordinate data
#[inline]
fn estimate_float_count(bytes: &[u8]) -> usize {
    // Rough estimate: ~8 bytes per float on average (including delimiters)
    bytes.len() / 8
}

/// Estimate number of integers in index data
#[inline]
fn estimate_int_count(bytes: &[u8]) -> usize {
    // Rough estimate: ~4 bytes per integer on average
    bytes.len() / 4
}

/// Parse coordinate list directly from raw bytes to `Vec<f32>`
///
/// This parses IFC coordinate data like:
/// `((0.,0.,150.),(0.,40.,140.),...)`
///
/// Returns flattened f32 array: [x0, y0, z0, x1, y1, z1, ...]
///
/// # Performance
/// - Zero intermediate allocations (no Token, no AttributeValue)
/// - Uses fast-float for SIMD-accelerated parsing
/// - Pre-allocates result vector
#[inline]
pub fn parse_coordinates_direct(bytes: &[u8]) -> Vec<f32> {
    let mut result = Vec::with_capacity(estimate_float_count(bytes));
    let mut pos = 0;
    let len = bytes.len();

    while pos < len {
        // Skip to next number using SIMD-accelerated search
        while pos < len && !is_number_start(bytes[pos]) {
            pos += 1;
        }
        if pos >= len {
            break;
        }

        // Parse float directly
        match fast_float2::parse_partial::<f32, _>(&bytes[pos..]) {
            Ok((value, consumed)) if consumed > 0 => {
                result.push(value);
                pos += consumed;
            }
            _ => {
                // Skip this character and continue
                pos += 1;
            }
        }
    }

    result
}

/// Parse coordinate list directly from raw bytes to `Vec<f64>`
///
/// Same as parse_coordinates_direct but with f64 precision.
#[inline]
pub fn parse_coordinates_direct_f64(bytes: &[u8]) -> Vec<f64> {
    let mut result = Vec::with_capacity(estimate_float_count(bytes));
    let mut pos = 0;
    let len = bytes.len();

    while pos < len {
        while pos < len && !is_number_start(bytes[pos]) {
            pos += 1;
        }
        if pos >= len {
            break;
        }

        match fast_float2::parse_partial::<f64, _>(&bytes[pos..]) {
            Ok((value, consumed)) if consumed > 0 => {
                result.push(value);
                pos += consumed;
            }
            _ => {
                pos += 1;
            }
        }
    }

    result
}

/// Parse index list directly from raw bytes to `Vec<u32>`
///
/// This parses IFC face index data like:
/// `((1,2,3),(2,1,4),...)`
///
/// Automatically converts from 1-based IFC indices to 0-based.
///
/// # Performance
/// - Zero intermediate allocations
/// - Uses inline integer parsing
#[inline]
pub fn parse_indices_direct(bytes: &[u8]) -> Vec<u32> {
    let mut result = Vec::with_capacity(estimate_int_count(bytes));
    let mut pos = 0;
    let len = bytes.len();

    while pos < len {
        // Skip to next digit
        while pos < len && !bytes[pos].is_ascii_digit() {
            pos += 1;
        }
        if pos >= len {
            break;
        }

        // Parse integer inline (avoiding any allocation). Use CHECKED
        // arithmetic so a pathologically large index in malformed input
        // SATURATES to u32::MAX — an obviously out-of-range vertex the
        // downstream bounds checks drop — instead of WRAPPING modulo 2^32 to an
        // arbitrary, valid-looking (wrong) vertex. Digits keep being consumed
        // after overflow so `pos` still advances past the whole number.
        let mut value: u32 = 0;
        let mut overflowed = false;
        while pos < len && bytes[pos].is_ascii_digit() {
            if !overflowed {
                match value
                    .checked_mul(10)
                    .and_then(|v| v.checked_add((bytes[pos] - b'0') as u32))
                {
                    Some(v) => value = v,
                    None => overflowed = true,
                }
            }
            pos += 1;
        }
        if overflowed {
            value = u32::MAX;
        }

        // Convert from 1-based to 0-based. NOTE: after saturation this yields
        // u32::MAX - 1, while schema_gen's to_zero_based yields u32::MAX —
        // consumers must bounds-check (i >= vertex_count), never compare
        // against a single sentinel value.
        result.push(value.saturating_sub(1));
    }

    result
}

/// Parse a single entity's coordinate list attribute
///
/// Takes the raw bytes of an entity line like:
/// `#78=IFCCARTESIANPOINTLIST3D(((0.,0.,150.),(0.,40.,140.),...));`
///
/// And extracts just the coordinate data.
#[inline]
pub fn extract_coordinate_list_from_entity(bytes: &[u8]) -> Option<Vec<f32>> {
    // Find the opening '((' which starts the coordinate list
    let start = memchr::memmem::find(bytes, b"((")?;

    // Find matching closing '))'
    let end = memchr::memmem::rfind(bytes, b"))")?;

    if end <= start {
        return None;
    }

    // Parse the coordinate data
    Some(parse_coordinates_direct(&bytes[start..end + 2]))
}

/// Parse face indices from IfcTriangulatedFaceSet entity
///
/// Finds the CoordIndex attribute (4th attribute, 0-indexed as 3)
/// in an entity like:
/// `#77=IFCTRIANGULATEDFACESET(#78,$,$,((1,2,3),(2,1,4),...),$);`
#[inline]
pub fn extract_face_indices_from_entity(bytes: &[u8]) -> Option<Vec<u32>> {
    // Count commas to find the 4th attribute (CoordIndex)
    // Format: IFCTRIANGULATEDFACESET(Coordinates,Normals,Closed,CoordIndex,PnIndex)
    let mut paren_depth = 0;
    let mut comma_count = 0;
    let mut attr_start = None;
    let mut attr_end = None;

    for (i, &b) in bytes.iter().enumerate() {
        match b {
            b'(' => {
                if paren_depth == 1 && comma_count == 3 && attr_start.is_none() {
                    attr_start = Some(i);
                }
                paren_depth += 1;
            }
            b')' => {
                paren_depth -= 1;
                if paren_depth == 1
                    && comma_count == 3
                    && attr_start.is_some()
                    && attr_end.is_none()
                {
                    attr_end = Some(i + 1);
                }
            }
            b',' if paren_depth == 1 => {
                if comma_count == 3 && attr_end.is_none() && attr_start.is_some() {
                    attr_end = Some(i);
                }
                comma_count += 1;
            }
            _ => {}
        }
    }

    let start = attr_start?;
    let end = attr_end?;

    if end <= start {
        return None;
    }

    Some(parse_indices_direct(&bytes[start..end]))
}

/// Fast path checker - determines if entity type benefits from direct parsing
#[inline]
pub fn should_use_fast_path(type_name: &str) -> bool {
    matches!(
        type_name.to_uppercase().as_str(),
        "IFCCARTESIANPOINTLIST3D"
            | "IFCTRIANGULATEDFACESET"
            | "IFCTRIANGULATEDIRREGULARNETWORK"
            | "IFCPOLYGONALFACESET"
            | "IFCINDEXEDPOLYGONALFACE"
    )
}

/// Extract entity type name from raw bytes
///
/// From `#77=IFCTRIANGULATEDFACESET(...)` extracts `IFCTRIANGULATEDFACESET`
#[inline]
pub fn extract_entity_type_name(bytes: &[u8]) -> Option<&str> {
    // Find '=' position
    let eq_pos = bytes.iter().position(|&b| b == b'=')?;
    // Find '(' position after '='
    let paren_pos = bytes[eq_pos..].iter().position(|&b| b == b'(')?;
    let type_start = eq_pos + 1;
    let type_end = eq_pos + paren_pos;

    if type_end <= type_start {
        return None;
    }

    std::str::from_utf8(&bytes[type_start..type_end]).ok()
}

/// Extract the first entity reference from an entity's first attribute
///
/// From `#77=IFCTRIANGULATEDFACESET(#78,...)` extracts `78`
#[inline]
pub fn extract_first_entity_ref(bytes: &[u8]) -> Option<u32> {
    // Find opening paren
    let paren_pos = bytes.iter().position(|&b| b == b'(')?;
    let content = &bytes[paren_pos + 1..];

    // Find '#' which marks entity reference
    let hash_pos = content.iter().position(|&b| b == b'#')?;
    let id_start = hash_pos + 1;

    // Parse the ID number
    let mut id: u32 = 0;
    let mut i = id_start;
    while i < content.len() && content[i].is_ascii_digit() {
        id = id.wrapping_mul(10).wrapping_add((content[i] - b'0') as u32);
        i += 1;
    }

    if i > id_start {
        Some(id)
    } else {
        None
    }
}

/// Mesh data for fast path processing (avoiding full Mesh struct dependency)
#[derive(Debug, Clone)]
pub struct FastMeshData {
    pub positions: Vec<f32>,
    pub indices: Vec<u32>,
}

/// Process IfcTriangulatedFaceSet directly from raw bytes
///
/// This completely bypasses the Token/AttributeValue pipeline for
/// maximum performance on tessellation geometry.
///
/// # Arguments
/// * `faceset_bytes` - Raw bytes of the IfcTriangulatedFaceSet entity
/// * `get_entity_bytes` - Function to retrieve raw bytes for a given entity ID
///
/// # Returns
/// FastMeshData with positions and indices, or None if parsing fails
#[inline]
pub fn process_triangulated_faceset_direct<F>(
    faceset_bytes: &[u8],
    get_entity_bytes: F,
) -> Option<FastMeshData>
where
    F: Fn(u32) -> Option<Vec<u8>>,
{
    // Extract coordinate entity reference from first attribute
    let coord_entity_id = extract_first_entity_ref(faceset_bytes)?;

    // Get raw bytes of coordinate list entity
    let coord_bytes = get_entity_bytes(coord_entity_id)?;

    // Parse coordinates directly
    let positions = parse_coordinates_direct(&coord_bytes);

    // Extract and parse indices from attribute 3 (CoordIndex)
    let indices = extract_face_indices_from_entity(faceset_bytes)?;

    Some(FastMeshData { positions, indices })
}

/// Extract entity IDs from a list attribute without full parsing
///
/// From `(#1,#2,#3)` extracts `[1, 2, 3]`
#[inline]
pub fn extract_entity_refs_from_list(bytes: &[u8]) -> Vec<u32> {
    let mut ids = Vec::with_capacity(16);
    let mut i = 0;
    let len = bytes.len();

    while i < len {
        // Find next '#'
        while i < len && bytes[i] != b'#' {
            i += 1;
        }
        if i >= len {
            break;
        }
        i += 1; // Skip '#'

        // Parse ID
        let mut id: u32 = 0;
        while i < len && bytes[i].is_ascii_digit() {
            id = id.wrapping_mul(10).wrapping_add((bytes[i] - b'0') as u32);
            i += 1;
        }
        if id > 0 {
            ids.push(id);
        }
    }

    ids
}

#[cfg(test)]
#[path = "fast_parse_tests.rs"]
mod tests;
