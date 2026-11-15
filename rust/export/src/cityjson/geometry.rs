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
use super::footprint::signed_area2;
use super::vertices::{split_ring_by, VertexPool};

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

/// Twice the signed planimetric area of a placed ring.
fn placed_area2(ring: &PlacedRing) -> f64 {
    let pts: Vec<[f64; 2]> = ring.iter().map(|(_, p)| *p).collect();
    signed_area2(&pts)
}

/// Even-odd point-in-ring test on planimetric positions.
fn inside(p: [f64; 2], ring: &PlacedRing) -> bool {
    let mut odd = false;
    let n = ring.len();
    for k in 0..n {
        let (a, b) = (ring[k].1, ring[(k + 1) % n].1);
        if (a[1] > p[1]) != (b[1] > p[1]) && p[0] < a[0] + (p[1] - a[1]) / (b[1] - a[1]) * (b[0] - a[0]) {
            odd = !odd;
        }
    }
    odd
}

/// A footprint polygon at one height as valid polygons on the snapped grid,
/// each a list of rings (exterior first) of pool indices with their
/// planimetric positions. `to_out` maps an IFC world point to output
/// coordinates.
///
/// A ring that touches itself at a vertex (a pinch, from the union output
/// or from snapping) is split there ([`split_ring_by`]) instead of dropped:
/// an exterior's loops of its own orientation are separate polygons (two
/// lobes meeting at a point), its loops of the opposite orientation are
/// holes touching it; a hole's loops are holes. A hole loop is placed in the
/// polygon whose exterior contains it. A loop of the wrong orientation for
/// its role that encloses area (an island inside a hole) cannot be written
/// in the polygon and is counted in `dropped`, like a hole outside every
/// exterior, and like a loop with area that snaps to a collinear ring on
/// the output grid; loops without area (spikes, rings collapsed by
/// snapping) are not.
fn polygons_at(
    shape: &[Vec<[f64; 2]>],
    z: f64,
    pool: &mut VertexPool,
    to_out: &impl Fn([f64; 3]) -> [f64; 3],
    min_area2: f64,
    dropped: &mut usize,
) -> Vec<Vec<PlacedRing>> {
    let mut exteriors: Vec<PlacedRing> = Vec::new();
    let mut holes: Vec<PlacedRing> = Vec::new();
    for (i, ring) in shape.iter().enumerate() {
        let Some(placed) = ring.iter().map(|p| pool.add(to_out([p[0], p[1], z])).map(|ix| (ix, *p))).collect::<Option<PlacedRing>>() else {
            *dropped += usize::from(signed_area2(ring).abs() > min_area2);
            continue;
        };
        for lp in split_ring_by(&placed, |(ix, _)| *ix) {
            let a = placed_area2(&lp);
            if a.abs() <= min_area2 {
                continue;
            }
            // Validity and orientation are judged on the snapped grid the
            // ring is written on: a sliver with area in IFC coordinates can
            // snap to a collinear ring, which is no valid surface. Such a
            // ring is dropped, and counted because it had area.
            let ixs: Vec<u32> = lp.iter().map(|(ix, _)| *ix).collect();
            let g = pool.grid_area2(&ixs);
            if g == 0 {
                *dropped += 1;
                continue;
            }
            // Exteriors are counter-clockwise, holes clockwise (footprint.rs).
            match (i == 0, g > 0) {
                (true, true) => exteriors.push(lp),
                (_, false) => holes.push(lp),
                (false, true) => *dropped += 1,
            }
        }
    }
    let mut polygons: Vec<Vec<PlacedRing>> = exteriors.into_iter().map(|e| vec![e]).collect();
    for hole in holes {
        // A vertex of a hole may lie on its exterior (they touch); the
        // midpoint of an edge between two of its vertices that are not
        // shared with that exterior is strictly inside.
        let probe = |poly: &Vec<PlacedRing>| {
            (0..hole.len()).any(|k| {
                let (a, b) = (hole[k].1, hole[(k + 1) % hole.len()].1);
                let m = [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0];
                inside(m, &poly[0])
            })
        };
        match polygons.iter_mut().find(|poly| probe(poly)) {
            Some(poly) => poly.push(hole),
            None => *dropped += 1,
        }
    }
    polygons
}

fn indices(rings: &[PlacedRing]) -> Vec<Vec<u32>> {
    rings.iter().map(|r| r.iter().map(|(ix, _)| *ix).collect()).collect()
}

/// The LoD0 footprint.
///
/// `min_area2` is twice the smallest ring area worth keeping (planimetric,
/// IFC metres²); `dropped` counts rings with area that could not be written.
pub(super) fn lod0(fp: &Footprint, pool: &mut VertexPool, to_out: &impl Fn([f64; 3]) -> [f64; 3], min_area2: f64, dropped: &mut usize) -> Option<Geometry> {
    let surfaces: Vec<Vec<Vec<u32>>> = fp.shapes.iter()
        .flat_map(|s| polygons_at(s, fp.z_min, pool, to_out, min_area2, dropped))
        .map(|r| indices(&r))
        .collect();
    if surfaces.is_empty() {
        return None;
    }
    let used = surfaces.iter().flatten().flatten().copied().collect();
    Some(Geometry { value: json!({ "type": "MultiSurface", "lod": "0", "boundaries": surfaces }), used })
}

const GROUND: u32 = 0;
const ROOF: u32 = 1;
const WALL: u32 = 2;

/// The LoD1 block; `None` when the outline or the height collapses on the
/// grid. The polygons are those of [`lod0`] (same splitting, same `dropped`
/// semantics), one prism each.
pub(super) fn lod1(fp: &Footprint, pool: &mut VertexPool, to_out: &impl Fn([f64; 3]) -> [f64; 3], min_area2: f64, dropped: &mut usize) -> Option<Geometry> {
    let mut prisms: Vec<Prism> = Vec::new();
    let polygons: Vec<Vec<PlacedRing>> = fp.shapes.iter().flat_map(|s| polygons_at(s, fp.z_min, pool, to_out, min_area2, dropped)).collect();
    for rings in polygons {
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
                // Snapping can merge a sliver's vertices or put them on one
                // grid line; such a triangle is no surface.
                if a != b && b != c && a != c && !pool.collinear(a, b, c) {
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
