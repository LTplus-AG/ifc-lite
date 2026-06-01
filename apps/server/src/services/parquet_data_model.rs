// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Parquet serialization for IFC data model (entities, properties, relationships, spatial hierarchy).

use crate::services::data_model::{
    ClassificationAssociation, DataModel, DocumentAssociation, EntityMetadata, MaterialAssociation,
    PropertySet, QuantitySet, Relationship, SpatialHierarchyData, SpatialNode,
};
use arrow::array::builder::ListBuilder;
use arrow::array::UInt32Builder;
use arrow::array::{BooleanArray, Float64Array, StringArray, UInt16Array, UInt32Array};
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use parquet::arrow::ArrowWriter;
use parquet::basic::Compression;
use parquet::file::properties::WriterProperties;
use rayon::prelude::*;
use std::io::Cursor;
use std::sync::Arc;
use thiserror::Error;

/// Errors during data model Parquet serialization.
#[derive(Debug, Error)]
pub enum DataModelParquetError {
    #[error("Arrow error: {0}")]
    Arrow(#[from] arrow::error::ArrowError),
    #[error("Parquet error: {0}")]
    Parquet(#[from] parquet::errors::ParquetError),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

/// Serialize data model to Parquet format.
///
/// Creates 5 Parquet tables:
/// 1. Entities (entity_id, type_name, global_id, name, has_geometry)
/// 2. Properties (pset_id, pset_name, property_name, property_value, property_type)
/// 3. Quantities (qset_id, qset_name, method_of_measurement, quantity_name, quantity_value, quantity_type)
/// 4. Relationships (rel_type, relating_id, related_id)
/// 5. Spatial (entity_id, parent_id, level, path, type_name, name, elevation, children_ids, element_ids)
///    Plus lookup tables: element_to_storey, element_to_building, element_to_site, element_to_space
pub fn serialize_data_model_to_parquet(
    data_model: &DataModel,
) -> Result<Vec<u8>, DataModelParquetError> {
    // Serialize all tables in parallel using rayon
    let (entities_data, ((properties_data, quantities_data), (relationships_data, spatial_data))) =
        rayon::join(
            || serialize_entities_table(&data_model.entities),
            || {
                rayon::join(
                    || {
                        rayon::join(
                            || serialize_properties_table(&data_model.property_sets),
                            || serialize_quantities_table(&data_model.quantity_sets),
                        )
                    },
                    || {
                        rayon::join(
                            || serialize_relationships_table(&data_model.relationships),
                            || serialize_spatial_hierarchy(&data_model.spatial_hierarchy),
                        )
                    },
                )
            },
        );

    let entities_data = entities_data?;
    let properties_data = properties_data?;
    let quantities_data = quantities_data?;
    let relationships_data = relationships_data?;
    let spatial_data = spatial_data?;

    // Classification / material / document tables (issue #900). Appended after
    // the original five so older decoders that stop at `spatial` simply ignore
    // the trailing bytes — the format stays backward compatible.
    let ((classifications_data, materials_data), documents_data) = rayon::join(
        || {
            rayon::join(
                || serialize_classifications_table(&data_model.classifications),
                || serialize_materials_table(&data_model.materials),
            )
        },
        || serialize_documents_table(&data_model.documents),
    );
    let classifications_data = classifications_data?;
    let materials_data = materials_data?;
    let documents_data = documents_data?;

    // Write format: [entities_len][entities_data][properties_len][properties_data][quantities_len][quantities_data][relationships_len][relationships_data][spatial_len][spatial_data][classifications_len][...][materials_len][...][documents_len][...]
    let mut result = Vec::new();
    result.extend_from_slice(&(entities_data.len() as u32).to_le_bytes());
    result.extend_from_slice(&entities_data);
    result.extend_from_slice(&(properties_data.len() as u32).to_le_bytes());
    result.extend_from_slice(&properties_data);
    result.extend_from_slice(&(quantities_data.len() as u32).to_le_bytes());
    result.extend_from_slice(&quantities_data);
    result.extend_from_slice(&(relationships_data.len() as u32).to_le_bytes());
    result.extend_from_slice(&relationships_data);
    result.extend_from_slice(&(spatial_data.len() as u32).to_le_bytes());
    result.extend_from_slice(&spatial_data);
    result.extend_from_slice(&(classifications_data.len() as u32).to_le_bytes());
    result.extend_from_slice(&classifications_data);
    result.extend_from_slice(&(materials_data.len() as u32).to_le_bytes());
    result.extend_from_slice(&materials_data);
    result.extend_from_slice(&(documents_data.len() as u32).to_le_bytes());
    result.extend_from_slice(&documents_data);

    Ok(result)
}

/// Serialize classification associations table.
fn serialize_classifications_table(
    rows: &[ClassificationAssociation],
) -> Result<Vec<u8>, DataModelParquetError> {
    let count = rows.len();
    let mut element_ids = Vec::with_capacity(count);
    let mut system_names: Vec<Option<String>> = Vec::with_capacity(count);
    let mut identifications: Vec<Option<String>> = Vec::with_capacity(count);
    let mut names: Vec<Option<String>> = Vec::with_capacity(count);
    let mut locations: Vec<Option<String>> = Vec::with_capacity(count);

    for row in rows {
        element_ids.push(row.element_id);
        system_names.push(row.system_name.clone());
        identifications.push(row.identification.clone());
        names.push(row.name.clone());
        locations.push(row.location.clone());
    }

    let schema = Schema::new(vec![
        Field::new("element_id", DataType::UInt32, false),
        Field::new("system_name", DataType::Utf8, true),
        Field::new("identification", DataType::Utf8, true),
        Field::new("name", DataType::Utf8, true),
        Field::new("location", DataType::Utf8, true),
    ]);

    let batch = RecordBatch::try_new(
        Arc::new(schema),
        vec![
            Arc::new(UInt32Array::from(element_ids)),
            Arc::new(StringArray::from(system_names)),
            Arc::new(StringArray::from(identifications)),
            Arc::new(StringArray::from(names)),
            Arc::new(StringArray::from(locations)),
        ],
    )?;

    write_parquet_batch(batch)
}

/// Serialize material associations table.
fn serialize_materials_table(
    rows: &[MaterialAssociation],
) -> Result<Vec<u8>, DataModelParquetError> {
    let count = rows.len();
    let mut element_ids = Vec::with_capacity(count);
    let mut set_names: Vec<Option<String>> = Vec::with_capacity(count);
    let mut layer_indices = Vec::with_capacity(count);
    let mut material_names = Vec::with_capacity(count);
    let mut thicknesses: Vec<Option<f64>> = Vec::with_capacity(count);
    let mut ventilated: Vec<Option<bool>> = Vec::with_capacity(count);
    let mut categories: Vec<Option<String>> = Vec::with_capacity(count);

    for row in rows {
        element_ids.push(row.element_id);
        set_names.push(row.set_name.clone());
        layer_indices.push(row.layer_index);
        material_names.push(row.material_name.clone());
        thicknesses.push(row.thickness);
        ventilated.push(row.is_ventilated);
        categories.push(row.category.clone());
    }

    let schema = Schema::new(vec![
        Field::new("element_id", DataType::UInt32, false),
        Field::new("set_name", DataType::Utf8, true),
        Field::new("layer_index", DataType::UInt32, false),
        Field::new("material_name", DataType::Utf8, false),
        Field::new("thickness", DataType::Float64, true),
        Field::new("is_ventilated", DataType::Boolean, true),
        Field::new("category", DataType::Utf8, true),
    ]);

    let batch = RecordBatch::try_new(
        Arc::new(schema),
        vec![
            Arc::new(UInt32Array::from(element_ids)),
            Arc::new(StringArray::from(set_names)),
            Arc::new(UInt32Array::from(layer_indices)),
            Arc::new(StringArray::from(material_names)),
            Arc::new(Float64Array::from(thicknesses)),
            Arc::new(BooleanArray::from(ventilated)),
            Arc::new(StringArray::from(categories)),
        ],
    )?;

    write_parquet_batch(batch)
}

/// Serialize document associations table.
fn serialize_documents_table(
    rows: &[DocumentAssociation],
) -> Result<Vec<u8>, DataModelParquetError> {
    let count = rows.len();
    let mut element_ids = Vec::with_capacity(count);
    let mut identifications: Vec<Option<String>> = Vec::with_capacity(count);
    let mut names: Vec<Option<String>> = Vec::with_capacity(count);
    let mut locations: Vec<Option<String>> = Vec::with_capacity(count);
    let mut descriptions: Vec<Option<String>> = Vec::with_capacity(count);

    for row in rows {
        element_ids.push(row.element_id);
        identifications.push(row.identification.clone());
        names.push(row.name.clone());
        locations.push(row.location.clone());
        descriptions.push(row.description.clone());
    }

    let schema = Schema::new(vec![
        Field::new("element_id", DataType::UInt32, false),
        Field::new("identification", DataType::Utf8, true),
        Field::new("name", DataType::Utf8, true),
        Field::new("location", DataType::Utf8, true),
        Field::new("description", DataType::Utf8, true),
    ]);

    let batch = RecordBatch::try_new(
        Arc::new(schema),
        vec![
            Arc::new(UInt32Array::from(element_ids)),
            Arc::new(StringArray::from(identifications)),
            Arc::new(StringArray::from(names)),
            Arc::new(StringArray::from(locations)),
            Arc::new(StringArray::from(descriptions)),
        ],
    )?;

    write_parquet_batch(batch)
}

/// Serialize entities table.
fn serialize_entities_table(entities: &[EntityMetadata]) -> Result<Vec<u8>, DataModelParquetError> {
    let count = entities.len();

    // Build arrays in parallel using rayon
    let results: Vec<(u32, String, String, String, bool)> = entities
        .par_iter()
        .map(|entity| {
            (
                entity.entity_id,
                entity.type_name.clone(),
                entity.global_id.clone().unwrap_or_default(),
                entity.name.clone().unwrap_or_default(),
                entity.has_geometry,
            )
        })
        .collect();

    // Split into separate vectors
    let mut entity_ids = Vec::with_capacity(count);
    let mut type_names = Vec::with_capacity(count);
    let mut global_ids = Vec::with_capacity(count);
    let mut names = Vec::with_capacity(count);
    let mut has_geometry = Vec::with_capacity(count);

    for (id, type_name, global_id, name, has_geom) in results {
        entity_ids.push(id);
        type_names.push(type_name);
        global_ids.push(global_id);
        names.push(name);
        has_geometry.push(has_geom);
    }

    let schema = Schema::new(vec![
        Field::new("entity_id", DataType::UInt32, false),
        Field::new("type_name", DataType::Utf8, false),
        Field::new("global_id", DataType::Utf8, true),
        Field::new("name", DataType::Utf8, true),
        Field::new("has_geometry", DataType::Boolean, false),
    ]);

    let batch = RecordBatch::try_new(
        Arc::new(schema),
        vec![
            Arc::new(UInt32Array::from(entity_ids)),
            Arc::new(StringArray::from(type_names)),
            Arc::new(StringArray::from(global_ids)),
            Arc::new(StringArray::from(names)),
            Arc::new(BooleanArray::from(has_geometry)),
        ],
    )?;

    write_parquet_batch(batch)
}

/// Serialize properties table.
fn serialize_properties_table(
    property_sets: &[PropertySet],
) -> Result<Vec<u8>, DataModelParquetError> {
    // Flatten property sets into rows using parallel iteration
    let rows: Vec<(u32, String, String, String, String)> = property_sets
        .par_iter()
        .flat_map_iter(|pset| {
            pset.properties.iter().map(move |prop| {
                (
                    pset.pset_id,
                    pset.pset_name.clone(),
                    prop.property_name.clone(),
                    prop.property_value.clone(),
                    prop.property_type.clone(),
                )
            })
        })
        .collect();

    // Split into separate vectors
    let mut pset_ids = Vec::with_capacity(rows.len());
    let mut pset_names = Vec::with_capacity(rows.len());
    let mut property_names = Vec::with_capacity(rows.len());
    let mut property_values = Vec::with_capacity(rows.len());
    let mut property_types = Vec::with_capacity(rows.len());

    for (pset_id, pset_name, prop_name, prop_value, prop_type) in rows {
        pset_ids.push(pset_id);
        pset_names.push(pset_name);
        property_names.push(prop_name);
        property_values.push(prop_value);
        property_types.push(prop_type);
    }

    let schema = Schema::new(vec![
        Field::new("pset_id", DataType::UInt32, false),
        Field::new("pset_name", DataType::Utf8, false),
        Field::new("property_name", DataType::Utf8, false),
        Field::new("property_value", DataType::Utf8, false),
        Field::new("property_type", DataType::Utf8, false),
    ]);

    let batch = RecordBatch::try_new(
        Arc::new(schema),
        vec![
            Arc::new(UInt32Array::from(pset_ids)),
            Arc::new(StringArray::from(pset_names)),
            Arc::new(StringArray::from(property_names)),
            Arc::new(StringArray::from(property_values)),
            Arc::new(StringArray::from(property_types)),
        ],
    )?;

    write_parquet_batch(batch)
}

/// Serialize quantities table.
fn serialize_quantities_table(
    quantity_sets: &[QuantitySet],
) -> Result<Vec<u8>, DataModelParquetError> {
    use arrow::array::Float64Array;

    // Flatten quantity sets into rows using parallel iteration
    let rows: Vec<(u32, String, String, String, f64, String)> = quantity_sets
        .par_iter()
        .flat_map_iter(|qset| {
            qset.quantities.iter().map(move |quant| {
                (
                    qset.qset_id,
                    qset.qset_name.clone(),
                    qset.method_of_measurement.clone().unwrap_or_default(),
                    quant.quantity_name.clone(),
                    quant.quantity_value,
                    quant.quantity_type.clone(),
                )
            })
        })
        .collect();

    // Split into separate vectors
    let mut qset_ids = Vec::with_capacity(rows.len());
    let mut qset_names = Vec::with_capacity(rows.len());
    let mut methods = Vec::with_capacity(rows.len());
    let mut quantity_names = Vec::with_capacity(rows.len());
    let mut quantity_values = Vec::with_capacity(rows.len());
    let mut quantity_types = Vec::with_capacity(rows.len());

    for (qset_id, qset_name, method, quant_name, quant_value, quant_type) in rows {
        qset_ids.push(qset_id);
        qset_names.push(qset_name);
        methods.push(method);
        quantity_names.push(quant_name);
        quantity_values.push(quant_value);
        quantity_types.push(quant_type);
    }

    let schema = Schema::new(vec![
        Field::new("qset_id", DataType::UInt32, false),
        Field::new("qset_name", DataType::Utf8, false),
        Field::new("method_of_measurement", DataType::Utf8, true),
        Field::new("quantity_name", DataType::Utf8, false),
        Field::new("quantity_value", DataType::Float64, false),
        Field::new("quantity_type", DataType::Utf8, false),
    ]);

    let batch = RecordBatch::try_new(
        Arc::new(schema),
        vec![
            Arc::new(UInt32Array::from(qset_ids)),
            Arc::new(StringArray::from(qset_names)),
            Arc::new(StringArray::from(methods)),
            Arc::new(StringArray::from(quantity_names)),
            Arc::new(Float64Array::from(quantity_values)),
            Arc::new(StringArray::from(quantity_types)),
        ],
    )?;

    write_parquet_batch(batch)
}

/// Serialize relationships table.
fn serialize_relationships_table(
    relationships: &[Relationship],
) -> Result<Vec<u8>, DataModelParquetError> {
    let count = relationships.len();

    // Build arrays in parallel
    let results: Vec<(String, u32, u32)> = relationships
        .par_iter()
        .map(|rel| (rel.rel_type.clone(), rel.relating_id, rel.related_id))
        .collect();

    let mut rel_types = Vec::with_capacity(count);
    let mut relating_ids = Vec::with_capacity(count);
    let mut related_ids = Vec::with_capacity(count);

    for (rel_type, relating_id, related_id) in results {
        rel_types.push(rel_type);
        relating_ids.push(relating_id);
        related_ids.push(related_id);
    }

    let schema = Schema::new(vec![
        Field::new("rel_type", DataType::Utf8, false),
        Field::new("relating_id", DataType::UInt32, false),
        Field::new("related_id", DataType::UInt32, false),
    ]);

    let batch = RecordBatch::try_new(
        Arc::new(schema),
        vec![
            Arc::new(StringArray::from(rel_types)),
            Arc::new(UInt32Array::from(relating_ids)),
            Arc::new(UInt32Array::from(related_ids)),
        ],
    )?;

    write_parquet_batch(batch)
}

/// Serialize spatial hierarchy with nodes and lookup tables.
/// Returns combined binary: [nodes_len][nodes_data][element_to_storey_len][element_to_storey_data]...
fn serialize_spatial_hierarchy(
    hierarchy: &SpatialHierarchyData,
) -> Result<Vec<u8>, DataModelParquetError> {
    let mut result = Vec::new();

    // Serialize nodes table
    let nodes_data = serialize_spatial_nodes_table(&hierarchy.nodes)?;
    result.extend_from_slice(&(nodes_data.len() as u32).to_le_bytes());
    result.extend_from_slice(&nodes_data);

    // Serialize lookup tables
    let element_to_storey_data =
        serialize_lookup_table(&hierarchy.element_to_storey, "element_to_storey")?;
    result.extend_from_slice(&(element_to_storey_data.len() as u32).to_le_bytes());
    result.extend_from_slice(&element_to_storey_data);

    let element_to_building_data =
        serialize_lookup_table(&hierarchy.element_to_building, "element_to_building")?;
    result.extend_from_slice(&(element_to_building_data.len() as u32).to_le_bytes());
    result.extend_from_slice(&element_to_building_data);

    let element_to_site_data =
        serialize_lookup_table(&hierarchy.element_to_site, "element_to_site")?;
    result.extend_from_slice(&(element_to_site_data.len() as u32).to_le_bytes());
    result.extend_from_slice(&element_to_site_data);

    let element_to_space_data =
        serialize_lookup_table(&hierarchy.element_to_space, "element_to_space")?;
    result.extend_from_slice(&(element_to_space_data.len() as u32).to_le_bytes());
    result.extend_from_slice(&element_to_space_data);

    // Add project_id as final u32
    result.extend_from_slice(&hierarchy.project_id.to_le_bytes());

    Ok(result)
}

/// Serialize spatial nodes table with all fields.
fn serialize_spatial_nodes_table(
    spatial_nodes: &[SpatialNode],
) -> Result<Vec<u8>, DataModelParquetError> {
    use arrow::array::Float64Array;

    let count = spatial_nodes.len();
    let mut entity_ids = Vec::with_capacity(count);
    let mut parent_ids: Vec<Option<u32>> = Vec::with_capacity(count);
    let mut levels = Vec::with_capacity(count);
    let mut paths = Vec::with_capacity(count);
    let mut type_names = Vec::with_capacity(count);
    let mut names: Vec<Option<&str>> = Vec::with_capacity(count);
    let mut elevations: Vec<Option<f64>> = Vec::with_capacity(count);
    let mut children_ids_list = Vec::with_capacity(count);
    let mut element_ids_list = Vec::with_capacity(count);

    for node in spatial_nodes {
        entity_ids.push(node.entity_id);
        parent_ids.push(if node.parent_id == 0 {
            None
        } else {
            Some(node.parent_id)
        });
        levels.push(node.level);
        paths.push(node.path.as_str());
        type_names.push(node.type_name.as_str());
        names.push(node.name.as_deref());
        elevations.push(node.elevation);
        children_ids_list.push(node.children_ids.clone());
        element_ids_list.push(node.element_ids.clone());
    }

    // Build list arrays for children_ids and element_ids
    // Flatten all values and build offset array
    let mut children_values = Vec::new();
    let mut children_offsets = vec![0i32];
    let mut element_values = Vec::new();
    let mut element_offsets = vec![0i32];

    for children_ids in &children_ids_list {
        children_values.extend_from_slice(children_ids);
        children_offsets.push(children_values.len() as i32);
    }

    for element_ids in &element_ids_list {
        element_values.extend_from_slice(element_ids);
        element_offsets.push(element_values.len() as i32);
    }

    // Build ListArray using builder pattern
    let mut children_builder =
        ListBuilder::new(UInt32Builder::with_capacity(children_values.len()));
    for children_ids in &children_ids_list {
        children_builder.values().append_slice(children_ids);
        children_builder.append(true);
    }
    let children_list_array = children_builder.finish();

    let mut element_builder = ListBuilder::new(UInt32Builder::with_capacity(element_values.len()));
    for element_ids in &element_ids_list {
        element_builder.values().append_slice(element_ids);
        element_builder.append(true);
    }
    let element_list_array = element_builder.finish();

    // Schema must match what ListBuilder produces - inner items are nullable by default
    let schema = Schema::new(vec![
        Field::new("entity_id", DataType::UInt32, false),
        Field::new("parent_id", DataType::UInt32, true), // Nullable
        Field::new("level", DataType::UInt16, false),
        Field::new("path", DataType::Utf8, false),
        Field::new("type_name", DataType::Utf8, false),
        Field::new("name", DataType::Utf8, true), // Nullable
        Field::new("elevation", DataType::Float64, true), // Nullable
        Field::new(
            "children_ids",
            DataType::new_list(DataType::UInt32, true),
            false,
        ), // Inner items nullable
        Field::new(
            "element_ids",
            DataType::new_list(DataType::UInt32, true),
            false,
        ), // Inner items nullable
    ]);

    let batch = RecordBatch::try_new(
        Arc::new(schema),
        vec![
            Arc::new(UInt32Array::from(entity_ids)),
            Arc::new(UInt32Array::from(parent_ids)),
            Arc::new(UInt16Array::from(levels)),
            Arc::new(StringArray::from(paths)),
            Arc::new(StringArray::from(type_names)),
            Arc::new(StringArray::from(names)),
            Arc::new(Float64Array::from(elevations)),
            Arc::new(children_list_array),
            Arc::new(element_list_array),
        ],
    )?;

    write_parquet_batch(batch)
}

/// Serialize a lookup table (element_id -> spatial_id pairs).
fn serialize_lookup_table(
    pairs: &[(u32, u32)],
    _table_name: &str,
) -> Result<Vec<u8>, DataModelParquetError> {
    let count = pairs.len();
    let mut element_ids = Vec::with_capacity(count);
    let mut spatial_ids = Vec::with_capacity(count);

    for (element_id, spatial_id) in pairs {
        element_ids.push(*element_id);
        spatial_ids.push(*spatial_id);
    }

    let schema = Schema::new(vec![
        Field::new("element_id", DataType::UInt32, false),
        Field::new("spatial_id", DataType::UInt32, false),
    ]);

    let batch = RecordBatch::try_new(
        Arc::new(schema),
        vec![
            Arc::new(UInt32Array::from(element_ids)),
            Arc::new(UInt32Array::from(spatial_ids)),
        ],
    )?;

    write_parquet_batch(batch)
}

/// Write a RecordBatch to a Parquet buffer with Zstd compression.
fn write_parquet_batch(batch: RecordBatch) -> Result<Vec<u8>, DataModelParquetError> {
    let mut buffer = Vec::new();
    let cursor = Cursor::new(&mut buffer);

    let props = WriterProperties::builder()
        .set_compression(Compression::LZ4_RAW)
        .build();

    let mut writer = ArrowWriter::try_new(cursor, batch.schema(), Some(props))?;
    writer.write(&batch)?;
    writer.close()?;

    Ok(buffer)
}

#[cfg(test)]
mod tests {
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
}
