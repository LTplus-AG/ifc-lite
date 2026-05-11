// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Test for color extraction, specifically for mapped items.
//! This test demonstrates the bug where colors are not extracted for elements
//! that use MappedRepresentation.
//!
//! The SPARREN element (IFCMEMBER #39678) should have a brown color
//! (R=0.964, G=0.754, B=0.452) from the Kiefer (pine wood) material,
//! but instead it appears grey because the code doesn't follow the
//! MappedItem -> RepresentationMap -> underlying geometry chain.

use ifc_lite_core::{EntityDecoder, EntityScanner, IfcType};
use rustc_hash::FxHashMap;
use std::fs;

fn main() {
    // Try multiple possible paths (relative to different working directories)
    let possible_paths = [
        "../../../tests/models/ara3d/AC20-FZK-Haus.ifc", // From rust/geometry
        "tests/models/ara3d/AC20-FZK-Haus.ifc",          // From project root
        "/home/user/ifc-lite/tests/models/ara3d/AC20-FZK-Haus.ifc", // Absolute
    ];

    let content = possible_paths
        .iter()
        .find_map(|path| fs::read_to_string(path).ok())
        .expect("Failed to read IFC file — run `pnpm fixtures` from the repo root to download tests/models/ara3d/AC20-FZK-Haus.ifc");

    println!("File size: {} bytes", content.len());

    let mut decoder = EntityDecoder::new(&content);

    // Build geometry style index (maps geometry IDs to colors)
    let geometry_styles = build_geometry_style_index(&content, &mut decoder);
    println!("\nGeometry style index: {} entries", geometry_styles.len());

    // Build element style index (maps element IDs to colors)
    let element_styles = build_element_style_index(&content, &geometry_styles, &mut decoder);
    println!("Element style index: {} entries", element_styles.len());

    // Find the SPARREN element (#39678) by its GlobalId
    let sparren_guid = "0DTRkEz0r6gvzG6VdDr24n";
    let mut scanner = EntityScanner::new(&content);

    println!(
        "\n=== Looking for SPARREN element with GUID {} ===",
        sparren_guid
    );

    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if type_name != "IFCMEMBER" {
            continue;
        }

        let entity = match decoder.decode_at(start, end) {
            Ok(e) => e,
            Err(_) => continue,
        };

        // GlobalId is at attribute 0
        let guid = match entity.get(0).and_then(|a| a.as_string()) {
            Some(g) => g,
            None => continue,
        };

        if guid == sparren_guid {
            println!("Found SPARREN element: #{}", id);

            // Check if we have a color for this element
            if let Some(color) = element_styles.get(&id) {
                println!(
                    "  Element color: R={:.3}, G={:.3}, B={:.3}, A={:.3}",
                    color[0], color[1], color[2], color[3]
                );

                // Expected color from IFC: R=0.964, G=0.754, B=0.452
                let expected_r = 0.964;
                let expected_g = 0.754;
                let expected_b = 0.452;

                let is_brown = (color[0] - expected_r).abs() < 0.05
                    && (color[1] - expected_g).abs() < 0.05
                    && (color[2] - expected_b).abs() < 0.05;

                if is_brown {
                    println!("  ✅ Color is correct (brown/wood)!");
                } else {
                    println!(
                        "  ❌ Color is WRONG! Expected brown (R≈{}, G≈{}, B≈{})",
                        expected_r, expected_g, expected_b
                    );
                }
            } else {
                println!("  ❌ No color found for this element!");
            }

            // Trace the representation chain
            trace_element_chain(id, &content, &mut decoder, &geometry_styles);
            break;
        }
    }

    // Test window color separation (frame vs glass)
    test_window_colors(&content, &mut decoder, &geometry_styles);
}

/// Test that window geometry items have different colors (frame = wood, glass = transparent)
fn test_window_colors(
    content: &str,
    decoder: &mut EntityDecoder,
    geometry_styles: &FxHashMap<u32, [f32; 4]>,
) {
    println!("\n=== Testing Window Color Separation ===");

    // Window #23024 has geometry in MappedRepresentation
    // The underlying geometry items are in ShapeRepresentation #22996:
    // - #22506 (Frame) → style #17393 (Kiefer/wood brown)
    // - #22746, #22992 (Glass) → style #22751 (Glas/transparent blue-green)

    let frame_id = 22506u32;
    let glass_id = 22746u32;

    println!("\nFrame geometry #{}:", frame_id);
    if let Some(color) = geometry_styles.get(&frame_id) {
        println!(
            "  Color: R={:.3}, G={:.3}, B={:.3}, A={:.3}",
            color[0], color[1], color[2], color[3]
        );
        // Expected: Kiefer (wood) = R≈0.964, G≈0.754, B≈0.452, opaque
        let is_opaque_wood = color[3] > 0.9 && color[0] > 0.9 && color[2] < 0.5;
        if is_opaque_wood {
            println!("  ✅ Frame is opaque wood color!");
        } else {
            println!("  ⚠️ Frame color unexpected");
        }
    } else {
        println!("  ❌ No color found for frame!");
    }

    println!("\nGlass geometry #{}:", glass_id);
    if let Some(color) = geometry_styles.get(&glass_id) {
        println!(
            "  Color: R={:.3}, G={:.3}, B={:.3}, A={:.3}",
            color[0], color[1], color[2], color[3]
        );
        // Expected: Glas = transparency 0.88, so alpha ≈ 0.12
        let is_transparent = color[3] < 0.2;
        if is_transparent {
            println!("  ✅ Glass is transparent (alpha={:.2})!", color[3]);
        } else {
            println!(
                "  ❌ Glass should be transparent (alpha should be ~0.12, got {:.2})",
                color[3]
            );
        }
    } else {
        println!("  ❌ No color found for glass!");
    }

    // Summary
    let frame_color = geometry_styles.get(&frame_id);
    let glass_color = geometry_styles.get(&glass_id);

    if frame_color.is_some() && glass_color.is_some() {
        let frame = frame_color.unwrap();
        let glass = glass_color.unwrap();

        if (frame[3] - glass[3]).abs() > 0.5 {
            println!("\n✅ SUCCESS: Frame and glass have DIFFERENT transparency!");
            println!("   Frame alpha: {:.2} (opaque)", frame[3]);
            println!("   Glass alpha: {:.2} (transparent)", glass[3]);
        } else {
            println!("\n❌ FAIL: Frame and glass should have different transparency!");
        }
    }
}

/// Trace the representation chain to find where color should come from
fn trace_element_chain(
    element_id: u32,
    _content: &str,
    decoder: &mut EntityDecoder,
    geometry_styles: &FxHashMap<u32, [f32; 4]>,
) {
    println!("\n=== Tracing representation chain for #{} ===", element_id);

    let element = decoder.decode_by_id(element_id).expect("Element not found");
    println!("Element type: {:?}", element.ifc_type);

    // Get representation (attr 6 for IfcProduct)
    let repr_id = match element.get_ref(6) {
        Some(id) => id,
        None => {
            println!("  No representation found");
            return;
        }
    };
    println!("  ProductDefinitionShape: #{}", repr_id);

    let product_shape = decoder
        .decode_by_id(repr_id)
        .expect("ProductDefinitionShape not found");

    // Get representations list (attr 2)
    let reprs_attr = match product_shape.get(2) {
        Some(attr) => attr,
        None => {
            println!("  No representations list");
            return;
        }
    };

    let reprs_list = reprs_attr.as_list().expect("Representations is not a list");

    for repr_item in reprs_list {
        let shape_repr_id = repr_item.as_entity_ref().expect("Not a ref");

        let shape_repr = decoder
            .decode_by_id(shape_repr_id)
            .expect("ShapeRepresentation not found");

        // Get representation type (attr 2)
        let repr_type = shape_repr.get(2).and_then(|a| a.as_string()).unwrap_or("?");
        println!(
            "  ShapeRepresentation #{}: type = '{}'",
            shape_repr_id, repr_type
        );

        // Get items (attr 3)
        let items_attr = match shape_repr.get(3) {
            Some(attr) => attr,
            None => continue,
        };

        let items_list = match items_attr.as_list() {
            Some(list) => list,
            None => continue,
        };

        for geom_item in items_list {
            let geom_id = geom_item.as_entity_ref().expect("Not a ref");

            // Decode geometry item
            let geom = decoder.decode_by_id(geom_id).expect("Geometry not found");
            println!("    Item #{}: {:?}", geom_id, geom.ifc_type);

            // Check if this geometry ID has a color
            if let Some(color) = geometry_styles.get(&geom_id) {
                println!(
                    "      HAS COLOR: R={:.3}, G={:.3}, B={:.3}",
                    color[0], color[1], color[2]
                );
            } else {
                println!("      No color in geometry_styles");
            }

            // If it's a MappedItem, trace further
            if geom.ifc_type == IfcType::IfcMappedItem {
                // MappedItem: MappingSource (RepresentationMap), MappingTarget
                let map_source_id = geom.get_ref(0).expect("MappedItem has no source");
                println!(
                    "      MappingSource (RepresentationMap): #{}",
                    map_source_id
                );

                let rep_map = decoder
                    .decode_by_id(map_source_id)
                    .expect("RepMap not found");

                // RepresentationMap: MappingOrigin, MappedRepresentation
                let mapped_repr_id = rep_map.get_ref(1).expect("RepMap has no repr");
                println!("      MappedRepresentation: #{}", mapped_repr_id);

                let mapped_repr = decoder
                    .decode_by_id(mapped_repr_id)
                    .expect("MappedRepr not found");
                let mapped_repr_type = mapped_repr
                    .get(2)
                    .and_then(|a| a.as_string())
                    .unwrap_or("?");
                println!("      MappedRepresentation type: '{}'", mapped_repr_type);

                // Get items in mapped representation
                let mapped_items_attr = mapped_repr.get(3).expect("No items");
                let mapped_items = mapped_items_attr.as_list().expect("Not a list");

                for mapped_geom_item in mapped_items {
                    let mapped_geom_id = mapped_geom_item.as_entity_ref().expect("Not a ref");
                    let mapped_geom = decoder.decode_by_id(mapped_geom_id).expect("Not found");
                    println!(
                        "        Underlying geometry #{}: {:?}",
                        mapped_geom_id, mapped_geom.ifc_type
                    );

                    if let Some(color) = geometry_styles.get(&mapped_geom_id) {
                        println!(
                            "          🎨 THIS HAS THE COLOR: R={:.3}, G={:.3}, B={:.3}",
                            color[0], color[1], color[2]
                        );
                    }
                }
            }
        }
    }
}

/// Build geometry style index: maps geometry IDs to RGBA colors
/// This looks for IfcStyledItem entities and extracts colors from them
fn build_geometry_style_index(
    content: &str,
    decoder: &mut EntityDecoder,
) -> FxHashMap<u32, [f32; 4]> {
    let mut style_index: FxHashMap<u32, [f32; 4]> = FxHashMap::default();
    let mut scanner = EntityScanner::new(content);

    while let Some((_id, type_name, start, end)) = scanner.next_entity() {
        if type_name != "IFCSTYLEDITEM" {
            continue;
        }

        let styled_item = match decoder.decode_at(start, end) {
            Ok(entity) => entity,
            Err(_) => continue,
        };

        // Attr 0: Item (geometry reference)
        let geometry_id = match styled_item.get_ref(0) {
            Some(id) => id,
            None => continue,
        };

        if style_index.contains_key(&geometry_id) {
            continue;
        }

        // Attr 1: Styles
        let styles_attr = match styled_item.get(1) {
            Some(attr) => attr,
            None => continue,
        };

        if let Some(color) = extract_color_from_styles(styles_attr, decoder) {
            style_index.insert(geometry_id, color);
        }
    }

    style_index
}

/// Build element style index: maps building element IDs to colors
/// FIXED version that follows MappedItem references
fn build_element_style_index(
    content: &str,
    geometry_styles: &FxHashMap<u32, [f32; 4]>,
    decoder: &mut EntityDecoder,
) -> FxHashMap<u32, [f32; 4]> {
    let mut element_styles: FxHashMap<u32, [f32; 4]> = FxHashMap::default();
    let mut scanner = EntityScanner::new(content);

    while let Some((element_id, type_name, start, end)) = scanner.next_entity() {
        if !ifc_lite_core::has_geometry_by_name(type_name) {
            continue;
        }

        let element = match decoder.decode_at(start, end) {
            Ok(entity) => entity,
            Err(_) => continue,
        };

        let repr_id = match element.get_ref(6) {
            Some(id) => id,
            None => continue,
        };

        let product_shape = match decoder.decode_by_id(repr_id) {
            Ok(entity) => entity,
            Err(_) => continue,
        };

        let reprs_attr = match product_shape.get(2) {
            Some(attr) => attr,
            None => continue,
        };

        let reprs_list = match reprs_attr.as_list() {
            Some(list) => list,
            None => continue,
        };

        for repr_item in reprs_list {
            let shape_repr_id = match repr_item.as_entity_ref() {
                Some(id) => id,
                None => continue,
            };

            let shape_repr = match decoder.decode_by_id(shape_repr_id) {
                Ok(entity) => entity,
                Err(_) => continue,
            };

            let items_attr = match shape_repr.get(3) {
                Some(attr) => attr,
                None => continue,
            };

            let items_list = match items_attr.as_list() {
                Some(list) => list,
                None => continue,
            };

            for geom_item in items_list {
                let geom_id = match geom_item.as_entity_ref() {
                    Some(id) => id,
                    None => continue,
                };

                // FIXED: Follow MappedItem references to find colors
                if let Some(color) = find_color_for_geometry(geom_id, geometry_styles, decoder) {
                    element_styles.insert(element_id, color);
                    break;
                }
            }

            if element_styles.contains_key(&element_id) {
                break;
            }
        }
    }

    element_styles
}

/// Find color for a geometry item, following MappedItem references if needed.
fn find_color_for_geometry(
    geom_id: u32,
    geometry_styles: &FxHashMap<u32, [f32; 4]>,
    decoder: &mut EntityDecoder,
) -> Option<[f32; 4]> {
    // First check if this geometry ID directly has a color
    if let Some(&color) = geometry_styles.get(&geom_id) {
        return Some(color);
    }

    // If not, check if it's an IfcMappedItem and follow the reference
    let geom = decoder.decode_by_id(geom_id).ok()?;

    if geom.ifc_type == IfcType::IfcMappedItem {
        // IfcMappedItem: MappingSource (IfcRepresentationMap ref), MappingTarget
        let map_source_id = geom.get_ref(0)?;

        // Decode the IfcRepresentationMap
        let rep_map = decoder.decode_by_id(map_source_id).ok()?;

        // IfcRepresentationMap: MappingOrigin, MappedRepresentation
        let mapped_repr_id = rep_map.get_ref(1)?;

        // Decode the mapped IfcShapeRepresentation
        let mapped_repr = decoder.decode_by_id(mapped_repr_id).ok()?;

        // IfcShapeRepresentation: ContextOfItems, RepresentationIdentifier, RepresentationType, Items
        let items_attr = mapped_repr.get(3)?;
        let items_list = items_attr.as_list()?;

        // Check each underlying geometry item for a color
        for item in items_list {
            if let Some(underlying_geom_id) = item.as_entity_ref() {
                // Recursively find color (handles nested MappedItems)
                if let Some(color) =
                    find_color_for_geometry(underlying_geom_id, geometry_styles, decoder)
                {
                    return Some(color);
                }
            }
        }
    }

    None
}

/// Extract RGBA color from styles attribute
fn extract_color_from_styles(
    styles_attr: &ifc_lite_core::AttributeValue,
    decoder: &mut EntityDecoder,
) -> Option<[f32; 4]> {
    if let Some(list) = styles_attr.as_list() {
        for item in list {
            if let Some(style_id) = item.as_entity_ref() {
                if let Some(color) = extract_color_from_style_assignment(style_id, decoder) {
                    return Some(color);
                }
            }
        }
    } else if let Some(style_id) = styles_attr.as_entity_ref() {
        return extract_color_from_style_assignment(style_id, decoder);
    }
    None
}

fn extract_color_from_style_assignment(
    style_id: u32,
    decoder: &mut EntityDecoder,
) -> Option<[f32; 4]> {
    let style = decoder.decode_by_id(style_id).ok()?;

    match style.ifc_type {
        IfcType::IfcPresentationStyle => {
            let styles_attr = style.get(0)?;
            if let Some(list) = styles_attr.as_list() {
                for item in list {
                    if let Some(inner_id) = item.as_entity_ref() {
                        if let Some(color) = extract_color_from_surface_style(inner_id, decoder) {
                            return Some(color);
                        }
                    }
                }
            }
        }
        IfcType::IfcSurfaceStyle => {
            return extract_color_from_surface_style(style_id, decoder);
        }
        _ => {
            // Handle IfcPresentationStyleAssignment
            let styles_attr = style.get(0)?;
            if let Some(list) = styles_attr.as_list() {
                for item in list {
                    if let Some(inner_id) = item.as_entity_ref() {
                        if let Some(color) = extract_color_from_surface_style(inner_id, decoder) {
                            return Some(color);
                        }
                    }
                }
            }
        }
    }
    None
}

fn extract_color_from_surface_style(
    style_id: u32,
    decoder: &mut EntityDecoder,
) -> Option<[f32; 4]> {
    let style = decoder.decode_by_id(style_id).ok()?;

    if style.ifc_type != IfcType::IfcSurfaceStyle {
        return None;
    }

    // IfcSurfaceStyle: Name, Side, Styles
    let styles_attr = style.get(2)?;

    if let Some(list) = styles_attr.as_list() {
        for item in list {
            if let Some(element_id) = item.as_entity_ref() {
                if let Some(color) = extract_color_from_rendering(element_id, decoder) {
                    return Some(color);
                }
            }
        }
    }
    None
}

fn extract_color_from_rendering(
    rendering_id: u32,
    decoder: &mut EntityDecoder,
) -> Option<[f32; 4]> {
    let rendering = decoder.decode_by_id(rendering_id).ok()?;

    match rendering.ifc_type {
        IfcType::IfcSurfaceStyleRendering | IfcType::IfcSurfaceStyleShading => {
            let color_ref = rendering.get_ref(0)?;
            let [r, g, b, _] = extract_color_rgb(color_ref, decoder)?;
            let transparency = rendering.get_float(1).unwrap_or(0.0);
            let alpha = 1.0 - transparency as f32;
            return Some([r, g, b, alpha.max(0.0).min(1.0)]);
        }
        _ => {}
    }
    None
}

fn extract_color_rgb(color_id: u32, decoder: &mut EntityDecoder) -> Option<[f32; 4]> {
    let color = decoder.decode_by_id(color_id).ok()?;

    if color.ifc_type != IfcType::IfcColourRgb {
        return None;
    }

    // IfcColourRgb: Name, Red, Green, Blue
    let red = color.get_float(1).unwrap_or(0.8);
    let green = color.get_float(2).unwrap_or(0.8);
    let blue = color.get_float(3).unwrap_or(0.8);

    Some([red as f32, green as f32, blue as f32, 1.0])
}
