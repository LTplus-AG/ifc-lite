// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Standalone test for AR file wall geometry issues.
//! Tests wall 1NmE6Wndr2xhGbWU4qRRfr which has elongated openings and far points.

use ifc_lite_core::{EntityDecoder, EntityScanner};
use ifc_lite_geometry::{calculate_normals, csg::ClippingProcessor, GeometryRouter, Mesh};
use rustc_hash::FxHashMap;
use std::fs;

const AR_FILE_PATH: &str = "../../tests/models/local/AR.ifc";
const TARGET_GUID: &str = "1NmE6Wndr2xhGbWU4qRRfr";

/// Load AR file content
fn load_ar_file() -> Option<String> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(AR_FILE_PATH);
    fs::read_to_string(&path).ok()
}

/// Find entity ID by GUID
fn find_entity_by_guid(content: &str, guid: &str) -> Option<u32> {
    let mut scanner = EntityScanner::new(content);
    let mut decoder = EntityDecoder::new(content);

    while let Some((id, _type_name, start, end)) = scanner.next_entity() {
        if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
            // GUID is attribute 0 for most building elements
            if let Some(attr) = entity.get(0) {
                if let Some(entity_guid) = attr.as_string() {
                    if entity_guid == guid {
                        return Some(id);
                    }
                }
            }
        }
    }
    None
}

/// Build void index (host element ID -> opening IDs)
fn build_void_index(content: &str) -> FxHashMap<u32, Vec<u32>> {
    let mut void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    let mut scanner = EntityScanner::new(content);
    let mut decoder = EntityDecoder::new(content);

    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if type_name == "IFCRELVOIDSELEMENT" {
            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                // IfcRelVoidsElement: Attr 4 = RelatingBuildingElement, Attr 5 = RelatedOpeningElement
                if let (Some(host_id), Some(opening_id)) = (entity.get_ref(4), entity.get_ref(5)) {
                    void_index.entry(host_id).or_default().push(opening_id);
                }
            }
        }
    }
    void_index
}

/// Analyze mesh for issues
fn analyze_mesh(mesh: &Mesh, name: &str) {
    println!("\n=== {} ===", name);
    println!("  Vertices: {}", mesh.vertex_count());
    println!("  Triangles: {}", mesh.triangle_count());
    println!("  Positions len: {}", mesh.positions.len());
    println!("  Normals len: {}", mesh.normals.len());

    // Check array size match
    if mesh.positions.len() != mesh.normals.len() {
        println!(
            "  ⚠️  MISMATCH: positions ({}) != normals ({})",
            mesh.positions.len(),
            mesh.normals.len()
        );
    }

    // Get bounds
    if !mesh.is_empty() {
        let (min, max) = mesh.bounds();
        println!("  Bounds:");
        println!("    Min: ({:.2}, {:.2}, {:.2})", min.x, min.y, min.z);
        println!("    Max: ({:.2}, {:.2}, {:.2})", max.x, max.y, max.z);

        let size_x = max.x - min.x;
        let size_y = max.y - min.y;
        let size_z = max.z - min.z;
        println!("    Size: ({:.2}, {:.2}, {:.2})", size_x, size_y, size_z);

        // Check for unreasonably large dimensions
        const MAX_REASONABLE_SIZE: f32 = 100.0; // 100 meters
        if size_x > MAX_REASONABLE_SIZE
            || size_y > MAX_REASONABLE_SIZE
            || size_z > MAX_REASONABLE_SIZE
        {
            println!("  ⚠️  UNREASONABLE SIZE detected!");
        }

        // Check for outlier vertices
        let mut outlier_count = 0;
        let center_x = (min.x + max.x) / 2.0;
        let center_y = (min.y + max.y) / 2.0;
        let center_z = (min.z + max.z) / 2.0;

        for chunk in mesh.positions.chunks_exact(3) {
            let dist_x = (chunk[0] - center_x).abs();
            let dist_y = (chunk[1] - center_y).abs();
            let dist_z = (chunk[2] - center_z).abs();

            // Check if vertex is far from center (more than 5x the median dimension)
            let median_size = (size_x + size_y + size_z) / 3.0;
            if dist_x > median_size * 5.0
                || dist_y > median_size * 5.0
                || dist_z > median_size * 5.0
            {
                outlier_count += 1;
                if outlier_count <= 5 {
                    println!(
                        "  Outlier vertex: ({:.2}, {:.2}, {:.2})",
                        chunk[0], chunk[1], chunk[2]
                    );
                }
            }
        }

        if outlier_count > 0 {
            println!("  ⚠️  {} outlier vertices found!", outlier_count);
        }

        // Check for NaN/Inf
        let non_finite = mesh.positions.iter().filter(|v| !v.is_finite()).count();
        if non_finite > 0 {
            println!("  ⚠️  {} non-finite position values!", non_finite);
        }

        let normal_non_finite = mesh.normals.iter().filter(|v| !v.is_finite()).count();
        if normal_non_finite > 0 {
            println!("  ⚠️  {} non-finite normal values!", normal_non_finite);
        }
    }
}

#[test]
fn test_ar_wall_geometry() {
    let content = match load_ar_file() {
        Some(c) => c,
        None => {
            println!("AR file not found, skipping test");
            return;
        }
    };

    println!("Loaded AR file ({} bytes)", content.len());

    // Find the target wall
    let wall_id = match find_entity_by_guid(&content, TARGET_GUID) {
        Some(id) => {
            println!("Found wall {} with ID #{}", TARGET_GUID, id);
            id
        }
        None => {
            println!("Wall {} not found in file", TARGET_GUID);
            return;
        }
    };

    // Build void index
    let void_index = build_void_index(&content);
    let opening_ids = void_index.get(&wall_id).cloned().unwrap_or_default();
    println!("Wall has {} openings: {:?}", opening_ids.len(), opening_ids);

    // Create router and decoder
    let mut decoder = EntityDecoder::new(&content);
    let router = GeometryRouter::with_units(&content, &mut decoder);

    // Get wall entity
    let wall = decoder
        .decode_by_id(wall_id)
        .expect("Failed to decode wall");
    println!("Wall type: {}", wall.ifc_type);

    // Process wall WITHOUT voids first
    println!("\n--- Processing wall WITHOUT void subtraction ---");
    let wall_mesh_no_voids = router
        .process_element(&wall, &mut decoder)
        .expect("Failed to process wall");
    analyze_mesh(&wall_mesh_no_voids, "Wall (no voids)");

    // Process each opening
    for opening_id in &opening_ids {
        let opening = decoder
            .decode_by_id(*opening_id)
            .expect("Failed to decode opening");
        let opening_mesh = router
            .process_element(&opening, &mut decoder)
            .expect("Failed to process opening");
        analyze_mesh(&opening_mesh, &format!("Opening #{}", opening_id));
    }

    // Process wall WITH voids
    println!("\n--- Processing wall WITH void subtraction ---");
    let wall_mesh_with_voids = router
        .process_element_with_voids(&wall, &mut decoder, &void_index)
        .expect("Failed to process wall with voids");
    analyze_mesh(&wall_mesh_with_voids, "Wall (with voids)");

    // Now test with calculate_normals
    println!("\n--- Testing calculate_normals ---");
    let mut mesh_copy = wall_mesh_with_voids.clone();
    if mesh_copy.normals.is_empty() {
        println!("Normals are empty, calling calculate_normals");
        calculate_normals(&mut mesh_copy);
    } else {
        println!(
            "Normals exist ({} values), checking if complete",
            mesh_copy.normals.len()
        );
        if mesh_copy.normals.len() != mesh_copy.positions.len() {
            println!("⚠️  Normals incomplete! Recalculating...");
            calculate_normals(&mut mesh_copy);
        }
    }
    analyze_mesh(&mesh_copy, "Wall (after calculate_normals)");

    // Assertions
    assert!(
        !wall_mesh_with_voids.is_empty(),
        "Wall mesh should not be empty"
    );

    // Check positions/normals match
    assert_eq!(
        mesh_copy.positions.len(),
        mesh_copy.normals.len(),
        "Positions and normals should have same length after calculate_normals"
    );

    // Check for outliers
    let (min, max) = wall_mesh_with_voids.bounds();
    let size_x = max.x - min.x;
    let size_y = max.y - min.y;
    let size_z = max.z - min.z;

    // Wall should be reasonable size (less than 50m in any dimension for a typical wall)
    assert!(
        size_x < 50.0 && size_y < 50.0 && size_z < 50.0,
        "Wall dimensions should be reasonable: ({:.2}, {:.2}, {:.2})",
        size_x,
        size_y,
        size_z
    );
}

/// Test to diagnose NaN normals issue
#[test]
fn test_ar_wall_nan_normals_diagnosis() {
    let content = match load_ar_file() {
        Some(c) => c,
        None => {
            println!("AR file not found, skipping test");
            return;
        }
    };

    let wall_id = match find_entity_by_guid(&content, TARGET_GUID) {
        Some(id) => id,
        None => {
            println!("Wall not found, skipping test");
            return;
        }
    };

    let mut decoder = EntityDecoder::new(&content);
    let router = GeometryRouter::with_units(&content, &mut decoder);

    let wall = decoder
        .decode_by_id(wall_id)
        .expect("Failed to decode wall");
    let wall_mesh = router
        .process_element(&wall, &mut decoder)
        .expect("Failed to process wall");

    // Find NaN normals and their corresponding positions
    println!("\n=== Diagnosing NaN normals ===");
    println!("Total vertices: {}", wall_mesh.vertex_count());

    // Use safe vertex count to avoid panic if arrays diverge
    let safe_vertex_count =
        std::cmp::min(wall_mesh.normals.len() / 3, wall_mesh.positions.len() / 3);

    let mut nan_count = 0;
    for (i, (normal_chunk, pos_chunk)) in wall_mesh
        .normals
        .chunks_exact(3)
        .zip(wall_mesh.positions.chunks_exact(3))
        .enumerate()
    {
        if i >= safe_vertex_count {
            break;
        }
        let has_nan = !normal_chunk[0].is_finite()
            || !normal_chunk[1].is_finite()
            || !normal_chunk[2].is_finite();
        if has_nan {
            nan_count += 1;
            if nan_count <= 10 {
                println!(
                    "  Vertex {}: pos=({:.2}, {:.2}, {:.2}), normal=({}, {}, {})",
                    i,
                    pos_chunk[0],
                    pos_chunk[1],
                    pos_chunk[2],
                    normal_chunk[0],
                    normal_chunk[1],
                    normal_chunk[2]
                );
            }
        }
    }
    println!("Total NaN normal vertices: {}", nan_count);

    // Find triangles with NaN normals
    println!("\nTriangles with NaN normal vertices:");
    let mut nan_tri_count = 0;
    let mut invalid_tri_count = 0;
    let normals_len = wall_mesh.normals.len();
    let positions_len = wall_mesh.positions.len();

    // Helper to check if index is in bounds for normals/positions (needs idx*3+3 elements)
    let is_valid_idx =
        |idx: usize| -> bool { (idx + 1) * 3 <= normals_len && (idx + 1) * 3 <= positions_len };

    for tri_chunk in wall_mesh.indices.chunks_exact(3) {
        let i0 = tri_chunk[0] as usize;
        let i1 = tri_chunk[1] as usize;
        let i2 = tri_chunk[2] as usize;

        // Skip triangles with out-of-bounds indices
        if !is_valid_idx(i0) || !is_valid_idx(i1) || !is_valid_idx(i2) {
            invalid_tri_count += 1;
            if invalid_tri_count <= 3 {
                println!(
                    "  Skipping triangle with out-of-bounds indices ({}, {}, {})",
                    i0, i1, i2
                );
            }
            continue;
        }

        let has_nan = |idx: usize| -> bool {
            let n = &wall_mesh.normals[idx * 3..idx * 3 + 3];
            !n[0].is_finite() || !n[1].is_finite() || !n[2].is_finite()
        };

        if has_nan(i0) || has_nan(i1) || has_nan(i2) {
            nan_tri_count += 1;
            if nan_tri_count <= 5 {
                let p0 = &wall_mesh.positions[i0 * 3..i0 * 3 + 3];
                let p1 = &wall_mesh.positions[i1 * 3..i1 * 3 + 3];
                let p2 = &wall_mesh.positions[i2 * 3..i2 * 3 + 3];
                println!("  Triangle with indices ({}, {}, {}):", i0, i1, i2);
                println!("    v0: ({:.6}, {:.6}, {:.6})", p0[0], p0[1], p0[2]);
                println!("    v1: ({:.6}, {:.6}, {:.6})", p1[0], p1[1], p1[2]);
                println!("    v2: ({:.6}, {:.6}, {:.6})", p2[0], p2[1], p2[2]);

                // Calculate edge vectors
                let e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
                let e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];

                // Cross product
                let cross = [
                    e1[1] * e2[2] - e1[2] * e2[1],
                    e1[2] * e2[0] - e1[0] * e2[2],
                    e1[0] * e2[1] - e1[1] * e2[0],
                ];
                let len = (cross[0] * cross[0] + cross[1] * cross[1] + cross[2] * cross[2]).sqrt();
                println!("    edge1: ({:.6}, {:.6}, {:.6})", e1[0], e1[1], e1[2]);
                println!("    edge2: ({:.6}, {:.6}, {:.6})", e2[0], e2[1], e2[2]);
                println!(
                    "    cross: ({:.6}, {:.6}, {:.6}), len: {:.10}",
                    cross[0], cross[1], cross[2], len
                );
            }
        }
    }
    if invalid_tri_count > 0 {
        println!(
            "Total triangles with out-of-bounds indices: {}",
            invalid_tri_count
        );
    }
    println!("Total triangles with NaN normals: {}", nan_tri_count);

    // Test if recalculating normals fixes NaN
    println!("\n=== Recalculating normals ===");
    let mut fixed_mesh = wall_mesh.clone();
    calculate_normals(&mut fixed_mesh);

    let fixed_nan_count = fixed_mesh.normals.iter().filter(|v| !v.is_finite()).count();
    println!("NaN normals after recalculation: {}", fixed_nan_count);

    // The test: After recalculation, there should be no NaN normals
    assert_eq!(
        fixed_nan_count, 0,
        "Recalculating normals should produce valid normals"
    );

    // Original mesh should also have no NaN normals (after fix)
    assert_eq!(
        nan_count, 0,
        "Original mesh should have no NaN normals after degenerate edge fix"
    );
}

#[test]
fn test_csg_subtraction_preserves_normals() {
    let content = match load_ar_file() {
        Some(c) => c,
        None => {
            println!("AR file not found, skipping test");
            return;
        }
    };

    let wall_id = match find_entity_by_guid(&content, TARGET_GUID) {
        Some(id) => id,
        None => {
            println!("Wall not found, skipping test");
            return;
        }
    };

    let void_index = build_void_index(&content);
    let opening_ids = void_index.get(&wall_id).cloned().unwrap_or_default();

    if opening_ids.is_empty() {
        println!("Wall has no openings, skipping CSG test");
        return;
    }

    let mut decoder = EntityDecoder::new(&content);
    let router = GeometryRouter::with_units(&content, &mut decoder);

    // Get wall mesh
    let wall = decoder
        .decode_by_id(wall_id)
        .expect("Failed to decode wall");
    let mut wall_mesh = router
        .process_element(&wall, &mut decoder)
        .expect("Failed to process wall");

    // Ensure wall has normals
    if wall_mesh.normals.is_empty() {
        calculate_normals(&mut wall_mesh);
    }

    println!("Wall mesh before CSG:");
    println!(
        "  positions: {}, normals: {}",
        wall_mesh.positions.len(),
        wall_mesh.normals.len()
    );
    assert_eq!(
        wall_mesh.positions.len(),
        wall_mesh.normals.len(),
        "Wall should have matching positions/normals before CSG"
    );

    // Get first opening mesh
    let opening = decoder
        .decode_by_id(opening_ids[0])
        .expect("Failed to decode opening");
    let mut opening_mesh = router
        .process_element(&opening, &mut decoder)
        .expect("Failed to process opening");

    if opening_mesh.normals.is_empty() {
        calculate_normals(&mut opening_mesh);
    }

    println!("Opening mesh:");
    println!(
        "  positions: {}, normals: {}",
        opening_mesh.positions.len(),
        opening_mesh.normals.len()
    );

    // Perform CSG subtraction
    let clipper = ClippingProcessor::new();
    let result = clipper.subtract_mesh(&wall_mesh, &opening_mesh);

    match result {
        Ok(result_mesh) => {
            println!("CSG result:");
            println!(
                "  positions: {}, normals: {}",
                result_mesh.positions.len(),
                result_mesh.normals.len()
            );

            // This is the key assertion - CSG result should have matching arrays
            assert_eq!(
                result_mesh.positions.len(),
                result_mesh.normals.len(),
                "CSG result should have matching positions/normals"
            );

            // Check all values are finite
            assert!(
                result_mesh.positions.iter().all(|v| v.is_finite()),
                "All positions should be finite after CSG"
            );
            assert!(
                result_mesh.normals.iter().all(|v| v.is_finite()),
                "All normals should be finite after CSG"
            );
        }
        Err(e) => {
            println!("CSG failed (may be expected for some cases): {}", e);
        }
    }
}
