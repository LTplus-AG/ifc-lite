// SPDX-License-Identifier: MPL-2.0
//! Entry points for the shared row stream, with optional property classes.
use super::{EntityRow, Inherited, ModelOptions};
use crate::data_model::property::PropertyKind;
use crate::prepass::UnitScales;
use ifc_lite_core::{DecodedEntity, EntityIndex};
use std::sync::Arc;

/// [`super::stream_export_model_with_index`], plus the decoded entity behind each row
/// and whatever [`ModelOptions`] asked to resolve.
///
/// The second callback argument is the `DecodedEntity` the row was built from,
/// **borrowed**: a caller that wants an attribute this crate does not surface
/// reads it here, without this crate having to guess which attributes matter
/// and without anything being retained. It is `None` for the type-product rows emitted in
/// pass 3, which are assembled from the pass-1 scan and have no occurrence
/// entity behind them.
///
/// Storing the attributes on [`EntityRow`] instead would be the obvious shape
/// and is the wrong one twice over: `AttributeValue` is not `PartialEq`, so it
/// would break the derive that `stream == build` equality rests on, and
/// [`super::build_export_model`] collects, so every product's attribute vector would
/// stay resident — which is the exact bound this function exists to keep.
pub fn stream_export_model_with_options(
    content: &[u8],
    entity_index: &Arc<EntityIndex>,
    opts: &ModelOptions,
    mut f: impl FnMut(EntityRow, Option<&DecodedEntity>),
) -> UnitScales {
    stream_export_model_with_inherited(content, entity_index, opts, |row, _, entity| f(row, entity))
}

/// [`stream_export_model_with_options`], plus which of each row's property and
/// quantity entries the entity inherits from its type.
///
/// The [`Inherited`] passed beside each row reports nothing unless
/// [`ModelOptions::inherit_type_properties`] is on. It is a separate argument
/// rather than a field on `PropValue` and `QuantityValue` so those types keep
/// their published shape.
pub fn stream_export_model_with_inherited(
    content: &[u8],
    entity_index: &Arc<EntityIndex>,
    opts: &ModelOptions,
    mut f: impl FnMut(EntityRow, Inherited, Option<&DecodedEntity>),
) -> UnitScales {
    super::stream_rows(content, entity_index, opts, false, |row, inherited, entity, _| f(row, inherited, entity))
}

/// Stream the default export rows with the canonical IFC kind of each property.
///
/// `kinds[set_index][property_index]` corresponds exactly to the emitted
/// `EntityRow::property_sets`, including skipped values and orphan type products.
/// The classes come from the same decode and budget as the values; no references
/// are walked a second time. Type-property inheritance is disabled, as it is in
/// [`super::stream_export_model`]. Existing public row structs remain unchanged.
pub fn stream_export_model_with_property_kinds(
    content: &[u8], mut f: impl FnMut(EntityRow, &[Vec<PropertyKind>]),
) -> UnitScales {
    let index = Arc::new(crate::build_entity_index_parallel(content));
    super::stream_rows(content, &index, &ModelOptions::default(), true, |row, _, _, kinds| f(row, kinds))
}
