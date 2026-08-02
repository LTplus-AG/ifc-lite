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

    /// Check if bounds contain large coordinates (>10km from origin)
    #[inline]
    pub fn has_large_coordinates(&self) -> bool {
        const THRESHOLD: f64 = 10000.0; // 10km
        if !self.is_valid() {
            return false;
        }
        self.min_x.abs() > THRESHOLD
            || self.min_y.abs() > THRESHOLD
            || self.max_x.abs() > THRESHOLD
            || self.max_y.abs() > THRESHOLD
            || self.min_z.abs() > THRESHOLD
            || self.max_z.abs() > THRESHOLD
    }

    /// Get the RTC offset (same as centroid for large coordinates, zero otherwise)
    #[inline]
    pub fn rtc_offset(&self) -> (f64, f64, f64) {
        if self.has_large_coordinates() {
            self.centroid()
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
        // Only process cartesian points
        if type_name != "IFCCARTESIANPOINT" {
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
        if type_name == "IFCAXIS2PLACEMENT3D" {
            let entity_text = &content[start..end];
            // Extract the Location reference (first attribute)
            if let Some(ref_id) = extract_first_reference(entity_text) {
                placement_point_ids.insert(ref_id);
            }
        }
        // Also include IfcSite coordinates which often have real-world coords
        if type_name == "IFCSITE" {
            // IfcSite has RefLatitude, RefLongitude, RefElevation
            // These are stored as IfcCompoundPlaneAngleMeasure, not coords
            // But we can get bounds from the site's placement
        }
        // Store the entity ID for cartesian points
        if type_name == "IFCCARTESIANPOINT" {
            // Will be checked in second pass
            continue;
        }
    }

    // Second pass: extract coordinates from referenced points
    scanner = EntityScanner::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if type_name == "IFCCARTESIANPOINT" {
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
mod tests {
    use super::*;

    #[test]
    fn test_bounds_creation() {
        let bounds = ModelBounds::new();
        assert!(!bounds.is_valid());
        assert!(!bounds.has_large_coordinates());
    }

    #[test]
    fn test_bounds_expand() {
        let mut bounds = ModelBounds::new();
        bounds.expand(100.0, 200.0, 50.0);
        bounds.expand(150.0, 250.0, 75.0);

        assert!(bounds.is_valid());
        assert_eq!(bounds.min_x, 100.0);
        assert_eq!(bounds.max_x, 150.0);
        assert_eq!(bounds.min_y, 200.0);
        assert_eq!(bounds.max_y, 250.0);

        let centroid = bounds.centroid();
        assert_eq!(centroid.0, 125.0);
        assert_eq!(centroid.1, 225.0);
    }

    #[test]
    fn test_large_coordinates_detection() {
        let mut bounds = ModelBounds::new();
        bounds.expand(2679012.0, 1247892.0, 432.0); // Swiss UTM coordinates

        assert!(bounds.has_large_coordinates());

        let offset = bounds.rtc_offset();
        assert_eq!(offset.0, 2679012.0);
        assert_eq!(offset.1, 1247892.0);
    }

    #[test]
    fn test_small_coordinates_no_shift() {
        let mut bounds = ModelBounds::new();
        bounds.expand(0.0, 0.0, 0.0);
        bounds.expand(100.0, 100.0, 10.0);

        assert!(!bounds.has_large_coordinates());

        let offset = bounds.rtc_offset();
        assert_eq!(offset.0, 0.0);
        assert_eq!(offset.1, 0.0);
        assert_eq!(offset.2, 0.0);
    }

    #[test]
    fn test_extract_point_coordinates_3d() {
        let text = "IFCCARTESIANPOINT((2679012.123,1247892.456,432.789))";
        let coords = extract_point_coordinates(text).unwrap();

        assert!((coords.0 - 2679012.123).abs() < 0.001);
        assert!((coords.1 - 1247892.456).abs() < 0.001);
        assert!((coords.2.unwrap() - 432.789).abs() < 0.001);
    }

    #[test]
    fn test_extract_point_coordinates_2d() {
        let text = "IFCCARTESIANPOINT((100.5,200.5))";
        let coords = extract_point_coordinates(text).unwrap();

        assert_eq!(coords.0, 100.5);
        assert_eq!(coords.1, 200.5);
        assert!(coords.2.is_none());
    }

    #[test]
    fn test_scan_model_bounds() {
        let ifc_content = r#"
ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
ENDSEC;
DATA;
#1=IFCCARTESIANPOINT((2679012.0,1247892.0,432.0));
#2=IFCCARTESIANPOINT((2679112.0,1247992.0,442.0));
#3=IFCWALL('guid',$,$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
"#;

        let bounds = scan_model_bounds(ifc_content);

        assert!(bounds.is_valid());
        assert!(bounds.has_large_coordinates());
        assert_eq!(bounds.sample_count, 2);

        let centroid = bounds.centroid();
        assert!((centroid.0 - 2679062.0).abs() < 0.001);
        assert!((centroid.1 - 1247942.0).abs() < 0.001);
    }

    #[test]
    fn test_scan_model_bounds_small_model() {
        let ifc_content = r#"
ISO-10303-21;
DATA;
#1=IFCCARTESIANPOINT((0.0,0.0,0.0));
#2=IFCCARTESIANPOINT((10.0,10.0,5.0));
ENDSEC;
END-ISO-10303-21;
"#;

        let bounds = scan_model_bounds(ifc_content);

        assert!(bounds.is_valid());
        assert!(!bounds.has_large_coordinates());

        let offset = bounds.rtc_offset();
        assert_eq!(offset.0, 0.0); // No shift needed for small coordinates
    }

    #[test]
    fn test_precision_preserved_with_rtc() {
        // Simulate what happens with and without RTC

        // Large Swiss UTM coordinates
        let x1 = 2679012.123456_f64;
        let x2 = 2679012.223456_f64; // 0.1m apart
        let expected_diff = 0.1;

        // WITHOUT RTC: Convert directly to f32 (loses precision)
        let x1_f32_direct = x1 as f32;
        let x2_f32_direct = x2 as f32;
        let diff_direct = x2_f32_direct - x1_f32_direct;
        let error_direct = (diff_direct as f64 - expected_diff).abs();

        // WITH RTC: Subtract centroid first (in f64), then convert
        let centroid = (x1 + x2) / 2.0;
        let x1_shifted = (x1 - centroid) as f32;
        let x2_shifted = (x2 - centroid) as f32;
        let diff_rtc = x2_shifted - x1_shifted;
        let error_rtc = (diff_rtc as f64 - expected_diff).abs();

        println!("Without RTC: diff={}, error={}", diff_direct, error_direct);
        println!("With RTC: diff={}, error={}", diff_rtc, error_rtc);

        // RTC should give much better precision
        // At ~2.7M magnitude, f32 has ~0.25m precision
        // After shifting to small values, f32 has sub-mm precision
        assert!(
            error_rtc < error_direct * 0.1 || error_rtc < 0.0001,
            "RTC should significantly improve precision"
        );
    }
}
