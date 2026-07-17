// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

#[test]
fn test_schema_geometry_categories() {
    let schema = IfcSchema::new();

    assert_eq!(
        schema.geometry_category(&IfcType::IfcExtrudedAreaSolid),
        Some(GeometryCategory::SweptSolid)
    );

    assert_eq!(
        schema.geometry_category(&IfcType::IfcBooleanResult),
        Some(GeometryCategory::Boolean)
    );

    assert_eq!(
        schema.geometry_category(&IfcType::IfcTriangulatedFaceSet),
        Some(GeometryCategory::ExplicitMesh)
    );

    assert_eq!(
        schema.profile_category(&IfcType::IfcRoundedRectangleProfileDef),
        Some(ProfileCategory::Parametric)
    );
}

#[test]
fn test_parse_index_list_rejects_out_of_range() {
    // A face whose indices are out of the valid u32 vertex range: too large
    // (> u32::MAX), zero, and negative. Each must map to the u32::MAX
    // sentinel (dropped downstream) instead of an `(i64 - 1) as u32`
    // truncation/wrap to a valid-looking vertex.
    let face = AttributeValue::List(vec![
        AttributeValue::Integer(5_000_000_000), // > u32::MAX
        AttributeValue::Integer(0),             // non-positive
        AttributeValue::Integer(-4),            // negative
    ]);
    let out = AttributeValue::parse_index_list(&[face]);
    assert_eq!(out, vec![u32::MAX, u32::MAX, u32::MAX]);

    // A well-formed face is still converted 1-based → 0-based.
    let ok = AttributeValue::List(vec![
        AttributeValue::Integer(1),
        AttributeValue::Integer(2),
        AttributeValue::Integer(3),
    ]);
    assert_eq!(AttributeValue::parse_index_list(&[ok]), vec![0, 1, 2]);
}

#[test]
fn test_parse_index_list_extreme_i64_values() {
    // i64::MIN: the old `(i - 1) as u32` would OVERFLOW i64 in the subtraction
    // (debug panic) before even truncating. Must map to the sentinel.
    // i64::MAX: far beyond u32, must map to the sentinel.
    // 4294967297 (2^32 + 1): the old truncation wrapped it to vertex 0 —
    //   a valid-looking alias. Must map to the sentinel instead.
    // 4294967295 (u32::MAX as a 1-based index): zero-based 4294967294 still
    //   fits in u32, so it converts normally (dropped later only if the mesh
    //   is smaller — which any real mesh is).
    let face = AttributeValue::List(vec![
        AttributeValue::Integer(i64::MIN),
        AttributeValue::Integer(i64::MAX),
        AttributeValue::Integer(4_294_967_297),
    ]);
    let out = AttributeValue::parse_index_list(&[face]);
    assert_eq!(out, vec![u32::MAX, u32::MAX, u32::MAX]);

    let boundary = AttributeValue::List(vec![
        AttributeValue::Integer(4_294_967_295), // u32::MAX 1-based → MAX-1 0-based
        AttributeValue::Integer(4_294_967_296), // 2^32 1-based → u32::MAX 0-based (sentinel value, dropped)
        AttributeValue::Integer(2),
    ]);
    assert_eq!(
        AttributeValue::parse_index_list(&[boundary]),
        vec![u32::MAX - 1, u32::MAX, 1]
    );
}

#[test]
fn test_attribute_value_conversion() {
    let token = Token::EntityRef(123);
    let attr = AttributeValue::from_token(&token);
    assert_eq!(attr.as_entity_ref(), Some(123));

    let token = Token::String(b"test");
    let attr = AttributeValue::from_token(&token);
    assert_eq!(attr.as_string(), Some("test"));
}

#[test]
fn test_decoded_entity() {
    let entity = DecodedEntity::new(
        1,
        IfcType::IfcWall,
        vec![
            AttributeValue::EntityRef(2),
            AttributeValue::String("Wall-001".to_string()),
            AttributeValue::Float(3.5),
        ],
    );

    assert_eq!(entity.get_ref(0), Some(2));
    assert_eq!(entity.get_string(1), Some("Wall-001"));
    assert_eq!(entity.get_float(2), Some(3.5));
}

#[test]
fn test_as_float_with_typed_value() {
    // Test plain float
    let plain_float = AttributeValue::Float(0.5);
    assert_eq!(plain_float.as_float(), Some(0.5));

    // Test integer to float conversion
    let integer = AttributeValue::Integer(42);
    assert_eq!(integer.as_float(), Some(42.0));

    // Test TypedValue wrapper like IFCNORMALISEDRATIOMEASURE(0.5)
    // This is stored as List([String("IFCNORMALISEDRATIOMEASURE"), Float(0.5)])
    let typed_value = AttributeValue::List(vec![
        AttributeValue::String("IFCNORMALISEDRATIOMEASURE".to_string()),
        AttributeValue::Float(0.5),
    ]);
    assert_eq!(typed_value.as_float(), Some(0.5));

    // Test TypedValue with integer
    let typed_int = AttributeValue::List(vec![
        AttributeValue::String("IFCINTEGER".to_string()),
        AttributeValue::Integer(100),
    ]);
    assert_eq!(typed_int.as_float(), Some(100.0));

    // Test that non-typed lists return None
    let regular_list =
        AttributeValue::List(vec![AttributeValue::Float(1.0), AttributeValue::Float(2.0)]);
    assert_eq!(regular_list.as_float(), None);

    // Test that empty list returns None
    let empty_list = AttributeValue::List(vec![]);
    assert_eq!(empty_list.as_float(), None);
}
