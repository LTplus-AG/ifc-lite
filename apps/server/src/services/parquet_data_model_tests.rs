// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use crate::services::data_model::DataModel;
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
