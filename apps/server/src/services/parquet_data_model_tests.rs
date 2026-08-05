// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use crate::services::data_model::{DataModel, Property, PropertySet};
use arrow::array::Array;
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;

fn read_section(section: &[u8]) -> RecordBatch {
    let reader = ParquetRecordBatchReaderBuilder::try_new(bytes::Bytes::copy_from_slice(section))
        .expect("parquet reader")
        .build()
        .expect("build reader");
    let batches: Vec<RecordBatch> = reader.map(|b| b.expect("batch")).collect();
    arrow::compute::concat_batches(&batches[0].schema(), &batches).expect("concat")
}

/// Split the combined data-model payload into its length-prefixed sections.
fn split_sections(payload: &[u8]) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    let mut offset = 0usize;
    while offset + 4 <= payload.len() {
        let len = u32::from_le_bytes(payload[offset..offset + 4].try_into().unwrap()) as usize;
        offset += 4;
        out.push(payload[offset..offset + len].to_vec());
        offset += len;
    }
    out
}

/// A `DataModel` with every table empty. Tests that target one table fill in
/// only that field, so a mutation elsewhere cannot be masked by unrelated rows.
fn empty_data_model() -> DataModel {
    DataModel {
        entities: vec![],
        property_sets: vec![],
        quantity_sets: vec![],
        relationships: vec![],
        classifications: vec![],
        materials: vec![],
        documents: vec![],
        spatial_hierarchy: SpatialHierarchyData {
            nodes: vec![],
            // `split_sections` treats the trailing `project_id` bytes as one
            // more length prefix, so keep it 0 to make that read a no-op.
            project_id: 0,
            element_to_storey: vec![],
            element_to_building: vec![],
            element_to_site: vec![],
            element_to_space: vec![],
        },
    }
}

/// Roundtrip: the classification/material/document tables (issue #900) must
/// serialize without error and read back with the expected rows. This
/// executes the new `serialize_*_table` paths that the extraction tests don't.
#[test]
fn serializes_and_reads_back_association_tables() {
    let dm = DataModel {
        entities: vec![],
        property_sets: vec![],
        quantity_sets: vec![],
        relationships: vec![],
        classifications: vec![ClassificationAssociation {
            element_id: 7,
            system_name: Some("Uniclass 2015".into()),
            identification: Some("EF_25_10".into()),
            name: Some("Walls".into()),
            location: None,
        }],
        materials: vec![
            MaterialAssociation {
                element_id: 7,
                set_name: Some("WallSet".into()),
                layer_index: 0,
                material_name: "Concrete".into(),
                thickness: Some(0.2),
                is_ventilated: Some(false),
                category: None,
            },
            MaterialAssociation {
                element_id: 7,
                set_name: Some("WallSet".into()),
                layer_index: 1,
                material_name: "Insulation".into(),
                thickness: None,
                is_ventilated: None,
                category: Some("thermal".into()),
            },
        ],
        documents: vec![DocumentAssociation {
            element_id: 7,
            identification: Some("DOC-1".into()),
            name: Some("Spec".into()),
            location: None,
            description: None,
        }],
        spatial_hierarchy: SpatialHierarchyData {
            nodes: vec![],
            project_id: 0,
            element_to_storey: vec![],
            element_to_building: vec![],
            element_to_site: vec![],
            element_to_space: vec![],
        },
    };

    let payload = serialize_data_model_to_parquet(&dm).expect("serialize");
    let sections = split_sections(&payload);
    // entities, properties, quantities, relationships, spatial, classifications, materials, documents
    assert_eq!(sections.len(), 8, "expected 8 length-prefixed sections");

    let classifications = read_section(&sections[5]);
    assert_eq!(classifications.num_rows(), 1);

    let materials = read_section(&sections[6]);
    assert_eq!(materials.num_rows(), 2);
    // Nullable thickness column survives the roundtrip (row 0 = 0.2, row 1 = null).
    let thickness = materials
        .column_by_name("thickness")
        .unwrap()
        .as_any()
        .downcast_ref::<Float64Array>()
        .unwrap();
    assert!((thickness.value(0) - 0.2).abs() < 1e-9);
    assert!(thickness.is_null(1));

    let documents = read_section(&sections[7]);
    assert_eq!(documents.num_rows(), 1);
}

/// The properties table's `values_json` column round-trips (issue #1766): a
/// multi-valued property's candidate array serializes to a JSON string and a
/// single-valued property leaves the column null. Guards the untested
/// serialize→parquet→(client-decodes) seam against a column-name/encoding typo.
#[test]
fn serializes_and_reads_back_property_values_json() {
    let dm = DataModel {
        entities: vec![],
        property_sets: vec![PropertySet {
            pset_id: 42,
            pset_name: "Pset_WallCommon".into(),
            properties: vec![
                Property {
                    property_name: "AcousticRating".into(),
                    property_value: "R1, R2".into(),
                    property_type: "string".into(),
                    data_type: None,
                    values: Some(vec!["R1".into(), "R2".into()]),
                },
                Property {
                    property_name: "FireRating".into(),
                    property_value: "REI 120".into(),
                    property_type: "string".into(),
                    data_type: Some("IFCLABEL".into()),
                    values: None,
                },
            ],
        }],
        quantity_sets: vec![],
        relationships: vec![],
        classifications: vec![],
        materials: vec![],
        documents: vec![],
        spatial_hierarchy: SpatialHierarchyData {
            nodes: vec![],
            project_id: 0,
            element_to_storey: vec![],
            element_to_building: vec![],
            element_to_site: vec![],
            element_to_space: vec![],
        },
    };

    let payload = serialize_data_model_to_parquet(&dm).expect("serialize");
    let properties = read_section(&split_sections(&payload)[1]); // section 1 = properties

    let names = properties
        .column_by_name("property_name")
        .unwrap()
        .as_any()
        .downcast_ref::<arrow::array::StringArray>()
        .unwrap();
    let values_json = properties
        .column_by_name("values_json")
        .expect("values_json column present")
        .as_any()
        .downcast_ref::<arrow::array::StringArray>()
        .unwrap();

    for i in 0..properties.num_rows() {
        match names.value(i) {
            "AcousticRating" => assert_eq!(values_json.value(i), r#"["R1","R2"]"#),
            "FireRating" => assert!(values_json.is_null(i), "single value → null candidates"),
            other => panic!("unexpected property {other}"),
        }
    }
}

/// `relating_id` and `related_id` are both `u32` and adjacent in the tuple the
/// relationships table is built from, so swapping them is type-correct and
/// silent. Nothing asserted which column each value landed in — the swap
/// survived the whole server suite. Distinct values (10 vs 20) pin each to its
/// own column, so an inversion fails on the value rather than on a row count.
#[test]
fn relationship_columns_do_not_swap_relating_and_related() {
    let mut dm = empty_data_model();
    dm.relationships = vec![Relationship {
        rel_type: "IfcRelAggregates".into(),
        relating_id: 10,
        related_id: 20,
    }];

    let payload = serialize_data_model_to_parquet(&dm).expect("serialize");
    let sections = split_sections(&payload);
    // Section order: entities, properties, quantities, relationships, spatial,
    // classifications, materials, documents. Index directly rather than
    // scanning — `read_section` panics on an empty table, and every other
    // section here is empty by construction.
    let batch = read_section(&sections[3]);
    assert!(
        batch.schema().field_with_name("relating_id").is_ok(),
        "section 3 must be the relationships table"
    );

    let relating = batch
        .column_by_name("relating_id")
        .expect("relating_id column")
        .as_any()
        .downcast_ref::<arrow::array::UInt32Array>()
        .expect("u32 column");
    let related = batch
        .column_by_name("related_id")
        .expect("related_id column")
        .as_any()
        .downcast_ref::<arrow::array::UInt32Array>()
        .expect("u32 column");

    assert_eq!(relating.value(0), 10, "relating_id must carry the relating entity");
    assert_eq!(related.value(0), 20, "related_id must carry the related entity");
}

/// `has_geometry` is the only boolean the entities table carries, and no test
/// decoded that table at all — inverting it was invisible. Two entities with
/// opposite values pin both polarities, so neither a blanket `!` nor a
/// constant survives.
#[test]
fn serializes_and_reads_back_entities_table() {
    fn entity(entity_id: u32, has_geometry: bool) -> EntityMetadata {
        EntityMetadata {
            entity_id,
            type_name: "IfcWall".into(),
            global_id: None,
            name: None,
            description: None,
            object_type: None,
            tag: None,
            predefined_type: None,
            has_geometry,
        }
    }

    let mut dm = empty_data_model();
    dm.entities = vec![entity(1, true), entity(2, false)];

    let payload = serialize_data_model_to_parquet(&dm).expect("serialize");
    let sections = split_sections(&payload);
    // Section order: entities, properties, quantities, relationships, spatial,
    // classifications, materials, documents.
    let batch = read_section(&sections[0]);

    let ids = batch
        .column_by_name("entity_id")
        .expect("entity_id column")
        .as_any()
        .downcast_ref::<arrow::array::UInt32Array>()
        .expect("u32 column");
    let has_geometry = batch
        .column_by_name("has_geometry")
        .expect("has_geometry column")
        .as_any()
        .downcast_ref::<arrow::array::BooleanArray>()
        .expect("bool column");

    assert_eq!(ids.value(0), 1);
    assert_eq!(ids.value(1), 2);
    assert!(has_geometry.value(0), "entity 1 declared geometry");
    assert!(!has_geometry.value(1), "entity 2 declared none");
}

/// `serialize_lookup_table` pushes an `(element_id, spatial_id)` pair into two
/// same-typed columns, so swapping the push order is silent. No test decoded
/// any spatial lookup table. Distinct values pin each id to its own column.
#[test]
fn serializes_and_reads_back_spatial_lookup_table() {
    let mut dm = empty_data_model();
    dm.spatial_hierarchy.element_to_storey = vec![(42, 7)];

    let payload = serialize_data_model_to_parquet(&dm).expect("serialize");
    let sections = split_sections(&payload);
    // The spatial section is itself length-prefixed: nodes, element_to_storey,
    // element_to_building, element_to_site, element_to_space, then project_id.
    let spatial = split_sections(&sections[4]);
    let batch = read_section(&spatial[1]);

    let element_ids = batch
        .column_by_name("element_id")
        .expect("element_id column")
        .as_any()
        .downcast_ref::<arrow::array::UInt32Array>()
        .expect("u32 column");
    let spatial_ids = batch
        .column_by_name("spatial_id")
        .expect("spatial_id column")
        .as_any()
        .downcast_ref::<arrow::array::UInt32Array>()
        .expect("u32 column");

    assert_eq!(element_ids.value(0), 42, "element_id must carry the element");
    assert_eq!(spatial_ids.value(0), 7, "spatial_id must carry the storey");
}
