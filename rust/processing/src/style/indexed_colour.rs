// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `IfcIndexedColourMap` resolution (issue #913, Phase 2).
//!
//! Ported from the browser pipeline so the backend resolves the same authored
//! colors. CATIA / 3DEXPERIENCE exports color tessellated geometry through
//! `IFCINDEXEDCOLOURMAP` + `IFCCOLOURRGBLIST` with no `IFCSTYLEDITEM` chain;
//! pre-fix the backend ignored them and fell back to the default type color
//! (issue #663).
//!
//! Two levels of fidelity:
//! - [`FullIndexedColourMap::dominant`] — one colour per face set, used to fill
//!   the element style index (#663, the common single-colour case).
//! - [`split_mesh_by_indexed_colour`] — one sub-mesh per palette group, so a
//!   face set whose `ColourIndex` assigns different colours to different
//!   triangles renders correctly (issue #858).

use super::Rgba;
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use ifc_lite_geometry::Mesh;

/// A fully resolved `IfcIndexedColourMap`: the palette plus a per-triangle
/// index into it (in `CoordIndex` order, which the triangulated-face-set
/// processor preserves 1:1).
#[derive(Debug, Clone)]
pub struct FullIndexedColourMap {
    /// The face set this map colours (`MappedTo`).
    pub geometry_id: u32,
    /// The colour palette (`IfcColourRgbList.ColourList`).
    pub colours: Vec<Rgba>,
    /// Per-triangle 0-based index into `colours`, one entry per triangle.
    pub triangle_palette: Vec<usize>,
}

impl FullIndexedColourMap {
    /// Number of distinct palette entries actually referenced by triangles.
    pub(crate) fn distinct_used(&self) -> usize {
        let mut seen = self.triangle_palette.clone();
        seen.sort_unstable();
        seen.dedup();
        seen.len()
    }

    /// The most-frequently-referenced colour (single-colour maps return their
    /// only colour). Used to fill the element style index.
    pub fn dominant(&self) -> Rgba {
        let mut counts: rustc_hash::FxHashMap<usize, u32> = rustc_hash::FxHashMap::default();
        for &p in &self.triangle_palette {
            *counts.entry(p).or_insert(0) += 1;
        }
        let idx = counts
            .iter()
            .max_by_key(|(_, c)| *c)
            .map(|(&i, _)| i)
            .unwrap_or(0);
        self.colours.get(idx).copied().unwrap_or(Rgba::new(0.8, 0.8, 0.8, 1.0))
    }
}

/// Resolve an `IfcIndexedColourMap` to its palette + per-triangle indices.
///
/// Schema (IFC4):
/// - attr 0: `MappedTo` → `IfcTessellatedFaceSet`
/// - attr 1: `Opacity` (optional `0..=1`, `1.0` when omitted)
/// - attr 2: `Colours` → `IfcColourRgbList` (attr 0 = `ColourList`)
/// - attr 3: `ColourIndex` → 1-based palette index per triangle
pub fn resolve_indexed_colour_map_full(
    entity: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Option<FullIndexedColourMap> {
    let geometry_id = entity.get_ref(0)?;
    let opacity = entity
        .get(1)
        .and_then(|a| a.as_float())
        .map(|v| v as f32)
        .unwrap_or(1.0)
        .clamp(0.0, 1.0);
    let colours_id = entity.get_ref(2)?;
    let index_attr = entity.get(3)?;
    let index_list = index_attr.as_list()?;
    if index_list.is_empty() {
        return None;
    }

    let colours_entity = decoder.decode_by_id(colours_id).ok()?;
    let colour_list = colours_entity.get(0)?.as_list()?;
    let colours: Vec<Rgba> = colour_list
        .iter()
        .filter_map(|c| {
            let rgb = c.as_list()?;
            let r = rgb.first().and_then(|v| v.as_float())? as f32;
            let g = rgb.get(1).and_then(|v| v.as_float())? as f32;
            let b = rgb.get(2).and_then(|v| v.as_float())? as f32;
            Some(Rgba::new(r, g, b, opacity))
        })
        .collect();
    if colours.is_empty() {
        return None;
    }

    let max_idx = colours.len() - 1;
    let triangle_palette: Vec<usize> = index_list
        .iter()
        .map(|v| {
            let one_based = v.as_int().unwrap_or(1).max(1) as usize;
            (one_based - 1).min(max_idx)
        })
        .collect();

    Some(FullIndexedColourMap {
        geometry_id,
        colours,
        triangle_palette,
    })
}

/// Split a flat-shaded mesh into one sub-mesh per palette group.
///
/// Returns `None` (caller keeps the single dominant-coloured mesh) unless the
/// mesh triangle count matches `map.triangle_palette` exactly — a mismatch
/// means CSG/void cutting changed the topology, so the per-triangle mapping no
/// longer applies. Triangle `i` of the mesh corresponds to `CoordIndex[i]`
/// because the triangulated-face-set processor preserves triangle order.
pub(crate) fn split_mesh_by_indexed_colour(
    mesh: &Mesh,
    map: &FullIndexedColourMap,
) -> Option<Vec<(Rgba, Mesh)>> {
    let tri_count = mesh.indices.len() / 3;
    if tri_count == 0 || tri_count != map.triangle_palette.len() {
        return None;
    }
    if map.distinct_used() < 2 {
        return None; // single colour — nothing to split
    }

    let has_normals = mesh.normals.len() == mesh.positions.len();
    let rtc_applied = mesh.rtc_applied;

    // One accumulator per palette entry; built lazily so empty groups vanish.
    #[derive(Default)]
    struct Group {
        positions: Vec<f32>,
        normals: Vec<f32>,
        indices: Vec<u32>,
    }
    let mut groups: Vec<Option<Group>> = (0..map.colours.len()).map(|_| None).collect();

    for (tri, &palette) in map.triangle_palette.iter().enumerate() {
        // Defensive: drop the *whole* triangle if any of its three vertices is
        // out of range — skipping a single vertex would emit a malformed
        // 1- or 2-vertex triangle.
        let tri_in_range = (0..3).all(|k| {
            let vi = mesh.indices[tri * 3 + k] as usize;
            vi * 3 + 2 < mesh.positions.len()
        });
        if !tri_in_range {
            continue;
        }

        let group = groups[palette].get_or_insert_with(Group::default);
        for k in 0..3 {
            let vi = mesh.indices[tri * 3 + k] as usize;
            let base = vi * 3;
            let new_index = (group.positions.len() / 3) as u32;
            group.positions.push(mesh.positions[base]);
            group.positions.push(mesh.positions[base + 1]);
            group.positions.push(mesh.positions[base + 2]);
            if has_normals {
                group.normals.push(mesh.normals[base]);
                group.normals.push(mesh.normals[base + 1]);
                group.normals.push(mesh.normals[base + 2]);
            }
            group.indices.push(new_index);
        }
    }

    let out: Vec<(Rgba, Mesh)> = groups
        .into_iter()
        .enumerate()
        .filter_map(|(palette, group)| {
            let group = group?;
            if group.indices.is_empty() {
                return None;
            }
            let mesh = Mesh {
                positions: group.positions,
                normals: group.normals,
                indices: group.indices,
                rtc_applied,
            };
            Some((map.colours[palette], mesh))
        })
        .collect();

    (out.len() >= 2).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::{split_mesh_by_indexed_colour, FullIndexedColourMap};
    use crate::style::Rgba;
    use ifc_lite_geometry::Mesh;

    #[test]
    fn split_drops_out_of_range_triangle_without_partial_geometry() {
        // 6 in-range vertices (0..=5); the third triangle references vertex 99,
        // which is out of range. The split must drop that whole triangle, never
        // emit a 1- or 2-vertex fragment.
        let positions: Vec<f32> = (0..6).flat_map(|i| [i as f32, 0.0, 0.0]).collect();
        let mesh = Mesh {
            positions,
            normals: Vec::new(),
            indices: vec![0, 1, 2, 3, 4, 5, 0, 1, 99],
            rtc_applied: false,
        };
        let map = FullIndexedColourMap {
            geometry_id: 1,
            colours: vec![Rgba::new(1.0, 0.0, 0.0, 1.0), Rgba::new(0.0, 1.0, 0.0, 1.0)],
            // tri0 → red, tri1 → green, tri2 (out of range) → red
            triangle_palette: vec![0, 1, 0],
        };

        let parts = split_mesh_by_indexed_colour(&mesh, &map)
            .expect("two valid palette groups survive after dropping the OOB triangle");

        let total_tris: usize = parts
            .iter()
            .map(|(_, m)| {
                assert_eq!(m.indices.len() % 3, 0, "index buffer must be whole triangles");
                assert_eq!(m.positions.len() % 3, 0, "positions must be whole vertices");
                m.indices.len() / 3
            })
            .sum();
        assert_eq!(
            total_tris, 2,
            "the out-of-range triangle must be dropped, not partially emitted"
        );
    }
}
