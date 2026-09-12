// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Model bounds calculation for large coordinate handling
//!
//! Scans IFC content to determine model bounding box in f64 precision.
//! Used for calculating RTC (Relative-to-Center) offset before geometry processing
//! to avoid Float32 precision loss with large coordinates (e.g., Swiss UTM).

use crate::EntityScanner;
use std::collections::HashSet;

/// Model bounds in f64 precision
#[derive(Debug, Clone)]
pub struct ModelBounds {
    /// Minimum X coordinate found
    pub min_x: f64,
    /// Minimum Y coordinate found
    pub min_y: f64,
    /// Minimum Z coordinate found
    pub min_z: f64,
    /// Maximum X coordinate found
    pub max_x: f64,
    /// Maximum Y coordinate found
    pub max_y: f64,
    /// Maximum Z coordinate found
    pub max_z: f64,
    /// Number of points sampled
    pub sample_count: usize,
}

impl ModelBounds {
    /// Create new bounds initialized to invalid state
    pub fn new() -> Self {
        Self {
            min_x: f64::MAX,
            min_y: f64::MAX,
            min_z: f64::MAX,
            max_x: f64::MIN,
            max_y: f64::MIN,
            max_z: f64::MIN,
            sample_count: 0,
        }
    }

    /// Check if bounds are valid (at least one point added)
    #[inline]
    pub fn is_valid(&self) -> bool {
        self.sample_count > 0
    }

    /// Expand bounds to include a point
    #[inline]
    pub fn expand(&mut self, x: f64, y: f64, z: f64) {
        self.min_x = self.min_x.min(x);
        self.min_y = self.min_y.min(y);
        self.min_z = self.min_z.min(z);
        self.max_x = self.max_x.max(x);
        self.max_y = self.max_y.max(y);
        self.max_z = self.max_z.max(z);
        self.sample_count += 1;
    }

    /// Get centroid (center of bounding box)
    #[inline]
    pub fn centroid(&self) -> (f64, f64, f64) {
        if !self.is_valid() {
            return (0.0, 0.0, 0.0);
        }
        (
            (self.min_x + self.max_x) / 2.0,
            (self.min_y + self.max_y) / 2.0,
            (self.min_z + self.max_z) / 2.0,
        )
    }

    /// Check if bounds reach more than 10 km (in METRES) from the origin.
    ///
    /// The sampled values are raw `IfcCartesianPoint` coordinates in the
    /// file's length unit, so the caller passes `length_unit_scale` (file
    /// unit to metres, e.g. 0.001 for millimetres, 1000.0 for kilometres)
    /// and the comparison happens in metres. Gating on the raw values against
    /// a metre-shaped constant let a kilometre-unit model 5 000 km out read
    /// as "5000 < 10000" and skip the RTC rebase, and the caller's scaling
    /// afterwards could not undo a decision already taken.
    #[inline]
    pub fn has_large_coordinates(&self, length_unit_scale: f64) -> bool {
        const THRESHOLD_METERS: f64 = 10000.0;
        if !self.is_valid() {
            return false;
        }
        [
            self.min_x,
            self.min_y,
            self.min_z,
            self.max_x,
            self.max_y,
            self.max_z,
        ]
        .iter()
        .any(|v| (v * length_unit_scale).abs() > THRESHOLD_METERS)
    }

    /// The RTC offset IN METRES: the unit-scaled bbox centre when the bounds
    /// are large (see [`has_large_coordinates`](Self::has_large_coordinates)),
    /// zero otherwise. Same unit as the router's job-sampled offset, so the
    /// two fallback ladders agree.
    #[inline]
    pub fn rtc_offset(&self, length_unit_scale: f64) -> (f64, f64, f64) {
        if self.has_large_coordinates(length_unit_scale) {
            let (x, y, z) = self.centroid();
            (x * length_unit_scale, y * length_unit_scale, z * length_unit_scale)
        } else {
            (0.0, 0.0, 0.0)
        }
    }
}

impl Default for ModelBounds {
    fn default() -> Self {
        Self::new()
    }
}

/// Scan IFC content to extract model bounds from IfcCartesianPoint entities
///
/// This is a fast first-pass scan that extracts coordinate values directly from
/// the IFC text without full entity decoding. It samples points to determine
/// if the model has large coordinates that need RTC shifting.
///
/// # Performance
/// This scans through the file once, looking for IFCCARTESIANPOINT patterns.
/// It's much faster than full entity parsing since it only extracts coordinates.
pub fn scan_model_bounds<T>(content: &T) -> ModelBounds
where
    T: AsRef<[u8]> + ?Sized,
{
    let content = content.as_ref();
    let mut bounds = ModelBounds::new();

    // Use EntityScanner for efficient scanning
    let mut scanner = EntityScanner::new(content);

    while let Some((_id, type_name, start, end)) = scanner.next_entity() {
        // Only process cartesian points. STEP keyword case is not
        // significant (ISO 10303-21) and the scanner returns it as written.
        if !type_name.eq_ignore_ascii_case("IFCCARTESIANPOINT") {
            continue;
        }

        // Extract the entity content
        let entity_text = &content[start..end];

        // Parse coordinates from IFCCARTESIANPOINT((x,y,z));
        if let Some(coords) = extract_point_coordinates(entity_text) {
            let x = coords.0;
            let y = coords.1;
            let z = coords.2.unwrap_or(0.0);

            // Skip obviously invalid coordinates
            if x.is_finite() && y.is_finite() && z.is_finite() {
                bounds.expand(x, y, z);
            }
        }
    }

    bounds
}

/// Extract coordinates from IfcCartesianPoint text
/// Format: IFCCARTESIANPOINT((x,y)) or IFCCARTESIANPOINT((x,y,z))
fn extract_point_coordinates<T>(bytes: &T) -> Option<(f64, f64, Option<f64>)>
where
    T: AsRef<[u8]> + ?Sized,
{
    let bytes = bytes.as_ref();
    let text = std::str::from_utf8(bytes).ok()?;
    // Find the coordinate list between (( and ))
    let start = text.find("((")?;
    let end = text.rfind("))")?;

    if start >= end {
        return None;
    }

    let coord_str = &text[start + 2..end];

    // Split by comma and parse
    let parts: Vec<&str> = coord_str.split(',').collect();

    if parts.len() < 2 {
        return None;
    }

    let x = parts[0].trim().parse::<f64>().ok()?;
    let y = parts[1].trim().parse::<f64>().ok()?;
    let z = if parts.len() > 2 {
        parts[2].trim().parse::<f64>().ok()
    } else {
        None
    };

    Some((x, y, z))
}

/// Scan model bounds focusing on placement coordinates
///
/// This variant specifically looks at IfcLocalPlacement and transformation
/// coordinates, which are more representative of where geometry will be placed.
/// Useful for models where cartesian points include local/relative coordinates.
pub fn scan_placement_bounds<T>(content: &T) -> ModelBounds
where
    T: AsRef<[u8]> + ?Sized,
{
    let content = content.as_ref();
    let mut bounds = ModelBounds::new();
    let mut scanner = EntityScanner::new(content);

    // Track which cartesian point IDs are referenced by placements (HashSet for O(1) lookups)
    let mut placement_point_ids: HashSet<u32> = HashSet::new();

    // First pass: find cartesian points referenced by Axis2Placement3D
    while let Some((_id, type_name, start, end)) = scanner.next_entity() {
        if type_name.eq_ignore_ascii_case("IFCAXIS2PLACEMENT3D") {
            let entity_text = &content[start..end];
            // Extract the Location reference (first attribute)
            if let Some(ref_id) = extract_first_reference(entity_text) {
                placement_point_ids.insert(ref_id);
            }
        }
    }

    // Second pass: extract coordinates from referenced points
    scanner = EntityScanner::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if type_name.eq_ignore_ascii_case("IFCCARTESIANPOINT") {
            // Check if this point is referenced by a placement
            let is_placement_point = placement_point_ids.contains(&id);

            // For placement points, always include them
            // For other points, only include if they have large coordinates
            let entity_text = &content[start..end];
            if let Some(coords) = extract_point_coordinates(entity_text) {
                let x = coords.0;
                let y = coords.1;
                let z = coords.2.unwrap_or(0.0);

                // Skip invalid coordinates
                if !x.is_finite() || !y.is_finite() || !z.is_finite() {
                    continue;
                }

                // Include placement points and points with large coordinates (including Z axis)
                if is_placement_point || x.abs() > 1000.0 || y.abs() > 1000.0 || z.abs() > 1000.0 {
                    bounds.expand(x, y, z);
                }
            }
        }
    }

    // If no placement points found, fall back to full scan
    if !bounds.is_valid() {
        return scan_model_bounds(content);
    }

    bounds
}

/// Extract first entity reference from text
/// Looks for #xxx pattern
fn extract_first_reference<T>(bytes: &T) -> Option<u32>
where
    T: AsRef<[u8]> + ?Sized,
{
    let bytes = bytes.as_ref();
    let text = std::str::from_utf8(bytes).ok()?;
    // Find opening paren of attribute list
    let start = text.find('(')?;
    let rest = &text[start + 1..];

    // Find first # character
    let hash_pos = rest.find('#')?;
    let after_hash = &rest[hash_pos + 1..];

    // Parse the number
    let end_pos = after_hash
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(after_hash.len());

    if end_pos == 0 {
        return None;
    }

    after_hash[..end_pos].parse().ok()
}

#[cfg(test)]
#[path = "model_bounds_tests.rs"]
mod tests;
