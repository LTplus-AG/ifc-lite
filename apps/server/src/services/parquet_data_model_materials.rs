// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::DataModelParquetError;
use crate::services::data_model::MaterialAssociation;
use arrow::array::{BooleanArray, Float64Array, StringArray, UInt32Array};
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use std::sync::Arc;

/// Serialize material associations table.
pub(super) fn serialize_materials_table(
    rows: &[MaterialAssociation],
) -> Result<Vec<u8>, DataModelParquetError> {
    let count = rows.len();
    let mut element_ids = Vec::with_capacity(count);
    let mut association_ids = Vec::with_capacity(count);
    let mut definition_ids = Vec::with_capacity(count);
    let mut member_counts = Vec::with_capacity(count);
    let mut kinds = Vec::with_capacity(count);
    let mut set_names: Vec<Option<String>> = Vec::with_capacity(count);
    let mut layer_indices = Vec::with_capacity(count);
    let mut material_names = Vec::with_capacity(count);
    let mut material_name_presence = Vec::with_capacity(count);
    let mut material_ids: Vec<Option<u32>> = Vec::with_capacity(count);
    let mut member_names: Vec<Option<String>> = Vec::with_capacity(count);
    let mut material_categories: Vec<Option<String>> = Vec::with_capacity(count);
    let mut fractions: Vec<Option<f64>> = Vec::with_capacity(count);
    let mut thicknesses: Vec<Option<f64>> = Vec::with_capacity(count);
    let mut ventilated: Vec<Option<bool>> = Vec::with_capacity(count);
    let mut categories: Vec<Option<String>> = Vec::with_capacity(count);

    for row in rows {
        element_ids.push(row.element_id);
        association_ids.push(row.association_id);
        definition_ids.push(row.definition_id);
        member_counts.push(row.member_count);
        kinds.push(row.kind.clone());
        set_names.push(row.set_name.clone());
        layer_indices.push(row.layer_index);
        material_names.push(row.material_name.clone());
        material_name_presence.push(row.material_name_present);
        material_ids.push(row.material_id);
        member_names.push(row.member_name.clone());
        material_categories.push(row.material_category.clone());
        fractions.push(row.fraction);
        thicknesses.push(row.thickness);
        ventilated.push(row.is_ventilated);
        categories.push(row.category.clone());
    }

    let schema = Schema::new(vec![
        Field::new("element_id", DataType::UInt32, false),
        Field::new("set_name", DataType::Utf8, true),
        Field::new("layer_index", DataType::UInt32, false),
        Field::new("material_name", DataType::Utf8, false),
        Field::new("material_name_present", DataType::Boolean, false),
        Field::new("material_id", DataType::UInt32, true),
        Field::new("thickness", DataType::Float64, true),
        Field::new("is_ventilated", DataType::Boolean, true),
        Field::new("category", DataType::Utf8, true),
        Field::new("association_id", DataType::UInt32, false),
        Field::new("definition_id", DataType::UInt32, false),
        Field::new("member_count", DataType::UInt32, false),
        Field::new("kind", DataType::Utf8, false),
        Field::new("member_name", DataType::Utf8, true),
        Field::new("material_category", DataType::Utf8, true),
        Field::new("fraction", DataType::Float64, true),
    ]);

    let batch = RecordBatch::try_new(
        Arc::new(schema),
        vec![
            Arc::new(UInt32Array::from(element_ids)),
            Arc::new(StringArray::from(set_names)),
            Arc::new(UInt32Array::from(layer_indices)),
            Arc::new(StringArray::from(material_names)),
            Arc::new(BooleanArray::from(material_name_presence)),
            Arc::new(UInt32Array::from(material_ids)),
            Arc::new(Float64Array::from(thicknesses)),
            Arc::new(BooleanArray::from(ventilated)),
            Arc::new(StringArray::from(categories)),
            Arc::new(UInt32Array::from(association_ids)),
            Arc::new(UInt32Array::from(definition_ids)),
            Arc::new(UInt32Array::from(member_counts)),
            Arc::new(StringArray::from(kinds)),
            Arc::new(StringArray::from(member_names)),
            Arc::new(StringArray::from(material_categories)),
            Arc::new(Float64Array::from(fractions)),
        ],
    )?;

    super::write_parquet_batch(batch)
}
