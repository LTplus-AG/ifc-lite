// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Geometry Processors - P0 implementations
//!
//! High-priority processors for common IFC geometry types.
//! Each sub-module handles a category of geometry processors:
//!
//! - `extrusion`: ExtrudedAreaSolid (most common - extruded profiles)
//! - `tessellated`: TriangulatedFaceSet, PolygonalFaceSet (pre-tessellated meshes)
//! - `brep`: FacetedBrep, FaceBasedSurfaceModel, ShellBasedSurfaceModel (boundary representations)
//! - `surface`: SurfaceOfLinearExtrusion (swept surfaces)
//! - `boolean`: BooleanClippingResult (CSG operations)
//! - `mapped`: MappedItem (geometry instancing)
//! - `swept`: SweptDiskSolid, RevolvedAreaSolid (swept geometry)
//! - `advanced`: AdvancedBrep (NURBS/B-spline)
//! - `advanced_face`: Shared IfcAdvancedFace processing (B-spline, planar, cylindrical)
//! - `helpers`: Shared parse functions used by multiple processors

mod advanced;
mod advanced_face;
mod alignment;
mod boolean;
mod brep;
mod csg_primitive;
mod extrusion;
mod extrusion_tapered;
mod helpers;
mod mapped;
mod sectioned;
mod surface;
mod swept;
mod tessellated;

#[cfg(test)]
mod tests;

// Re-export all processor types
pub use advanced::{AdvancedBrepProcessor, BSplineSurfaceProcessor};
pub use alignment::IfcAlignmentProcessor;
pub use boolean::BooleanClippingProcessor;
pub use brep::{
    FaceBasedSurfaceModelProcessor, FacetedBrepProcessor, ShellBasedSurfaceModelProcessor,
};
pub use csg_primitive::{BlockProcessor, CsgSolidProcessor, SphereProcessor};
pub use extrusion::ExtrudedAreaSolidProcessor;
pub use extrusion_tapered::ExtrudedAreaSolidTaperedProcessor;
pub use mapped::MappedItemProcessor;
pub use sectioned::SectionedSolidHorizontalProcessor;
pub use surface::SurfaceOfLinearExtrusionProcessor;
pub use swept::{RevolvedAreaSolidProcessor, SweptDiskSolidProcessor};
pub use tessellated::{PolygonalFaceSetProcessor, TriangulatedFaceSetProcessor};

/// Extract CoordIndex bytes from IfcTriangulatedFaceSet raw entity
///
/// Finds the 4th attribute (CoordIndex, 0-indexed as 3) in:
/// `#77=IFCTRIANGULATEDFACESET(#78,$,$,((1,2,3),(2,1,4),...),$);`
///
/// Returns the byte slice containing just the index list data.
/// Performs structural validation to reject malformed input.
#[inline]
fn extract_coord_index_bytes(bytes: &[u8]) -> Option<&[u8]> {
    // Find opening paren after = sign
    let eq_pos = bytes.iter().position(|&b| b == b'=')?;
    let open_paren = bytes[eq_pos..].iter().position(|&b| b == b'(')?;
    let args_start = eq_pos + open_paren + 1;

    // Navigate through attributes counting at depth 1
    let mut depth = 1;
    let mut attr_count = 0;
    let mut attr_start = args_start;
    let mut i = args_start;
    let mut in_string = false;

    while i < bytes.len() && depth > 0 {
        let b = bytes[i];

        // Handle string literals - skip content inside quotes
        if b == b'\'' {
            in_string = !in_string;
            i += 1;
            continue;
        }
        if in_string {
            i += 1;
            continue;
        }

        // Skip comments (/* ... */)
        if b == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i += 2;
            continue;
        }

        match b {
            b'(' => {
                if depth == 1 && attr_count == 3 {
                    // Found start of 4th attribute (CoordIndex)
                    attr_start = i;
                }
                depth += 1;
            }
            b')' => {
                depth -= 1;
                if depth == 1 && attr_count == 3 {
                    // Found end of CoordIndex - validate before returning
                    let candidate = &bytes[attr_start..i + 1];
                    if validate_coord_index_structure(candidate) {
                        return Some(candidate);
                    }
                    // Invalid structure, continue searching or return None
                    return None;
                }
            }
            b',' if depth == 1 => {
                attr_count += 1;
            }
            b'$' if depth == 1 && attr_count == 3 => {
                // CoordIndex is $ (null), skip it
                return None;
            }
            _ => {}
        }
        i += 1;
    }

    None
}

/// Validate that a byte slice has valid CoordIndex structure:
/// - Must start with '(' and end with ')'
/// - Must contain comma-separated parenthesized integer lists
/// - Allowed tokens: digits, commas, parentheses, whitespace
/// - Rejected: '$', unbalanced parens, quotes, comment markers
#[inline]
fn validate_coord_index_structure(bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return false;
    }

    // Must start with '(' and end with ')'
    let first = bytes.first().copied();
    let last = bytes.last().copied();
    if first != Some(b'(') || last != Some(b')') {
        return false;
    }

    // Check structure: only allow digits, commas, parens, whitespace
    let mut depth = 0;
    for &b in bytes {
        match b {
            b'(' => depth += 1,
            b')' => {
                if depth == 0 {
                    return false; // Unbalanced
                }
                depth -= 1;
            }
            b'0'..=b'9' | b',' | b' ' | b'\t' | b'\n' | b'\r' | b'-' => {}
            b'$' | b'\'' | b'"' | b'/' | b'*' | b'#' => {
                // Invalid characters for CoordIndex
                return false;
            }
            _ => {
                // Allow other whitespace-like chars, reject letters
                if b.is_ascii_alphabetic() {
                    return false;
                }
            }
        }
    }

    // Must have balanced parens
    depth == 0
}
