// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The prepass flat-wire codecs: each encoder the browser prepass runs beside
//! the decoder `processGeometryBatch` runs on the other side of the JS
//! boundary (EDGE-WASM-10, #8341).
//!
//! The arrays are authored by one call (`buildPrePassOnce` / the streaming
//! prepass) and read by another, possibly on a different worker, so the two
//! halves are a wire contract. Keeping them in one module, under one
//! round-trip test, is what stops a layout change landing on one side only.
//! The decoders are deliberately lenient and never panic: under the wasm
//! `panic=abort` profile an index past the end would trap the whole instance
//! for the rest of the session. Each documents what it drops.
//!
//! [`crate::prepass::flat_styles_rgba8`] stays beside the resolution layering
//! it flattens; its inverse is [`style_colors_from_flat`].

use rustc_hash::FxHashMap;

/// Flat wire encoding of the void index: `(keys, counts, values)` in the
/// shape `processGeometryBatch` accepts.
///
/// Emitted sorted by host id (u32 ascending). FxHashMap iteration order is
/// seed-free and therefore stable today, but it is an implicit
/// insertion+hash-order artifact; the sort makes the wire byte order an
/// explicit contract (pinned by the mesh-output determinism manifest,
/// `docs/architecture/mesh-determinism.md`). Consumers rebuild a map from the
/// flat arrays ([`voids_from_flat`]), so they are order-insensitive.
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

/// Rebuild the host -> openings map from [`flat_voids`]'s `(keys, counts,
/// values)` arrays.
///
/// A `keys`/`counts` length mismatch drops the whole index (hosts then render
/// solid, which `crate::element` already treats as "no openings"), and a
/// `values` slice that runs past the end stops reconstruction, keeping the
/// hosts decoded before it.
pub fn voids_from_flat(
    void_keys: &[u32],
    void_counts: &[u32],
    void_values: &[u32],
) -> FxHashMap<u32, Vec<u32>> {
    let mut void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    if void_counts.len() != void_keys.len() {
        return void_index;
    }
    let mut value_offset = 0usize;
    for (i, &host_id) in void_keys.iter().enumerate() {
        let count = void_counts[i] as usize;
        let end = value_offset.saturating_add(count);
        let Some(openings) = void_values.get(value_offset..end) else {
            break;
        };
        void_index.insert(host_id, openings.to_vec());
        value_offset = end;
    }
    void_index
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
    let available = rgba.len() / 4;
    let mut offset = 0usize;
    for (i, &element_id) in element_ids.iter().enumerate() {
        let Some(&count) = counts.get(i) else { break };
        // `count` is wire input: clamp to the colours `rgba` holds instead of
        // reserving `count` (up to 64 GiB) or wrapping `offset` on wasm32
        // (#7675). A short buffer keeps the colours it has, as before.
        let end = offset.saturating_add(count as usize).min(available);
        let colors: Vec<[f32; 4]> = rgba[offset.min(end) * 4..end * 4]
            .chunks_exact(4)
            .map(|c| crate::style::Rgba::from_rgba8([c[0], c[1], c[2], c[3]]).to_array())
            .collect();
        offset = offset.saturating_add(count as usize);
        if !colors.is_empty() {
            out.insert(element_id, colors);
        }
    }
    out
}

/// Decode the `(styleIds, styleColors)` pair [`crate::prepass::flat_styles_rgba8`]
/// emits — `style_ids[i]` paired with the four bytes at `style_colors[i * 4 ..]`
/// — into a 0..1 RGBA map.
///
/// A style whose four bytes are not all present (an older or truncated
/// producer) is dropped rather than read past the end or filled with garbage,
/// so a short tail costs those styles their colour and nothing else.
pub fn style_colors_from_flat(
    style_ids: &[u32],
    style_colors: &[u8],
) -> FxHashMap<u32, [f32; 4]> {
    let mut colors: FxHashMap<u32, [f32; 4]> =
        FxHashMap::with_capacity_and_hasher(style_ids.len(), Default::default());
    for (i, &style_id) in style_ids.iter().enumerate() {
        let base = i * 4;
        if base + 3 < style_colors.len() {
            let rgba8 = [
                style_colors[base],
                style_colors[base + 1],
                style_colors[base + 2],
                style_colors[base + 3],
            ];
            colors.insert(style_id, crate::style::Rgba::from_rgba8(rgba8).to_array());
        }
    }
    colors
}

#[cfg(test)]
#[path = "prepass_wire_tests.rs"]
mod tests;
