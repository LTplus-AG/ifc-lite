// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use ifc_lite_core::{EntityDecoder, EntityScanner, IfcType};
use ifc_lite_geometry::GeometryRouter;
use std::fs;

fn main() {
    let content = fs::read("../../../01_Snowdon_Towers_Sample_Structural(1).ifc")
        .expect("Failed to read IFC file");

    println!("File size: {} bytes", content.len());

    // Create scanner, decoder, and router
    let router = GeometryRouter::new();
    let mut scanner = EntityScanner::new(&content);
    let mut decoder = EntityDecoder::new(&content);

    let mut wall_count = 0;
    let mut processed_count = 0;

    // Process first few walls
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if type_name.contains("WALL") {
            wall_count += 1;

            if wall_count <= 5 {
                println!("\n--- Wall #{}: {} ---", id, type_name);

                // Check if this type has geometry
                let ifc_type = IfcType::from_str(type_name);
                println!("Type: {:?}", ifc_type);
                println!(
                    "Has geometry: {}",
                    ifc_lite_core::has_geometry_by_name(type_name)
                );
                println!(
                    "Has geometry (schema): {}",
                    router.schema().has_geometry(&ifc_type)
                );

                // Try to decode
                if let Ok(entity) = decoder.decode_at(start, end) {
                    println!("✅ Decoded successfully");
                    println!("   Attributes: {}", entity.attributes.len());

                    // Check representation attribute (index 6)
                    if let Some(rep_attr) = entity.get(6) {
                        if !rep_attr.is_null() {
                            println!("   Has representation attribute");

                            // Try to resolve it
                            if let Ok(Some(rep_entity)) = decoder.resolve_ref(rep_attr) {
                                println!("   Representation type: {:?}", rep_entity.ifc_type);

                                // Get representations list
                                if let Some(reps_attr) = rep_entity.get(2) {
                                    if let Ok(reps) = decoder.resolve_ref_list(reps_attr) {
                                        println!("   Found {} representations", reps.len());

                                        for (i, shape_rep) in reps.iter().enumerate() {
                                            println!("     Rep {}: {:?}", i, shape_rep.ifc_type);

                                            // Get RepresentationType (attribute 2)
                                            if let Some(rep_type_attr) = shape_rep.get(2) {
                                                if let Some(rep_type) = rep_type_attr.as_string() {
                                                    println!(
                                                        "       RepresentationType: {}",
                                                        rep_type
                                                    );
                                                }
                                            }

                                            // Get items
                                            if let Some(items_attr) = shape_rep.get(3) {
                                                if let Ok(items) =
                                                    decoder.resolve_ref_list(items_attr)
                                                {
                                                    println!("       Items: {}", items.len());
                                                    for item in &items {
                                                        println!("         - {:?}", item.ifc_type);
                                                    }

                                                    // Try to process with geometry router
                                                    println!(
                                                        "       Trying to process geometry..."
                                                    );
                                                    match router
                                                        .process_element(&entity, &mut decoder)
                                                    {
                                                        Ok(mesh) => {
                                                            println!("       ✅ Mesh generated!");
                                                            println!(
                                                                "          Vertices: {}",
                                                                mesh.vertex_count()
                                                            );
                                                            println!(
                                                                "          Triangles: {}",
                                                                mesh.triangle_count()
                                                            );
                                                        }
                                                        Err(e) => {
                                                            println!("       ❌ Error: {}", e);
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        } else {
                            println!("   Representation attribute is NULL");
                        }
                    } else {
                        println!("   No representation attribute");
                    }

                    processed_count += 1;
                } else {
                    println!("❌ Failed to decode entity");
                }
            }
        }
    }

    println!("\n========== SUMMARY ==========");
    println!("Total wall entities: {}", wall_count);
    println!("Decoded successfully: {}", processed_count);
}
