// SPDX-License-Identifier: MPL-2.0
//! Per-part colour resolution for M11-A. One precedence: exact's own resolver
//! (`presentation_source::color`, `resolve_color_for_representation_map`).
use crate::element::assembly_job::AssemblyJob;
use crate::element::element_color::{find_geometry_item_style_source, resolve_color_for_representation_map};
use crate::element::presentation_source::color;
use crate::element::session_retained::error::RetainedExecutionError as Error;
use crate::element::session_retained::publication::PartAppearance;
use crate::element::session_retained::refusal::{RefusalOrigin, RetainedProductRefusal};
use crate::element::MeshProductionContext;
use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::program::transactions::PresentationFacts;

/// What keys a part's colour. Band parts of a material-layer product (M4) are
/// keyed by material; no retained part is today, so that arm refuses. A part
/// without a binding is an unstyled frame part (`PlainParts`): exact colours it
/// with the element colour alone, and so does `Unbound`.
#[allow(dead_code)] // M4 band parts construct `Material`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum PartSource {
    Item(u32),
    Material(u32),
    Unbound,
}
impl PartSource {
    pub(super) fn of(facts: &PresentationFacts) -> Self {
        Self::Item(facts.geometry_id)
    }
}

/// A value's deciding binding, with the `IfcMappedItem` occurrences that enclose it.
pub(super) struct Bound {
    pub(super) source: PartSource,
    pub(super) fact: PresentationFacts,
    /// Style-source ids of the enclosing `IfcMappedItem` occurrences, inner to outer. They never decide the
    /// colour; they say which exact sub-mesh the part belongs to (one leaf under two occurrences is two).
    pub(super) occurrences: Vec<u32>,
}
impl Bound {
    fn unbound() -> Self {
        Self { source: PartSource::Unbound, fact: PresentationFacts::default(), occurrences: Vec::new() }
    }
}

/// The one binding a value is coloured by. The walk appends the item's own binding first, then one per
/// enclosing `IfcMappedItem` occurrence (`mapping_retained.rs`), and exact keys a styled sub-mesh by the
/// item the walk reached (`mapping_accept.rs` `Merging::Styled(item.item().id, ..)`), calling `color` once
/// per such leaf: so the LAST item binding decides (a Boolean result's own binding follows its host's), never
/// the occurrence. A type part is the exception: exact colours it through its representation map, so the
/// type completion decides. A texture or palette flag on ANY of the value's bindings is kept, so it refuses
/// whichever binding decides. A value with bindings but no item or type binding has no sub-mesh identity
/// in exact to match, and refuses.
pub(super) fn bind(facts: &[PresentationFacts]) -> Result<Bound, Error> {
    let Some(first) = facts.first() else { return Ok(Bound::unbound()) };
    let decider = facts.iter().rev().find(|fact| fact.type_product.is_some())
        .or_else(|| facts.iter().rev().find(|fact| fact.representation_map.is_none()))
        .ok_or_else(|| unsupported(first.geometry_id, "binding"))?;
    let fact = PresentationFacts {
        texture_pending: facts.iter().any(|fact| fact.texture_pending),
        indexed_palette_pending: facts.iter().any(|fact| fact.indexed_palette_pending),
        ..*decider
    };
    let occurrences = facts.iter().filter(|fact| fact.representation_map.is_some() && fact.type_product.is_none())
        .map(|fact| fact.style_source_id).collect();
    Ok(Bound { source: PartSource::of(&fact), fact, occurrences })
}

/// What one sub-mesh's first frame resolved to, reused by its later frames.
struct Shared {
    key: (PartSource, Vec<u32>),
    rgba: [f32; 4],
    material_name: Option<String>,
    style_id: Option<u32>,
}

/// One appearance per part, in part order. The material cursor spans the
/// product's parts as it spans exact's collection, and a class's fixed display
/// colour overrides the result as `session_run::apply_fixed_color` does.
pub(super) fn resolve_parts(
    job: &AssemblyJob<'_>,
    parts: &[Bound],
    element_color: [f32; 4],
    ctx: &MeshProductionContext<'_>,
    decoder: &mut EntityDecoder,
) -> Result<Vec<PartAppearance>, Error> {
    let materials = ctx.element_material_colors.get(&job.id).map(Vec::as_slice);
    let fixed = crate::style::fixed_display_color_for_type(job.ifc_type).map(|fixed| fixed.to_array());
    let mut next_material = 0;
    let mut resolved = Vec::with_capacity(parts.len());
    // Frames of one item under one occurrence chain are ONE sub-mesh in exact: one resolution, one cursor step.
    let mut last: Option<Shared> = None;
    for Bound { source, fact, occurrences } in parts {
        // Texture refusal relies on the walker's texture_pending flag: run_model does not populate
        // texture_index. Indexed palettes also have the snapshot map check under the same item id.
        if fact.texture_pending || ctx.texture_index.contains_key(&fact.geometry_id) {
            return Err(unsupported(fact.geometry_id, "texture_pending"));
        }
        if fact.indexed_palette_pending || ctx.indexed_colour_full.contains_key(&fact.geometry_id) {
            return Err(unsupported(fact.geometry_id, "indexed_palette_pending"));
        }
        let mut part = match (fact.type_product, source) {
            (Some((_, class)), _) => {
                let map = fact.representation_map.ok_or_else(|| unsupported(fact.geometry_id, "binding"))?;
                // `type_parts`: the map's style colour, else the type's own colour.
                let rgba = resolve_color_for_representation_map(map, ctx.geometry_style_index, decoder)
                    .unwrap_or(fact.fallback_color.unwrap_or(element_color));
                PartAppearance { rgba, geometry_class: class, style_id: None, material_name: None,
                    geometry_item_id: None, material_id: None }
            }
            (None, PartSource::Material(id)) => return Err(unsupported(*id, "material_band")),
            // `presentation_source::fallback`: the element colour, no item, no name.
            (None, PartSource::Unbound) => PartAppearance { rgba: element_color, geometry_class: 0, style_id: None,
                material_name: None, geometry_item_id: None, material_id: None },
            (None, PartSource::Item(id)) => {
                let shared = match last.take() {
                    Some(shared) if shared.key.0 == *source && shared.key.1 == *occurrences => shared,
                    _ => {
                        let (rgba, material_name) = color(job, *id, element_color, materials, &mut next_material, ctx, decoder, true);
                        let style_id = find_geometry_item_style_source(*id, &|id| ctx.geometry_style_index.contains_key(&id), decoder);
                        Shared { key: (*source, occurrences.clone()), rgba, material_name, style_id }
                    }
                };
                let part = PartAppearance { rgba: shared.rgba, geometry_class: 0, style_id: shared.style_id,
                    material_name: shared.material_name.clone(), geometry_item_id: Some(*id), material_id: None };
                last = Some(shared);
                part
            }
        };
        if let Some(fixed) = fixed {
            part.rgba = fixed;
        }
        resolved.push(part);
    }
    Ok(resolved)
}

pub(super) fn unsupported(entity: u32, cause: &'static str) -> Error {
    Error::Presentation {
        refusal: RetainedProductRefusal::AppearanceUnsupported,
        origin: RefusalOrigin { site: "appearance", entity: Some(entity), cause },
    }
}
