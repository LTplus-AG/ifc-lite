// SPDX-License-Identifier: MPL-2.0
//! Synchronous production strategy planning: which strategy an element starts
//! with, decided once before any representation is executed. This is not an
//! owned authored DAG; the router still resolves representation constructions.
use super::*;
use ifc_lite_core::slot;

/// The first meshing strategy of a product job. Both keep per-item colours;
/// they differ only in whether the host's openings are cut.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PrimaryStrategy {
    /// Has a subtracting opening: submesh-aware void cut, so per-part colours
    /// survive the subtraction (a voided window keeps its frame/glass split).
    VoidedSubmeshes,
    /// No opening: the textured submesh path for ALL types.
    TexturedSubmeshes,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum PlanKind<'a> {
    /// Null representation on anything but an `IfcAlignment`: nothing renders.
    NoRepresentation,
    /// #957 type geometry: the caller-planned RepresentationMaps, borrowed.
    TypeMaps(&'a [(u32, u8)]),
    Product {
        primary: PrimaryStrategy,
        /// geometry_class of the per-layer slices ([`GEOM_CLASS_LAYER_SLICE`])
        /// when the product is a material-layer wall, else 0.
        layer_class: u8,
    },
}

#[derive(Debug, PartialEq)]
pub(super) struct ElementPlan<'a> {
    pub kind: PlanKind<'a>,
    /// Caller colour, else the type default. Unused for `NoRepresentation`.
    pub element_color: [f32; 4],
}

pub(super) fn plan_element<'a>(
    job: &'a ElementMeshJob<'_>,
    ctx: &MeshProductionContext<'_>,
    decoder: &mut EntityDecoder,
    router: &GeometryRouter,
) -> ElementPlan<'a> {
    // Representation gate, with the IfcAlignment exception: alignments carry
    // their geometry on IfcAlignment*Segment children, so a null
    // Representation attribute does not mean "nothing to render". Both
    // attributes occupy slot 6, but their EXPRESS names differ.
    let representation = match job.kind {
        ElementJobKind::Product => job.entity.attr(slot::IfcProduct::REPRESENTATION),
        ElementJobKind::TypeProduct { .. } => {
            job.entity.attr(slot::IfcTypeProduct::REPRESENTATION_MAPS)
        }
    };
    if representation.is_none_or(|value| value.is_null()) && job.ifc_type != IfcType::IfcAlignment {
        return ElementPlan {
            kind: PlanKind::NoRepresentation,
            element_color: [0.0; 4],
        };
    }
    let element_color = job
        .element_color
        .unwrap_or_else(|| crate::style::default_color_for_type(job.ifc_type.clone()).to_array());
    let kind = match &job.kind {
        // Type-product geometry never rides the don't-bake path: it is
        // view-mode-gated by geometry_class, not instanced.
        ElementJobKind::TypeProduct { rep_maps } => PlanKind::TypeMaps(rep_maps),
        ElementJobKind::Product => {
            let has_openings = ctx.void_index.get(&job.id).is_some_and(|openings| {
                openings
                    .iter()
                    .any(|&id| router.opening_requires_subtraction(id, decoder))
            });
            let primary = if has_openings {
                PrimaryStrategy::VoidedSubmeshes
            } else {
                PrimaryStrategy::TexturedSubmeshes
            };
            // Material-layer wall: tag its per-layer slices GEOM_CLASS_LAYER_SLICE
            // so the 2D/section cut can split the cut into per-layer fills (one
            // sub-mesh = one layer = one colour). Since #1311 the slices are OPEN
            // bands whose union is the wall's watertight outer skin, drawn
            // DOUBLE-SIDED like all other IFC geometry (IFC winding is not
            // reliably outward); the tag is purely the per-layer-fill marker.
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
