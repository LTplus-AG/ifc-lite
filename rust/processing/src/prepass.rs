// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Canonical prepass resolution — the single post-scan step that turns the
//! entity spans a scan collected into the style / material / void context the
//! per-element producer ([`crate::element`]) consumes.
//!
//! Both pipelines run this exact code:
//! - the native orchestrator (`processor.rs`) span-stashes during its scan and
//!   resolves here before the rayon loop;
//! - the browser prepasses (`buildPrePassOnce` / `buildPrePassStreaming` in
//!   `wasm-bindings`) span-stash during their scans and resolve here before
//!   serialising the flat wire arrays.
//!
//! The two scan loops remain per-pipeline (they are mechanical `match`-arms
//! over type names with pipeline-specific extras: quick-metadata, properties,
//! incremental job emission), but everything SEMANTIC — styled-item
//! precedence, IfcIndexedColourMap fallback, the #407 material chain, void
//! collection and aggregate propagation (#845), and unit-scale resolution —
//! lives here exactly once. The historic #858/#913-class drift was always in
//! this resolution layer, not in the span stashing.

use crate::style::{FullIndexedColourMap, GeometryStyleInfo};
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use rustc_hash::FxHashMap;

/// One stashed entity span: `(express_id, start, end)`.
pub type Span = (u32, usize, usize);

/// Entity spans a scan collected for post-scan resolution. Both scan loops
/// fill this; neither decodes these entities mid-scan.
#[derive(Debug, Default)]
pub struct PrepassSpans {
    /// `IFCSTYLEDITEM` — geometry-attached AND orphan (material appearance);
    /// the resolver classifies them (the classifying decode is the cost of
    /// telling the two apart).
    pub styled_items: Vec<Span>,
    /// `IFCINDEXEDCOLOURMAP` (#663/#858 — CATIA/3DEXPERIENCE per-triangle
    /// palettes, IFC4's second colouring mechanism).
    pub indexed_colour_maps: Vec<Span>,
    /// `IFCMATERIALDEFINITIONREPRESENTATION` (#407 material chain).
    pub material_def_reprs: Vec<Span>,
    /// `IFCRELASSOCIATESMATERIAL` (#407 material chain).
    pub rel_associates_material: Vec<Span>,
    /// `IFCRELVOIDSELEMENT` — host → opening.
    pub void_rels: Vec<Span>,
    /// `IFCRELFILLSELEMENT` — opening → filling (window/door); drives the
    /// native opening filter. Cheap to collect everywhere.
    pub fills_rels: Vec<Span>,
    /// `IFCRELAGGREGATES` — parent → children, for aggregate void
    /// propagation (#845, IfcWallElementedCase etc.).
    pub aggregate_rels: Vec<Span>,
}

/// Resolution switches. Both pipelines use the same resolver with different
/// collection needs.
#[derive(Debug, Clone, Copy)]
pub struct ResolveOptions {
    /// Collect the FULL per-triangle palette maps (#858). The native pipeline
    /// consumes them in-process; the browser prepass leaves this off (each
    /// process worker rebuilds its own copy — shipping full palettes over the
    /// JS boundary would dwarf the styles arrays).
    pub collect_indexed_colour_full: bool,
    /// Defer geometry-attached styled items: classify and resolve ORPHAN
    /// styled items now (#913 §2c — the material chain needs them up front),
    /// but return attached spans unresolved on
    /// [`ResolvedPrepass::deferred_attached_styled_spans`] for a later
    /// [`resolve_styled_item_spans`] replay. Native `fast_first_batch` mode.
    pub defer_attached_styles: bool,
}

impl Default for ResolveOptions {
    fn default() -> Self {
        Self {
            collect_indexed_colour_full: true,
            defer_attached_styles: false,
        }
    }
}

/// Everything the post-scan resolution produces.
#[derive(Debug, Default)]
pub struct ResolvedPrepass {
    /// Geometry item id → resolved style (styled items first in file order,
    /// then IfcIndexedColourMap dominant colours fill the gaps — styled items
    /// win, #913 precedence).
    pub geometry_style_index: FxHashMap<u32, GeometryStyleInfo>,
    /// Geometry item id → dominant palette colour (#858).
    pub indexed_colour_index: FxHashMap<u32, [f32; 4]>,
    /// Geometry item id → full per-triangle palette (#858); empty unless
    /// [`ResolveOptions::collect_indexed_colour_full`].
    pub indexed_colour_full: FxHashMap<u32, FullIndexedColourMap>,
    /// Orphan `IfcStyledItem` colours (material appearances, #407).
    pub orphan_styled_items: FxHashMap<u32, [f32; 4]>,
    /// Material id → styled representation ids (#407).
    pub material_def_reprs: FxHashMap<u32, Vec<u32>>,
    /// Element id → material(-select) id (#407).
    pub element_to_material: FxHashMap<u32, u32>,
    /// Element id → material colour list (#407/#913 §2.3 transparent/opaque
    /// alternation for window/door parts). The canonical join.
    pub element_material_colors: FxHashMap<u32, Vec<[f32; 4]>>,
    /// Host element id → opening ids, AFTER aggregate propagation (#845).
    pub void_index: FxHashMap<u32, Vec<u32>>,
    /// Opening id → filling element id (native opening filter input).
    pub filling_by_opening: FxHashMap<u32, u32>,
    /// Geometry-attached styled-item spans NOT resolved because
    /// [`ResolveOptions::defer_attached_styles`] was set; replay them with
    /// [`resolve_styled_item_spans`].
    pub deferred_attached_styled_spans: Vec<(usize, usize)>,
}

/// THE canonical post-scan resolution. Spans are processed in file order so
/// first-wins precedence matches what the historic inline scans produced.
pub fn resolve_prepass(
    spans: &PrepassSpans,
    decoder: &mut EntityDecoder,
    opts: ResolveOptions,
) -> ResolvedPrepass {
    let mut out = ResolvedPrepass::default();

    // ── Styled items: orphan (material appearance) vs geometry-attached ──
    for &(id, start, end) in &spans.styled_items {
        let Ok(styled_item) = decoder.decode_at_with_id(id, start, end) else {
            if opts.defer_attached_styles {
                // Undecodable now — let the replay try again later, matching
                // the historic defer behaviour.
                out.deferred_attached_styled_spans.push((start, end));
            }
            continue;
        };
        if styled_item.get_ref(0).is_none() {
            // Orphan styled item (null Item) = a material appearance (#407).
            // Always resolved up front — even in defer mode — or
            // material-only-styled elements render default-gray (#913 §2c).
            if let Some(info) = extract_style_info_from_styled_item(&styled_item, decoder) {
                out.orphan_styled_items.insert(id, info.color);
            }
        } else if opts.defer_attached_styles {
            out.deferred_attached_styled_spans.push((start, end));
        } else {
            collect_geometry_style_info(&mut out.geometry_style_index, &styled_item, decoder);
        }
    }

    // ── IfcIndexedColourMap (#663/#858) ──
    for &(id, start, end) in &spans.indexed_colour_maps {
        let Ok(icm) = decoder.decode_at_with_id(id, start, end) else {
            continue;
        };
        let Some(full) = crate::style::resolve_indexed_colour_map_full(&icm, decoder) else {
            continue;
        };
        let geometry_id = full.geometry_id;
        out.indexed_colour_index
            .entry(geometry_id)
            .or_insert(full.dominant().to_array());
        if opts.collect_indexed_colour_full {
            out.indexed_colour_full.entry(geometry_id).or_insert(full);
        }
    }

    // ── Material chain inputs (#407) ──
    for &(id, start, end) in &spans.material_def_reprs {
        if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
            // RepresentedMaterial (attr 3) → Representations (attr 2).
            if let Some(material_id) = entity.get_ref(3) {
                if let Some(reprs) = refs_from_list(&entity, 2) {
                    out.material_def_reprs
                        .entry(material_id)
                        .or_default()
                        .extend(reprs);
                }
            }
        }
    }
    for &(id, start, end) in &spans.rel_associates_material {
        if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
            // RelatingMaterial (attr 5) ← RelatedObjects (attr 4).
            if let Some(material_select_id) = entity.get_ref(5) {
                if let Some(related) = refs_from_list(&entity, 4) {
                    for element_id in related {
                        out.element_to_material.insert(element_id, material_select_id);
                    }
                }
            }
        }
    }

    // ── Voids + fills + aggregate propagation (#845) ──
    for &(id, start, end) in &spans.void_rels {
        if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
            if let (Some(host), Some(opening)) = (entity.get_ref(4), entity.get_ref(5)) {
                out.void_index.entry(host).or_default().push(opening);
            }
        }
    }
    for &(id, start, end) in &spans.fills_rels {
        if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
            // attr 4 = RelatingOpeningElement, attr 5 = RelatedBuildingElement.
            if let (Some(opening_id), Some(filling_id)) = (entity.get_ref(4), entity.get_ref(5)) {
                out.filling_by_opening.insert(opening_id, filling_id);
            }
        }
    }
    if !out.void_index.is_empty() && !spans.aggregate_rels.is_empty() {
        let mut aggregate_children: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
        for &(id, start, end) in &spans.aggregate_rels {
            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                let Some(parent_id) = entity.get_ref(4) else {
                    continue;
                };
                if let Some(children) = refs_from_list(&entity, 5) {
                    aggregate_children
                        .entry(parent_id)
                        .or_default()
                        .extend(children);
                }
            }
        }
        ifc_lite_geometry::propagate_voids_via_aggregates(
            &mut out.void_index,
            &aggregate_children,
        );
    }

    // ── Material chain join (#407): element id → colour list ──
    out.element_material_colors = crate::style::build_element_material_colors(
        &out.material_def_reprs,
        &out.orphan_styled_items,
        &out.element_to_material,
        decoder,
    );

    out
}

/// Resolve geometry-attached styled-item spans into a style index — the
/// defer-mode replay (`fast_first_batch`), and the building block
/// [`resolve_prepass`] uses internally.
pub fn resolve_styled_item_spans(
    spans: &[(usize, usize)],
    decoder: &mut EntityDecoder,
) -> FxHashMap<u32, GeometryStyleInfo> {
    let mut styles: FxHashMap<u32, GeometryStyleInfo> = FxHashMap::default();
    for &(start, end) in spans {
        if let Ok(styled_item) = decoder.decode_at(start, end) {
            if styled_item.get_ref(0).is_some() {
                collect_geometry_style_info(&mut styles, &styled_item, decoder);
            }
        }
    }
    styles
}

/// Fold `IfcIndexedColourMap` dominant colours into the style index, keyed by
/// target geometry id. `or_insert` preserves IFCSTYLEDITEM precedence: a
/// geometry that already has a direct style keeps it; the indexed colour only
/// fills the gaps (#913).
pub fn merge_indexed_colours(
    geometry_styles: &mut FxHashMap<u32, GeometryStyleInfo>,
    indexed_colours: &FxHashMap<u32, [f32; 4]>,
) {
    for (&geometry_id, &color) in indexed_colours {
        geometry_styles
            .entry(geometry_id)
            .or_insert_with(|| GeometryStyleInfo::from_color(color));
    }
}

/// The file's unit scales, resolved exactly once per parse.
#[derive(Debug, Clone, Copy)]
pub struct UnitScales {
    /// Length unit → metres (1.0 for metre files, 0.001 for millimetre files).
    pub length_unit_scale: f64,
    /// Plane-angle unit → radians (1.0 for RADIAN files, π/180 for DEGREE).
    pub plane_angle_to_radians: f64,
    /// The `IFCPROJECT` express id the scales were resolved from, when found.
    pub project_id: Option<u32>,
}

impl Default for UnitScales {
    fn default() -> Self {
        Self {
            length_unit_scale: 1.0,
            plane_angle_to_radians: 1.0,
            project_id: None,
        }
    }
}

/// Resolve BOTH unit scales once, against the decoder's (possibly partial)
/// entity index, with the documented fallback ladder:
///
/// 1. `project_id` hint (recorded by the scan) — O(1) decode via the index.
/// 2. No hint? Find `IFCPROJECT` by SIMD substring search (it is a singleton
///    and many exporters — IfcOpenShell, Revit — emit it near the END of the
///    file, after the scan's early-meta point).
/// 3. Resolution chain incomplete on a PARTIAL index (streaming early-meta:
///    the IFCSIUNIT chain may sit past the scan point)? Re-resolve against a
///    freshly built FULL index rather than silently defaulting — a millimetre
///    model resolved as metres renders 1000× oversized.
///
/// This is the only sanctioned place that hunts for `IFCPROJECT`; per-element
/// decoders are seeded from the result (`EntityDecoder::seed_unit_scales`) so
/// the historic O(file)-scan-per-decoder stall class stays dead.
pub fn resolve_unit_scales(
    content: &[u8],
    project_id_hint: Option<u32>,
    decoder: &mut EntityDecoder,
) -> UnitScales {
    let project_id = project_id_hint.or_else(|| find_ifcproject_id(content));
    let Some(pid) = project_id else {
        return UnitScales::default();
    };

    // Fast path: resolve on the caller's decoder/index. BOTH resolvers return
    // `None` (not a masked default) when their chain is incomplete on a partial
    // index, so an unresolved either-scale forces the full-index retry below
    // rather than silently shipping radians/metres (issue #1367).
    let length = ifc_lite_core::try_extract_length_unit_scale(decoder, pid);
    let angle = ifc_lite_core::try_extract_plane_angle_to_radians(decoder, pid);

    if let (Some(length_unit_scale), Some(plane_angle_to_radians)) = (length, angle) {
        return UnitScales {
            length_unit_scale,
            plane_angle_to_radians,
            project_id,
        };
    }

    // Chain incomplete (partial index) — resolve against a full index.
    let full_index = ifc_lite_core::build_entity_index(content);
    let mut full_decoder = EntityDecoder::with_index(content, full_index);
    UnitScales {
        length_unit_scale: length.or_else(|| {
            ifc_lite_core::extract_length_unit_scale(&mut full_decoder, pid).ok()
        })
        .unwrap_or(1.0),
        plane_angle_to_radians: angle
            .or_else(|| {
                ifc_lite_core::extract_plane_angle_to_radians(&mut full_decoder, pid).ok()
            })
            .unwrap_or(1.0),
        project_id,
    }
}

/// Find the singleton `IFCPROJECT`'s express id by SIMD substring search —
/// no full entity scan. Returns `None` when the file has no project.
pub fn find_ifcproject_id(content: &[u8]) -> Option<u32> {
    let mut from = 0usize;
    // Search for the keyword+paren only; the `=` and `#<id>` are reconstructed by
    // backtracking. Exporters vary the whitespace around `=` — Revit/EDM emits
    // `#1593796= IFCPROJECT(` with a SPACE, so the old `=IFCPROJECT(` literal
    // never matched and the whole unit chain silently defaulted (length → metres
    // on a mm model, plane-angle → radians on a degree model, making arched
    // openings render as full circles — issue #1367). `IFCPROJECT(` cannot
    // collide with `IFCPROJECTEDCRS(` because the `(` must immediately follow.
    while let Some(rel) = memchr::memmem::find(&content[from..], b"IFCPROJECT(") {
        let kw = from + rel;
        // Backtrack over optional whitespace, then require '='.
        let mut i = kw;
        while i > 0 && content[i - 1].is_ascii_whitespace() {
            i -= 1;
        }
        if i > 0 && content[i - 1] == b'=' {
            i -= 1; // step over '='
            // Optional whitespace between the express id and '='.
            while i > 0 && content[i - 1].is_ascii_whitespace() {
                i -= 1;
            }
            // Backtrack over the express id digits to the '#'.
            let digits_end = i;
            while i > 0 && content[i - 1].is_ascii_digit() {
                i -= 1;
            }
            if i > 0 && content[i - 1] == b'#' && i < digits_end {
                let mut id: u32 = 0;
                for &b in &content[i..digits_end] {
                    id = id.wrapping_mul(10).wrapping_add((b - b'0') as u32);
                }
                return Some(id);
            }
        }
        // `IFCPROJECT(` not preceded by `#<digits>=` (e.g. inside a string)
        // — keep searching.
        from = kw + 1;
    }
    None
}

/// Flat wire encodings of the resolved styles for the browser's
/// `styleIds`/`styleColors` arrays: the rich style index flattened to
/// `(ids, rgba8)`, with IfcIndexedColourMap dominants, flat material colours,
/// and per-element first material colours filling the gaps — the exact
/// layered precedence the browser prepasses have always shipped.
pub fn flat_styles_rgba8(resolved: &ResolvedPrepass, decoder: &mut EntityDecoder) -> (Vec<u32>, Vec<u8>) {
    let mut merged: FxHashMap<u32, [f32; 4]> = resolved
        .geometry_style_index
        .iter()
        .map(|(&id, info)| (id, info.color))
        .collect();
    for (&geometry_id, &color) in &resolved.indexed_colour_index {
        merged.entry(geometry_id).or_insert(color);
    }
    // Flat material_id → colour, then element id → first material colour, so
    // `processGeometryBatch`'s per-element fallback picks them up.
    let material_styles = crate::style::build_material_style_index(
        &resolved.material_def_reprs,
        &resolved.orphan_styled_items,
        decoder,
    );
    for (&mat_id, &color) in crate::style::flatten_material_color_index(&material_styles).iter() {
        merged.entry(mat_id).or_insert(color);
    }
    for (&element_id, colors) in &resolved.element_material_colors {
        if let Some(&color) = colors.first() {
            merged.entry(element_id).or_insert(color);
        }
    }

    // Emit id-ascending: hashmap iteration order is an implementation detail,
    // and these arrays are wire output. Consumers rebuild a map (see the sort
    // rationale on `flat_voids`), so the order is free to pin.
    let mut entries: Vec<(u32, [f32; 4])> = merged.into_iter().collect();
    entries.sort_unstable_by_key(|&(id, _)| id);
    let mut ids: Vec<u32> = Vec::with_capacity(entries.len());
    let mut rgba: Vec<u8> = Vec::with_capacity(entries.len() * 4);
    for (id, color) in entries {
        ids.push(id);
        rgba.extend_from_slice(&crate::style::Rgba::from_array(color).to_rgba8());
    }
    (ids, rgba)
}

/// Flat wire encoding of the void index: `(keys, counts, values)` in the
/// shape `processGeometryBatch` accepts.
///
/// Emitted sorted by host id (u32 ascending). FxHashMap iteration order is
/// seed-free and therefore stable today, but it is an implicit
/// insertion+hash-order artifact; the sort makes the wire byte order an
/// explicit contract (pinned by the mesh-output determinism manifest,
/// `docs/architecture/mesh-determinism.md`). Consumers rebuild a map from the
/// flat arrays (`processGeometryBatch`), so they are order-insensitive.
pub fn flat_voids(void_index: &FxHashMap<u32, Vec<u32>>) -> (Vec<u32>, Vec<u32>, Vec<u32>) {
    let mut hosts: Vec<(&u32, &Vec<u32>)> = void_index.iter().collect();
    hosts.sort_unstable_by_key(|&(&host_id, _)| host_id);
    let mut keys: Vec<u32> = Vec::with_capacity(hosts.len());
    let mut counts: Vec<u32> = Vec::with_capacity(hosts.len());
    let mut values: Vec<u32> = Vec::new();
    for (&host_id, openings) in hosts {
        keys.push(host_id);
        counts.push(openings.len() as u32);
        values.extend(openings.iter().copied());
    }
    (keys, counts, values)
}

/// Flat wire encoding of the element material colour lists (#407/#913 §2.3):
/// `(element_ids, counts, rgba8)` — `counts[i]` colours belong to
/// `element_ids[i]`, in order, 4 bytes each.
///
/// Emitted sorted by element id (u32 ascending) - same explicit-order wire
/// contract as [`flat_voids`]; the per-element colour list order (file order)
/// is unchanged. The inverse [`material_colors_from_flat`] rebuilds a map, so
/// consumers are order-insensitive.
pub fn flat_material_colors(
    element_material_colors: &FxHashMap<u32, Vec<[f32; 4]>>,
) -> (Vec<u32>, Vec<u32>, Vec<u8>) {
    let mut elements: Vec<(&u32, &Vec<[f32; 4]>)> = element_material_colors.iter().collect();
    elements.sort_unstable_by_key(|&(&element_id, _)| element_id);
    let mut ids: Vec<u32> = Vec::with_capacity(elements.len());
    let mut counts: Vec<u32> = Vec::with_capacity(elements.len());
    let mut rgba: Vec<u8> = Vec::new();
    for (&element_id, colors) in elements {
        if colors.is_empty() {
            continue;
        }
        ids.push(element_id);
        counts.push(colors.len() as u32);
        for &c in colors {
            rgba.extend_from_slice(&crate::style::Rgba::from_array(c).to_rgba8());
        }
    }
    (ids, counts, rgba)
}

/// Decode the flat material-colour wire arrays back into the canonical map —
/// the inverse of [`flat_material_colors`], used by `processGeometryBatch`.
pub fn material_colors_from_flat(
    element_ids: &[u32],
    counts: &[u32],
    rgba: &[u8],
) -> FxHashMap<u32, Vec<[f32; 4]>> {
    let mut out: FxHashMap<u32, Vec<[f32; 4]>> = FxHashMap::default();
    let mut offset = 0usize;
    for (i, &element_id) in element_ids.iter().enumerate() {
        let Some(&count) = counts.get(i) else { break };
        let count = count as usize;
        let mut colors: Vec<[f32; 4]> = Vec::with_capacity(count);
        for c in 0..count {
            let base = (offset + c) * 4;
            if base + 3 >= rgba.len() {
                break;
            }
            colors.push(
                crate::style::Rgba::from_rgba8([
                    rgba[base],
                    rgba[base + 1],
                    rgba[base + 2],
                    rgba[base + 3],
                ])
                .to_array(),
            );
        }
        offset += count;
        if !colors.is_empty() {
            out.insert(element_id, colors);
        }
    }
    out
}

// ── Styled-item resolution chain (moved from processor.rs — shared) ──

/// Resolve a geometry-attached `IfcStyledItem` into the style index with
/// first-wins precedence per geometry id (file order = authored intent).
pub(crate) fn collect_geometry_style_info(
    geometry_styles: &mut FxHashMap<u32, GeometryStyleInfo>,
    styled_item: &DecodedEntity,
    decoder: &mut EntityDecoder,
) {
    let Some(geometry_id) = styled_item.get_ref(0) else {
        return;
    };
    if geometry_styles.contains_key(&geometry_id) {
        return;
    }
    if let Some(style_info) = extract_style_info_from_styled_item(styled_item, decoder) {
        geometry_styles.insert(geometry_id, style_info);
    }
}

/// Extract colour + name from an `IfcStyledItem` by traversing its style
/// references (directly or through `IfcPresentationStyleAssignment`).
pub(crate) fn extract_style_info_from_styled_item(
    styled_item: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Option<GeometryStyleInfo> {
    let style_refs = refs_from_list(styled_item, 1)?;

    for style_id in style_refs {
        if let Ok(style) = decoder.decode_by_id(style_id) {
            // IfcPresentationStyleAssignment has nested style refs at attr 0.
            if let Some(inner_refs) = refs_from_list(&style, 0) {
                for inner_id in inner_refs {
                    if let Some(info) = extract_surface_style_info(inner_id, decoder) {
                        return Some(info);
                    }
                }
            }

            // Or the style ref points directly to IfcSurfaceStyle.
            if let Some(info) = extract_surface_style_info(style_id, decoder) {
                return Some(info);
            }
        }
    }

    None
}

/// Extract colour + style name from an `IfcSurfaceStyle`. Colour resolution is
/// the canonical [`crate::style::extract_surface_style_colors`], shared with
/// the browser pre-pass so the server and viewer can't disagree on
/// `SurfaceColour` vs `DiffuseColour` precedence (#997).
fn extract_surface_style_info(
    style_id: u32,
    decoder: &mut EntityDecoder,
) -> Option<GeometryStyleInfo> {
    let style = decoder.decode_by_id(style_id).ok()?;
    let material_name = normalize_style_name(style.get_string(0));
    let (color, shading_color) = crate::style::extract_surface_style_colors(style_id, decoder)?;
    Some(GeometryStyleInfo {
        color,
        shading_color,
        material_name,
    })
}

fn normalize_style_name(raw: Option<&str>) -> Option<String> {
    let name = raw?.trim();
    if name.is_empty() || name == "$" {
        return None;
    }
    if name.eq_ignore_ascii_case("<unnamed>") || name.eq_ignore_ascii_case("unnamed") {
        return None;
    }
    Some(name.to_string())
}

/// Extract entity references from a list attribute.
fn refs_from_list(entity: &DecodedEntity, index: usize) -> Option<Vec<u32>> {
    let list = entity.get_list(index)?;
    let refs: Vec<u32> = list.iter().filter_map(|v| v.as_entity_ref()).collect();
    if refs.is_empty() {
        None
    } else {
        Some(refs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ifc_lite_core::{EntityIndex, EntityScanner};

    #[test]
    fn find_ifcproject_id_late_in_file() {
        let ifc = b"ISO-10303-21;\nDATA;\n#1=IFCWALL('x',$,$,$,$,$,$,$,$);\n#999123=IFCPROJECT('g',$,'P',$,$,$,$,$,$);\nENDSEC;\n";
        assert_eq!(find_ifcproject_id(ifc), Some(999123));
    }

    #[test]
    fn find_ifcproject_id_absent() {
        let ifc = b"ISO-10303-21;\nDATA;\n#1=IFCWALL('x',$,$,$,$,$,$,$,$);\nENDSEC;\n";
        assert_eq!(find_ifcproject_id(ifc), None);
    }

    #[test]
    fn find_ifcproject_id_skips_string_decoys() {
        let ifc = b"DATA;\n#5=IFCWALL('decoy =IFCPROJECT( in a name',$);\n#7=IFCPROJECT('g',$);\n";
        assert_eq!(find_ifcproject_id(ifc), Some(7));
    }

    #[test]
    fn find_ifcproject_id_handles_whitespace_around_equals() {
        // Revit/EDM exporters write `#id= IFCPROJECT(` with a space after `=`;
        // the old `=IFCPROJECT(` literal never matched → the whole unit chain
        // defaulted to metres + radians (issue #1367, arched openings → circles).
        let space_after = b"DATA;\n#1=IFCWALL('x',$);\n#1593796= IFCPROJECT('g',$,'P',$,$,$,$,$,$);\n";
        assert_eq!(find_ifcproject_id(space_after), Some(1593796));

        let space_both = b"DATA;\n#42 = IFCPROJECT('g',$);\n";
        assert_eq!(find_ifcproject_id(space_both), Some(42));

        // IFCPROJECTEDCRS must not be mistaken for IFCPROJECT.
        let crs_only = b"DATA;\n#9= IFCPROJECTEDCRS('EPSG:32632',$,'WGS84',$,'UTM','32N',$);\n";
        assert_eq!(find_ifcproject_id(crs_only), None);
    }

    /// Mimics the Revit/EDM ordering of Architecture.ifc (issue #1367): the
    /// DEGREE plane-angle unit sits near the file head but its conversion
    /// `IFCMEASUREWITHUNIT` is at the very tail. With a PARTIAL index that has the
    /// project + assignment + degree unit but NOT the measure, the plane-angle
    /// resolver must report "incomplete" so `resolve_unit_scales` retries against
    /// a full index instead of silently shipping radians.
    #[test]
    fn resolve_unit_scales_recovers_degrees_when_measure_past_partial_index() {
        const IFC: &[u8] = br#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('u.ifc','2026-06-26T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
#10= IFCPROJECT('g',$,'P',$,$,$,$,$,#11);
#11= IFCUNITASSIGNMENT((#12,#13));
#12= IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#13= IFCCONVERSIONBASEDUNIT(#14,.PLANEANGLEUNIT.,'DEGREE',#15);
#14= IFCDIMENSIONALEXPONENTS(0,0,0,0,0,0,0);
#16= IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);
#15= IFCMEASUREWITHUNIT(IFCRATIOMEASURE(0.0174532925199433),#16);
ENDSEC;
END-ISO-10303-21;
"#;
        // Build a PARTIAL index that omits the tail measure (#15) and exponents
        // (#14), exactly the streaming-gate situation that masked the bug.
        let mut partial = EntityIndex::default();
        let mut scanner = EntityScanner::new(&IFC);
        while let Some((id, _t, start, end)) = scanner.next_entity() {
            if id == 15 || id == 14 {
                continue; // forward-referenced past the gate
            }
            partial.insert(id, (start, end));
        }
        let mut decoder = EntityDecoder::with_index(IFC, partial);
        let scales = resolve_unit_scales(IFC, Some(10), &mut decoder);
        assert_eq!(scales.project_id, Some(10));
        assert!((scales.length_unit_scale - 0.001).abs() < 1e-12);
        assert!(
            (scales.plane_angle_to_radians - 0.0174532925199433).abs() < 1e-12,
            "expected degrees via full-index retry, got {}",
            scales.plane_angle_to_radians
        );
    }

    #[test]
    fn material_colors_flat_round_trip() {
        let mut map: FxHashMap<u32, Vec<[f32; 4]>> = FxHashMap::default();
        map.insert(10, vec![[0.5, 0.5, 0.5, 1.0], [0.7, 0.9, 0.5, 0.2]]);
        map.insert(42, vec![[1.0, 0.0, 0.0, 1.0]]);

        let (ids, counts, rgba) = flat_material_colors(&map);
        let back = material_colors_from_flat(&ids, &counts, &rgba);

        assert_eq!(back.len(), 2);
        assert_eq!(back[&42].len(), 1);
        assert_eq!(back[&10].len(), 2);
        // RGBA8 quantization: equal within 1/255.
        for (orig, round) in map[&10].iter().zip(back[&10].iter()) {
            for (a, b) in orig.iter().zip(round.iter()) {
                assert!((a - b).abs() <= 1.0 / 255.0 + 1e-6);
            }
        }
    }

    /// The flat wire arrays are an EXPLICIT id-ascending contract (pinned by
    /// the mesh-output determinism manifest), not an FxHashMap iteration-order
    /// artifact.
    #[test]
    fn flat_wire_arrays_are_sorted_by_id() {
        let mut voids: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
        voids.insert(300, vec![301, 302]);
        voids.insert(7, vec![8]);
        voids.insert(90, vec![91]);
        let (keys, counts, values) = flat_voids(&voids);
        assert_eq!(keys, vec![7, 90, 300]);
        assert_eq!(counts, vec![1, 1, 2]);
        // Per-host opening lists keep their (file-order) sequence.
        assert_eq!(values, vec![8, 91, 301, 302]);

        let mut colors: FxHashMap<u32, Vec<[f32; 4]>> = FxHashMap::default();
        colors.insert(42, vec![[1.0, 0.0, 0.0, 1.0]]);
        colors.insert(10, vec![[0.0, 1.0, 0.0, 1.0], [0.0, 0.0, 1.0, 0.5]]);
        let (ids, counts, rgba) = flat_material_colors(&colors);
        assert_eq!(ids, vec![10, 42]);
        assert_eq!(counts, vec![2, 1]);
        assert_eq!(rgba.len(), 12);
        // First colour on the wire is element #10's first (green), not #42's.
        assert_eq!(&rgba[0..4], &[0, 255, 0, 255]);
    }

    #[test]
    fn resolve_unit_scales_resolves_degrees_and_millimetres() {
        const IFC: &[u8] = br#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('u.ifc','2026-06-12T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCWALL('w',$,$,$,$,$,$,$,$);
#10=IFCPROJECT('g',$,'P',$,$,$,$,$,#11);
#11=IFCUNITASSIGNMENT((#12,#13));
#12=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#13=IFCCONVERSIONBASEDUNIT(#14,.PLANEANGLEUNIT.,'DEGREE',#15);
#14=IFCDIMENSIONALEXPONENTS(0,0,0,0,0,0,0);
#15=IFCMEASUREWITHUNIT(IFCPLANEANGLEMEASURE(0.017453292519943295),#16);
#16=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);
ENDSEC;
END-ISO-10303-21;
"#;
        // No hint: found by substring search; resolved on a fresh decoder.
        let mut decoder = EntityDecoder::new(IFC);
        let scales = resolve_unit_scales(IFC, None, &mut decoder);
        assert_eq!(scales.project_id, Some(10));
        assert!((scales.length_unit_scale - 0.001).abs() < 1e-12);
        assert!((scales.plane_angle_to_radians - 0.017_453_292_519_943_295).abs() < 1e-12);
    }
}
