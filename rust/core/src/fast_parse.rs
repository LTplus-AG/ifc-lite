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

#[path = "fast_parse_comments.rs"]
mod comments;

#[path = "fast_parse_coordinates.rs"]
mod coordinates;

pub use coordinates::{parse_coordinates_direct, parse_coordinates_direct_f64};

#[path = "fast_parse_indices.rs"]
mod indices;

pub(crate) use indices::ifc_index_to_zero_based;
pub use indices::INVALID_INDEX;

/// Estimate number of floats in coordinate data
///
/// Shared with the split-out `coordinates` module.
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

/// Parse a `CoordIndex` list value (`((1,2,3),(2,1,4),...)`) directly from
/// raw bytes to flat 0-based triangle corners, under the one IFC index rule
/// (1-based INTEGER in `1..=u32::MAX`): a value that fails it, and all three corners
/// of a face that is not exactly three entries long, read as
/// [`INVALID_INDEX`], which every consumer drops (#7689).
///
/// Empty when the text holds anything but digits, commas, parentheses and
/// trivia; [`extract_face_indices_from_entity`] tells that refusal apart from
/// an empty list, so its caller can decode the record instead.
#[inline]
pub fn parse_indices_direct(bytes: &[u8]) -> Vec<u32> {
    indices::read_coord_index(bytes).unwrap_or_default()
}

/// Parse a whole point-list record's `CoordList` (attribute 0), found by depth, not by the
/// last `))`: an IFC4X3 `TagList` after it ends in `))` and its digits became phantom
/// vertices (core review behind #4577, finding 6). `None` when attribute 0 is not a list
/// or the list is refused as corrupt (#5266).
#[inline]
pub fn extract_coordinate_list_from_entity(bytes: &[u8]) -> Option<Vec<f32>> {
    coordinates::try_parse_coordinates_direct(coordinate_list_span(bytes)?)
}

/// [`extract_coordinate_list_from_entity`] at f64 precision. A caller that
/// rebases national-grid coordinates must subtract its offset from these
/// values: narrowing first can merge vertices that differ by less than one
/// f32 ULP (0.25 m at 2,600 km) before the offset is removed (#5698).
#[inline]
pub fn extract_coordinate_list_from_entity_f64(bytes: &[u8]) -> Option<Vec<f64>> {
    coordinates::try_parse_coordinates_direct_f64(coordinate_list_span(bytes)?)
}

/// The bytes of attribute 0's balanced list, including its outer parentheses.
fn coordinate_list_span(bytes: &[u8]) -> Option<&[u8]> {
    let head = crate::parser::argument_list_start(bytes)?;
    let open = crate::parser::skip_step_trivia(bytes, head)?;
    if bytes.get(open) != Some(&b'(') {
        return None;
    }
    let (mut i, mut depth) = (open + 1, 1usize);
    loop {
        i += memchr::memchr3(b'(', b')', b'/', &bytes[i..])?;
        match bytes[i] {
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                i = crate::parser::skip_step_comment(bytes, i)?;
                continue;
            }
            b'(' => depth += 1,
            b')' if depth == 1 => return Some(&bytes[open..=i]),
            b')' => depth -= 1,
            _ => {}
        }
        i += 1;
    }
}

/// The `CoordIndex` (attribute 3) of an `IfcTriangulatedFaceSet` record,
/// read by [`parse_indices_direct`]'s grammar, e.g. from
/// `#77=IFCTRIANGULATEDFACESET(#78,$,$,((1,2,3),(2,1,4),...),$);`.
///
/// `None` when the attribute is not a list or holds anything the byte
/// grammar leaves to the decoded reading (`AttributeValue::parse_index_list`,
/// the same rule), so the caller decodes instead of meshing a guess (#7689).
/// The attribute is found by [`crate::StepListItems`], the one per-attribute
/// read, so strings, nesting and comments follow its rule.
#[inline]
pub fn extract_face_indices_from_entity(bytes: &[u8]) -> Option<Vec<u32>> {
    let coord_index = crate::StepListItems::of_record(bytes)?.nth(3)?;
    indices::read_coord_index(coord_index)
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
    let coord_entity_id = crate::parser::StepRecord::parse(faceset_bytes)?.ref_at(0)?;

    // Get raw bytes of coordinate list entity
    let coord_bytes = get_entity_bytes(coord_entity_id)?;

    let positions = extract_coordinate_list_from_entity(&coord_bytes)?;

    // This reader has no `PnIndex` remap, so a face set that has one is
    // refused rather than meshed against the wrong points (#7689).
    if crate::nth_attribute_is_present(faceset_bytes, 4) {
        return None;
    }

    // Extract and parse indices from attribute 3 (CoordIndex)
    let indices = extract_face_indices_from_entity(faceset_bytes)?;

    Some(FastMeshData { positions, indices })
}

#[cfg(test)]
#[path = "fast_parse_tests.rs"]
mod tests;
