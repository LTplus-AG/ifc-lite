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

/// `IFC_TYPES` is the catalog the enum itself cannot give you: `Unknown(u32)`
/// makes `IfcType` open, and the CRC32 ids are sparse, so there is no way to
/// walk the schema from the type alone. Anything that has to reason about the
/// WHOLE schema — mapping every class to another vocabulary, auditing coverage,
/// generating a table — needs this or has to re-parse the EXPRESS file.
#[cfg(test)]
mod ifc_types_catalog {
    use crate::{IfcType, IFC_TYPES};

    /// Every entry must round-trip through the string form, which is the form a
    /// STEP file carries. A generator emitting a name `from_str` cannot read
    /// back would produce a catalog that silently omits those classes.
    #[test]
    fn every_entry_round_trips_through_its_name() {
        for &t in IFC_TYPES {
            let name = t.name();
            assert_eq!(
                IfcType::from_str(&name.to_uppercase()),
                t,
                "{name} did not round-trip"
            );
            assert_eq!(IfcType::from_id(t.id()), t, "{name} did not round-trip by id");
        }
    }

    /// No repeats, and `Unknown` is not a schema entity.
    #[test]
    fn the_catalog_is_a_set_of_real_entities() {
        let mut seen = std::collections::HashSet::new();
        for &t in IFC_TYPES {
            assert!(seen.insert(t.name()), "{} appears twice", t.name());
            assert!(
                !matches!(t, IfcType::Unknown(_)),
                "Unknown is the absence of a type, not one of them"
            );
        }
        assert_eq!(seen.len(), IFC_TYPES.len());
    }

    /// Every supertype named by a member is itself a member, so a caller can
    /// walk `parent()` to the root without leaving the catalog. This is the
    /// property that makes "map to the nearest mapped ancestor" a schema fact
    /// rather than a guess about names.
    #[test]
    fn every_parent_is_itself_in_the_catalog() {
        let known: std::collections::HashSet<&str> = IFC_TYPES.iter().map(|t| t.name()).collect();
        for &t in IFC_TYPES {
            let mut cur = t.parent();
            while let Some(p) = cur {
                assert!(
                    known.contains(p.name()),
                    "{} has an ancestor {} outside the catalog",
                    t.name(),
                    p.name()
                );
                cur = p.parent();
            }
        }
    }

    /// A spot-check that the catalog is the real schema and not a stub: the
    /// classes a building model is mostly made of are present and concrete, and
    /// the roots they hang from are abstract.
    #[test]
    fn it_holds_the_schema_and_not_a_sample_of_it() {
        // Exact, not a floor. `> 800` would accept a generator regression that
        // silently dropped 75 entities, and a schema update SHOULD be a
        // deliberate edit here rather than something a loose bound absorbs.
        assert_eq!(
            IFC_TYPES.len(),
            876,
            "the IFC4X3 catalog has an unexpected entity count"
        );
        let by_name: std::collections::HashMap<&str, IfcType> =
            IFC_TYPES.iter().map(|t| (t.name(), *t)).collect();
        for name in ["IfcWall", "IfcSlab", "IfcDoor", "IfcWindow", "IfcBuildingStorey"] {
            let t = by_name[name];
            assert!(!t.is_abstract(), "{name} is instantiable");
            assert!(t.is_subtype_of(by_name["IfcProduct"]), "{name} is a product");
        }
        assert!(by_name["IfcProduct"].is_abstract());
        assert_eq!(
            by_name["IfcWallStandardCase"].parent(),
            Some(by_name["IfcWall"]),
            "the supertype chain is what makes ancestor mapping a fact"
        );
    }
}

/// `attribute_names` exists so nothing has to hardcode a positional index with
/// a comment next to it, which is how every attribute read in this workspace is
/// written today and how one of them will eventually be wrong.
#[cfg(test)]
mod attribute_names {
    use crate::{IfcType, IFC_TYPES};

    /// The property the whole thing rests on: supertype attributes come FIRST,
    /// so the position here is the position `DecodedEntity::get` indexes. A
    /// generator using an entity's OWN attribute list would be wrong about
    /// every index on every subtype, and wrong in a way that still returns a
    /// value.
    #[test]
    fn inherited_attributes_come_first_and_in_root_to_leaf_order() {
        // IfcRoot declares GlobalId, OwnerHistory, Name, Description; every
        // rooted entity therefore starts with exactly those four.
        for name in ["IfcWall", "IfcBuildingStorey", "IfcDoor", "IfcProject"] {
            let t = IfcType::from_str(&name.to_uppercase());
            assert_eq!(
                &t.attribute_names()[..4],
                &["GlobalId", "OwnerHistory", "Name", "Description"],
                "{name} must inherit IfcRoot's four attributes at positions 0-3"
            );
        }
    }

    /// The indices the export path currently hardcodes, asserted against the
    /// schema rather than against a comment. If these ever disagree, one of the
    /// two is wrong and it is no longer a matter of opinion which.
    #[test]
    fn it_agrees_with_the_positions_the_workspace_already_reads() {
        let wall = IfcType::from_str("IFCWALL");
        for (name, want) in [
            ("GlobalId", 0),
            ("Name", 2),
            ("Description", 3),
            ("ObjectType", 4),
            ("ObjectPlacement", 5),
            ("Representation", 6),
        ] {
            assert_eq!(
                wall.attribute_index(name),
                Some(want),
                "IfcProduct attribute {name} is read at index {want} in this workspace"
            );
        }
    }

    /// The motivating case. `Elevation` is the attribute that makes an
    /// IfcBuildingStorey placeable, and it is the last of ten.
    #[test]
    fn a_storeys_elevation_is_reachable_by_name() {
        let storey = IfcType::from_str("IFCBUILDINGSTOREY");
        assert_eq!(storey.attribute_index("Elevation"), Some(9));
        assert_eq!(storey.attribute_names().len(), 10);
    }

    #[test]
    fn an_unknown_name_is_none_and_the_lookup_is_case_sensitive() {
        let wall = IfcType::from_str("IFCWALL");
        assert_eq!(wall.attribute_index("NotAnAttribute"), None);
        assert_eq!(
            wall.attribute_index("globalid"),
            None,
            "EXPRESS names are PascalCase; a case-insensitive match would let a \
             typo resolve to the wrong attribute on some other entity"
        );
    }

    /// Every catalog entry answers, and no entry repeats a name — a duplicate
    /// would make `attribute_index` return the first of two real positions.
    #[test]
    fn every_type_has_a_consistent_attribute_list() {
        for &t in IFC_TYPES {
            let names = t.attribute_names();
            let mut seen = std::collections::HashSet::new();
            for n in names {
                assert!(
                    seen.insert(*n),
                    "{} lists {n} twice; attribute_index would answer with the \
                     first of two real positions",
                    t.name()
                );
            }
            for (i, n) in names.iter().enumerate() {
                assert_eq!(t.attribute_index(n), Some(i));
            }
        }
    }

    /// `Unknown` is the absence of a type, so it has no attributes to name —
    /// and must not panic or answer with some other entity's list.
    #[test]
    fn unknown_names_nothing() {
        let u = IfcType::from_str("NOT_AN_IFC_TYPE_AT_ALL");
        assert!(matches!(u, IfcType::Unknown(_)));
        assert!(u.attribute_names().is_empty());
        assert_eq!(u.attribute_index("GlobalId"), None);
    }
}
