// SPDX-License-Identifier: MPL-2.0
//! Synchronous production strategy planning. This is not an owned authored DAG:
//! geometry execution still resolves representation constructions in the router.
use super::*;
use ifc_lite_core::slot;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PrimaryStrategy {
    VoidedSubmeshes,
    TexturedSubmeshes,
}

pub(super) enum PlanKind {
    NoRepresentation,
    TypeMaps(Vec<(u32, u8)>),
    Product {
        primary: PrimaryStrategy,
        layer_class: u8,
    },
}

pub(super) struct ElementPlan {
    pub kind: PlanKind,
    pub element_color: [f32; 4],
}

pub(super) fn plan_element(
    job: &ElementMeshJob<'_>,
    ctx: &MeshProductionContext<'_>,
    decoder: &mut EntityDecoder,
    router: &GeometryRouter,
) -> ElementPlan {
    // Both attributes currently occupy slot 6, but their EXPRESS names differ.
    let representation = match job.kind {
        ElementJobKind::Product => job.entity.attr(slot::IfcProduct::REPRESENTATION),
        ElementJobKind::TypeProduct { .. } => {
            job.entity.attr(slot::IfcTypeProduct::REPRESENTATION_MAPS)
        }
    };
    if representation.is_none_or(|value| value.is_null())
        && job.ifc_type != IfcType::IfcAlignment
    {
        return ElementPlan {
            kind: PlanKind::NoRepresentation,
            element_color: [0.0; 4],
        };
    }
    let element_color = job
        .element_color
        .unwrap_or_else(|| crate::style::default_color_for_type(job.ifc_type.clone()).to_array());
    let kind = match &job.kind {
        ElementJobKind::TypeProduct { rep_maps } => PlanKind::TypeMaps(rep_maps.clone()),
        ElementJobKind::Product => {
            let has_openings = ctx.void_index.get(&job.id).is_some_and(|ids| {
                ids.iter()
                    .any(|&id| router.opening_requires_subtraction(id, decoder))
            });
            let primary = if has_openings {
                PrimaryStrategy::VoidedSubmeshes
            } else {
                PrimaryStrategy::TexturedSubmeshes
            };
            let layer_class = if router.is_material_layer_sliceable(job.id) {
                GEOM_CLASS_LAYER_SLICE
            } else {
                0
            };
            PlanKind::Product {
                primary,
                layer_class,
            }
        }
    };
    ElementPlan {
        kind,
        element_color,
    }
}

/// The single home of the #957 orphan/instanced RepresentationMap decision.
///
/// A map referenced by an `IfcMappedItem` always draws through its occurrence
/// — emitting it again would double-render at the MappingOrigin (the
/// AC20/ArchiCAD duplicate-boxes regression), so referenced maps are filtered
/// in every mode. What remains is classified by whether the type has an
/// occurrence (`IfcRelDefinesByType`): orphans are class 1 (part of the
/// model — nothing else renders them), instanced types are class 2 (the
/// type-library shape) and only emitted in [`TypeGeometryMode::EmitTagged`].
pub fn plan_type_geometry(
    rep_map_ids: &[u32],
    referenced_representation_maps: &FxHashSet<u32>,
    type_is_instantiated: bool,
    mode: TypeGeometryMode,
) -> Vec<(u32, u8)> {
    if mode == TypeGeometryMode::SuppressInstanced && type_is_instantiated {
        return Vec::new();
    }
    let class: u8 = if type_is_instantiated { 2 } else { 1 };
    rep_map_ids
        .iter()
        .filter(|rm| !referenced_representation_maps.contains(rm))
        .map(|rm| (*rm, class))
        .collect()
}
