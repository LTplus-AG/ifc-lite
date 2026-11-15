// SPDX-License-Identifier: MPL-2.0
//! CityJSON Geometry Objects: the LoD0 footprint, the LoD1 block and the
//! LoD3 surfaces of IFC body geometry.
//!
//! LoD claims (CityGML 3.0 Conceptual Model, §LoD concept):
//!
//! * **LoD0** — the footprint, a horizontal `MultiSurface` at the lowest
//!   point of the building's element geometry. It is the exact outline of
//!   the vertical projection of those elements (see [`super::footprint`]),
//!   so it follows overhangs: CityGML allows LoD0 as a footprint or a
//!   roof-edge representation, and this one is the maximal horizontal
//!   extent of both.
//! * **LoD1** — the prismatic block: that outline extruded from the lowest
//!   to the highest point of the element geometry, one flat roof. A `Solid`
//!   when the outline is one polygon (the shell is closed by construction:
//!   bottom, top and one wall per outline edge, oriented outward), else a
//!   `MultiSurface` of the same faces. Its surfaces carry `GroundSurface`,
//!   `RoofSurface` and `WallSurface` semantics, which the construction makes
//!   unambiguous.
//! * **LoD3** — rooms and building elements carry their IFC body geometry,
//!   tessellated by the ifc-lite pipeline with openings cut, as a
//!   triangulated `MultiSurface`. It is design geometry with no
//!   generalisation, the most detailed LoD CityGML 3.0 defines. No `Solid`
//!   is claimed: closure and orientation of authored IFC geometry are not
//!   verified here.

use serde_json::{json, Value};

use ifc_lite_processing::MeshData;

use super::footprint::Footprint;
use super::vertices::{clean_ring_by, VertexPool};

/// A Geometry Object whose `boundaries` hold indices into the shared pool.
pub(super) struct Geometry {
    pub value: Value,
    /// Every pool index the geometry references.
    pub used: Vec<u32>,
}

/// A ring as pool indices with each vertex's planimetric position.
type PlacedRing = Vec<(u32, [f64; 2])>;
/// The faces of one prism and the semantic surface index of each.
type Prism = (Vec<Vec<Vec<u32>>>, Vec<u32>);

/// Rings at one height, cleaned on the snapped grid, each vertex as its pool
/// index and planimetric position; `None` when the exterior ring collapses.
/// `to_out` maps an IFC world point to output coordinates.
fn polygon_at(
    shape: &[Vec<[f64; 2]>],
    z: f64,
    pool: &mut VertexPool,
    to_out: &impl Fn([f64; 3]) -> [f64; 3],
) -> Option<Vec<PlacedRing>> {
    let mut rings = Vec::with_capacity(shape.len());
    for (i, ring) in shape.iter().enumerate() {
        let pairs: Option<PlacedRing> = ring.iter().map(|p| pool.add(to_out([p[0], p[1], z])).map(|ix| (ix, *p))).collect();
        match pairs.as_deref().and_then(|r| clean_ring_by(r, |(ix, _)| *ix)) {
            Some(r) => rings.push(r),
            None if i == 0 => return None,
            None => {}
        }
    }
    Some(rings)
}

fn indices(rings: &[PlacedRing]) -> Vec<Vec<u32>> {
    rings.iter().map(|r| r.iter().map(|(ix, _)| *ix).collect()).collect()
}

/// The LoD0 footprint.
pub(super) fn lod0(fp: &Footprint, pool: &mut VertexPool, to_out: &impl Fn([f64; 3]) -> [f64; 3]) -> Option<Geometry> {
    let surfaces: Vec<Vec<Vec<u32>>> = fp.shapes.iter().filter_map(|s| polygon_at(s, fp.z_min, pool, to_out)).map(|r| indices(&r)).collect();
    if surfaces.is_empty() {
        return None;
    }
    let used = surfaces.iter().flatten().flatten().copied().collect();
    Some(Geometry { value: json!({ "type": "MultiSurface", "lod": "0", "boundaries": surfaces }), used })
}

const GROUND: u32 = 0;
const ROOF: u32 = 1;
const WALL: u32 = 2;

/// The LoD1 block; `None` when the outline or the height collapses on the grid.
pub(super) fn lod1(fp: &Footprint, pool: &mut VertexPool, to_out: &impl Fn([f64; 3]) -> [f64; 3]) -> Option<Geometry> {
    let mut prisms: Vec<Prism> = Vec::new();
    for shape in &fp.shapes {
        let Some(rings) = polygon_at(shape, fp.z_min, pool, to_out) else { continue };
        let bottom = indices(&rings);
        // Top vertices share the bottom ring's planimetric positions (the map
        // conversion moves X/Y independently of height), so the same ring
        // cleaning applies and each wall joins a bottom and a top edge.
        let mut top: Vec<Vec<u32>> = Vec::with_capacity(bottom.len());
        let mut walls: Vec<Vec<Vec<u32>>> = Vec::new();
        let mut ok = true;
        for (ring, pairs) in bottom.iter().zip(&rings) {
            let lifted: Option<Vec<u32>> = pairs.iter().map(|(_, p)| pool.add(to_out([p[0], p[1], fp.z_max]))).collect();
            let Some(lifted) = lifted else { ok = false; break };
            if lifted.iter().zip(ring).any(|(t, b)| t == b) {
                ok = false; // the block has no height on the grid
                break;
            }
            for k in 0..ring.len() {
                let k1 = (k + 1) % ring.len();
                walls.push(vec![vec![ring[k], ring[k1], lifted[k1], lifted[k]]]);
            }
            top.push(lifted);
        }
        if !ok {
            continue;
        }
        // Seen from below the bottom face turns the other way: outward normal down.
        let bottom_face: Vec<Vec<u32>> = bottom.iter().map(|r| r.iter().rev().copied().collect()).collect();
        let mut faces = vec![bottom_face, top];
        let mut sem = vec![GROUND, ROOF];
        sem.extend(std::iter::repeat_n(WALL, walls.len()));
        faces.extend(walls);
        prisms.push((faces, sem));
    }
    if prisms.is_empty() {
        return None;
    }
    let used: Vec<u32> = prisms.iter().flat_map(|(f, _)| f.iter().flatten().flatten().copied()).collect();
    let surfaces = json!([{ "type": "GroundSurface" }, { "type": "RoofSurface" }, { "type": "WallSurface" }]);
    let value = if let [(faces, sem)] = &prisms[..] {
        json!({ "type": "Solid", "lod": "1", "boundaries": [faces], "semantics": { "surfaces": surfaces, "values": [sem] } })
    } else {
        let faces: Vec<&Vec<Vec<u32>>> = prisms.iter().flat_map(|(f, _)| f).collect();
        let sem: Vec<u32> = prisms.iter().flat_map(|(_, s)| s.iter().copied()).collect();
        json!({ "type": "MultiSurface", "lod": "1", "boundaries": faces, "semantics": { "surfaces": surfaces, "values": sem } })
    };
    Some(Geometry { value, used })
}

/// The triangles of `meshes` as one LoD3 `MultiSurface`.
pub(super) fn lod3_surfaces(
    meshes: &[&MeshData],
    world: &impl Fn([f64; 3]) -> [f64; 3],
    pool: &mut VertexPool,
    to_out: &impl Fn([f64; 3]) -> [f64; 3],
) -> Option<Geometry> {
    let mut surfaces: Vec<[[u32; 3]; 1]> = Vec::new();
    let mut idx: Vec<Option<u32>> = Vec::new();
    for m in meshes {
        idx.clear();
        for p in m.positions.chunks_exact(3) {
            let w = world([m.origin[0] + p[0] as f64, m.origin[1] + p[1] as f64, m.origin[2] + p[2] as f64]);
            idx.push(pool.add(to_out(w)));
        }
        for t in m.indices.chunks_exact(3) {
            let tri = [idx[t[0] as usize], idx[t[1] as usize], idx[t[2] as usize]];
            if let [Some(a), Some(b), Some(c)] = tri {
                // Snapping can merge a sliver's vertices; such a triangle is no surface.
                if a != b && b != c && a != c {
                    surfaces.push([[a, b, c]]);
                }
            }
        }
    }
    if surfaces.is_empty() {
        return None;
    }
    let used = surfaces.iter().flat_map(|s| s[0]).collect();
    Some(Geometry { value: json!({ "type": "MultiSurface", "lod": "3", "boundaries": surfaces }), used })
}
