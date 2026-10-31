// SPDX-License-Identifier: MPL-2.0
//! Per-triangle palette and per-corner UV from authored face-set rows (#8291).
//! Every value comes from the source row persistent face identity named: a palette
//! index is copied, and a cut's new corner interpolates its row's authored UVs
//! barycentrically, which is exact because a row's triangle is planar. Any row the
//! source cannot answer for refuses; nothing is fabricated or repaired.
use super::appearance_resolve::unsupported;
use super::face_attribution::{in_triangle, Extent, Operand, Role, INCIDENCE_PLANAR_M};
use super::super::error::RetainedExecutionError as Error;
use super::super::publication::{PartPalette, PartSurface, PartTexture, ShapePart, NO_PALETTE_ENTRY};
use super::{Context, ShapeOnlyProduct};
use crate::element::MeshProductionContext;
use crate::style::FullIndexedColourMap;
use ifc_lite_core::{slot, AttributeValue, EntityDecoder};
use ifc_lite_geometry::{document::{RetainedFaceSet, RetainedRecipe}, resource, ResolvedTextureMap};
#[path = "surface_rows.rs"]
mod rows;
use rows::{barycentric, row_of};

fn charge(work: usize) -> Result<(), Error> {
    resource::charge(resource::Cost { work: work as u64, ..Default::default() }).map_err(Error::Stopped)?.retain();
    Ok(())
}
/// The face set whose authored presentation this operand's faces show. A cutter's
/// faces are reveals of the host: its own palette or texture never reaches them.
fn recipe(operand: &Operand) -> Option<&RetainedFaceSet> {
    if operand.subtracted || operand.via != 0 { return None; }
    match operand.request.as_ref()?.recipe() { RetainedRecipe::FaceSet(set) => Some(set), _ => None }
}

/// Exactly one source map per part: one palette and one texture bind one mesh channel.
fn single<'m, T>(operands: &[Operand], lookup: impl Fn(u32) -> Option<&'m T>, mixed: &'static str)
    -> Result<Option<(u32, &'m T)>, Error> {
    let mut found: Option<(u32, &'m T)> = None;
    for operand in operands.iter().filter(|o| recipe(o).is_some()) {
        if let Some(value) = lookup(operand.item) {
            match found {
                Some((item, _)) if item != operand.item => return Err(unsupported(operand.item, mixed)),
                _ => found = Some((operand.item, value)),
            }
        }
    }
    Ok(found)
}

fn palette(map: &FullIndexedColourMap, item: u32, part: &ShapePart, keys: &[Option<(usize, u32)>], operands: &[Operand])
    -> Result<PartPalette, Error> {
    // A repaired map displays in exact, but only an authentic one is the source's palette.
    if !map.authentic { return Err(unsupported(item, "palette_repaired")); }
    let triangles = keys.iter().map(|key| match key {
        Some((operand, row)) if operands[*operand].item == item => map.triangle_palette.get(*row as usize)
            .map(|&entry| entry as u32).ok_or_else(|| unsupported(item, "palette_row")),
        _ => Ok(NO_PALETTE_ENTRY),
    }).collect::<Result<Vec<_>, _>>()?;
    debug_assert_eq!(triangles.len(), part.indices.len() / 3);
    Ok(PartPalette { map_id: map.map_id, colours: map.colours.iter().map(|c| c.to_array()).collect(), triangles })
}

/// `IfcTextureVertexList.TexCoordsList` in full f64: the texture index stores f32.
fn source_uvs(map: &ResolvedTextureMap, item: u32, decoder: &mut EntityDecoder) -> Result<Vec<[f64; 2]>, Error> {
    let list = decoder.decode_by_id(map.tex_coords_id).map_err(Error::Core)?;
    let rows = list.attr(slot::IfcTextureVertexList::TEX_COORDS_LIST).and_then(AttributeValue::as_list)
        .ok_or_else(|| unsupported(item, "texture_row"))?;
    charge(rows.len())?;
    rows.iter().map(|row| {
        let [u, v] = row.as_list()? else { return None };
        Some([u.as_float()?, v.as_float()?])
    }).collect::<Option<_>>().ok_or_else(|| unsupported(item, "texture_row"))
}

fn texture(map: &ResolvedTextureMap, item: u32, part: &ShapePart, keys: &[Option<(usize, u32)>], operands: &[Operand],
    decoder: &mut EntityDecoder) -> Result<PartTexture, Error> {
    let coordinates = source_uvs(map, item, decoder)?;
    let mut uvs = vec![0.; part.indices.len() * 2];
    let mut textured = vec![false; part.indices.len() / 3];
    for (t, key) in keys.iter().enumerate() {
        let Some((o, row)) = key else { continue };
        let operand = &operands[*o];
        if operand.item != item { continue; }
        let set = recipe(operand).ok_or_else(|| unsupported(item, "texture_row"))?;
        // Only triangulated face sets record authored corners; exact textures nothing else.
        if set.source_slots.is_empty() { return Err(unsupported(item, "texture_polygonal")); }
        let face = operand.faces.get(*row as usize).ok_or_else(|| unsupported(item, "texture_row"))?;
        let Extent::Row { triangles, indices } = &face.extent else { return Err(unsupported(item, "texture_row")) };
        let ([piece], [source]) = (triangles.as_slice(), indices.as_slice()) else { return Err(unsupported(item, "texture_row")) };
        let corner_uv = |corner: usize| -> Option<[f64; 2]> {
            let at = *source as usize * 3 + corner;
            let index = match &map.tex_coord_index {
                Some(rows) => rows.get(*row as usize)?[*set.source_slots.get(at)? as usize].checked_sub(1)?,
                None => *set.source_corners.get(at)?,
            };
            coordinates.get(index as usize).copied()
        };
        let authored = [corner_uv(0), corner_uv(1), corner_uv(2)];
        let [Some(a), Some(b), Some(c)] = authored else { return Err(unsupported(item, "texture_row")) };
        for corner in 0..3 {
            let at = part.indices[t * 3 + corner] as usize * 3;
            let local = [part.positions[at], part.positions[at + 1], part.positions[at + 2]];
            let m = &operand.from_part;
            let p: [f64; 3] = std::array::from_fn(|i| m[i] * local[0] + m[i + 4] * local[1] + m[i + 8] * local[2] + m[i + 12]);
            let inside = in_triangle(p, piece, operand.stretch * INCIDENCE_PLANAR_M);
            let weights = barycentric(p, piece).filter(|_| inside).ok_or_else(|| unsupported(item, "texture_corner"))?;
            for axis in 0..2 {
                uvs[(t * 3 + corner) * 2 + axis] = weights[0] * a[axis] + weights[1] * b[axis] + weights[2] * c[axis];
            }
        }
        textured[t] = true;
    }
    Ok(PartTexture { attachment: map.attachment(), uvs, textured })
}

fn part_surface(part: &ShapePart, operands: &[Operand], model: &MeshProductionContext<'_>, decoder: &mut EntityDecoder)
    -> Result<Option<PartSurface>, Error> {
    let bound_palette = single(operands, |id| model.indexed_colour_full.get(&id), "palette_mixed")?;
    let bound_texture = single(operands, |id| model.texture_index.get(&id), "texture_mixed")?;
    if bound_palette.is_none() && bound_texture.is_none() { return Ok(None); }
    let faces = part.faces.as_ref().ok_or_else(|| unsupported(bound_palette.map_or(0, |b| b.0), "binding"))?;
    charge(faces.table.len() * operands.len() + part.indices.len())?;
    let table: Vec<Option<(usize, u32)>> = faces.table.iter().map(|key| {
        let row = row_of(&key.role)?;
        let operand = operands.iter().position(|o| o.item == key.item && o.via == key.via && recipe(o).is_some())?;
        matches!(operands[operand].faces.get(row as usize)?.role, Role::FaceSetRow { .. }).then_some((operand, row))
    }).collect();
    let keys: Vec<_> = faces.triangles.iter().map(|&k| table.get(k as usize).copied().flatten()).collect();
    if keys.len() != part.indices.len() / 3 { return Err(unsupported(bound_palette.map_or(0, |b| b.0), "binding")); }
    Ok(Some(PartSurface {
        palette: bound_palette.map(|(item, map)| palette(map, item, part, &keys, operands)).transpose()?,
        texture: bound_texture.map(|(item, map)| texture(map, item, part, &keys, operands, decoder)).transpose()?,
    }))
}

fn dominant_for(sources: &super::FaceSources, model: &MeshProductionContext<'_>) -> Option<[f32; 4]> {
    let operands = sources.as_ref().ok()?;
    let operand = operands.iter().find(|o| recipe(o).is_some() && model.indexed_colour_full.contains_key(&o.item))?;
    Some(model.indexed_colour_full.get(&operand.item)?.dominant().to_array())
}

pub(super) fn apply(product: &mut ShapeOnlyProduct, context: &Context<'_>) -> Result<(), Error> {
    let source = context.model.source().ok_or(Error::Source(crate::element::session_retained::RetainedContextError::Missing))?;
    let mut decoder = source.decoder();
    let model = context.model.borrowed();
    let fixed = crate::style::fixed_display_color_for_type(&product.ifc_type).is_some();
    for (part, sources) in product.parts.iter_mut().zip(context.faces) {
        let surface = match sources {
            Ok(operands) => part_surface(part, operands, &model, &mut decoder)?,
            Err(_) => None,
        };
        // A binding appearance saw and no surface answered for never publishes as plain colour.
        if let Some(appearance) = &part.appearance {
            let entity = appearance.geometry_item_id.unwrap_or(0);
            if appearance.texture_pending && surface.as_ref().is_none_or(|s| s.texture.is_none()) {
                return Err(unsupported(entity, "texture_pending"));
            }
            if appearance.palette_pending && surface.as_ref().is_none_or(|s| s.palette.is_none()) {
                return Err(unsupported(entity, "indexed_palette_pending"));
            }
        }
        // Exact colours a part it cannot split (a cut) with the map's dominant entry, which
        // is what a reveal keeps here; an unsplit palette part agrees bit for bit.
        if let (Some(map), Some(appearance)) = (dominant_for(sources, &model), &mut part.appearance) {
            if !fixed { appearance.rgba = map; }
        }
        if let Some(surface) = &surface {
            let bytes = surface.palette.as_ref().map_or(0, |p| p.triangles.len() * 4 + p.colours.len() * 16)
                + surface.texture.as_ref().map_or(0, |t| t.uvs.len() * 8 + t.textured.len());
            product._storage.charge(context.resources, resource::Cost { live_bytes: bytes as u64, ..Default::default() })?;
        }
        part.surface = surface;
    }
    Ok(())
}
