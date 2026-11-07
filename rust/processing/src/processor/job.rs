// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! One geometry job and the metadata phase that fills it in.
//!
//! The scan schedules an [`EntityJob`] per product with only its type default
//! colour. Before a chunk is meshed, [`EntityJob::set_identity`] reads the
//! GlobalId, Name and `IfcProductDefinitionShape` reference, and
//! [`AppearanceResolver::resolve`] turns that reference into the element colour
//! and presentation layer. The native pass runs the first step under
//! `par_iter_mut` and the second serially; the wasm32 build runs both serially.
//! Each step has one body, whichever scheduler calls it.

use crate::style::GeometryStyleInfo;
use ifc_lite_core::{DecodedEntity, IfcType};
use rustc_hash::FxHashMap;
use std::collections::BTreeMap;

use super::color_layer::{
    resolve_element_color_for_product_definition_shape,
    resolve_presentation_layer_for_product_definition_shape,
};

/// Job for processing a single entity.
pub(super) struct EntityJob {
    pub(super) id: u32,
    pub(super) ifc_type: IfcType,
    pub(super) start: usize,
    pub(super) end: usize,
    pub(super) product_definition_shape_id: Option<u32>,
    pub(super) element_color: [f32; 4],
    pub(super) global_id: Option<String>,
    pub(super) name: Option<String>,
    pub(super) presentation_layer: Option<String>,
    pub(super) space_zone_properties: Option<BTreeMap<String, String>>,
    /// Set for synthetic type-only-geometry jobs (#957): the `IfcRepresentationMap`
    /// id to render directly (baking its MappingOrigin) instead of walking the
    /// element's `IfcProductDefinitionShape`. `None` for ordinary product jobs.
    pub(super) representation_map_id: Option<u32>,
}

impl EntityJob {
    /// Whether the identity step still has to run for this job.
    pub(super) fn needs_identity(&self) -> bool {
        self.global_id.is_none()
            && self.name.is_none()
            && self.product_definition_shape_id.is_none()
    }

    /// Identity step: GlobalId, Name and the `IfcProductDefinitionShape` reference
    /// of the decoded product record.
    pub(super) fn set_identity(&mut self, entity: &DecodedEntity) {
        self.global_id = normalize_optional_string(entity.get_string(0));
        self.name = normalize_optional_string(entity.get_string(2));
        self.product_definition_shape_id = entity.get_ref(6);
    }
}

pub(super) fn normalize_optional_string(raw: Option<&str>) -> Option<String> {
    ifc_lite_core::optional_text(raw).map(str::to_owned)
}

/// Scheduling weight for `fast_first_batch`: cheap, high-yield classes first.
pub(super) fn geometry_priority_score(ifc_type: &IfcType) -> u8 {
    match ifc_type {
        IfcType::IfcWall | IfcType::IfcWallStandardCase => 100,
        IfcType::IfcSlab => 95,
        IfcType::IfcColumn => 90,
        IfcType::IfcBeam => 85,
        IfcType::IfcRoof => 80,
        IfcType::IfcStair | IfcType::IfcStairFlight => 75,
        IfcType::IfcCurtainWall => 70,
        IfcType::IfcFooting | IfcType::IfcPile => 65,
        IfcType::IfcDoor | IfcType::IfcWindow => 30,
        IfcType::IfcFurnishingElement => 10,
        _ => 50,
    }
}

/// Appearance step: the element colour and presentation layer behind a job's
/// `IfcProductDefinitionShape`, with the per-shape caches that make the second
/// and later elements of a shared shape a lookup.
pub(super) struct AppearanceResolver {
    /// Material-chain fallback colour per element (#407).
    pub(super) element_material_color: FxHashMap<u32, [f32; 4]>,
    pub(super) layer_by_assigned_representation: FxHashMap<u32, String>,
    pub(super) include_presentation_layers: bool,
    color_by_shape: FxHashMap<u32, Option<[f32; 4]>>,
    layer_by_shape: FxHashMap<u32, Option<String>>,
    layer_by_representation: FxHashMap<u32, Option<String>>,
}

impl AppearanceResolver {
    pub(super) fn new(
        element_material_color: FxHashMap<u32, [f32; 4]>,
        layer_by_assigned_representation: FxHashMap<u32, String>,
        include_presentation_layers: bool,
    ) -> Self {
        Self {
            element_material_color,
            layer_by_assigned_representation,
            include_presentation_layers,
            color_by_shape: FxHashMap::default(),
            layer_by_shape: FxHashMap::default(),
            layer_by_representation: FxHashMap::default(),
        }
    }

    /// Fill in `job`'s colour and layer. `styles` is the style index in force
    /// for this chunk: the deferred replay swaps it after the first batch, and
    /// the per-shape caches deliberately keep what earlier chunks resolved.
    pub(super) fn resolve(
        &mut self,
        job: &mut EntityJob,
        styles: &FxHashMap<u32, GeometryStyleInfo>,
        decoder: &mut ifc_lite_core::EntityDecoder,
    ) {
        let Some(shape_id) = job.product_definition_shape_id else {
            return;
        };
        let resolved_color = self.color_by_shape.entry(shape_id).or_insert_with(|| {
            resolve_element_color_for_product_definition_shape(shape_id, styles, decoder)
        });
        if let Some(color) = resolved_color {
            job.element_color = *color;
        } else if let Some(color) = self.element_material_color.get(&job.id) {
            // No direct/indexed geometry style: inherit the material appearance (#407).
            job.element_color = *color;
        }
        if self.include_presentation_layers {
            let assigned = &self.layer_by_assigned_representation;
            let by_representation = &mut self.layer_by_representation;
            let resolved_layer = self.layer_by_shape.entry(shape_id).or_insert_with(|| {
                resolve_presentation_layer_for_product_definition_shape(
                    shape_id,
                    assigned,
                    by_representation,
                    decoder,
                )
            });
            job.presentation_layer = resolved_layer.clone();
        }
    }
}

#[cfg(test)]
#[path = "job_appearance_tests.rs"]
mod tests;
