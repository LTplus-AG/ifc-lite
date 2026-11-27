// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Compact GPU-layout encoding of a batch's flat meshes.
//!
//! [`MeshCollection::encode_compact`] turns every eligible mesh into the
//! renderer's final 12-byte quantized vertex records (`quantize.ts`: u16
//! x, y, z, a u16 oct-encoded normal, a u32 entity lane), so neither the
//! geometry worker nor the main thread has to walk a vertex again:
//!
//! - positions snap to a lattice of step 2^-L m in the collection's frame
//!   (f64 `origin + position`: Y-up and relative to the collection's RTC
//!   offset; L = 10 is the renderer's `QUANT_STEP`) and are stored as u16
//!   offsets from the lattice-aligned window of the mesh's cell. Every mesh of
//!   one level and cell shares one window, so a GPU buffer for that level and
//!   cell is the plain concatenation of its meshes' records;
//! - vertices are WELDED on their lattice node, so a flat-shaded element no
//!   longer duplicates a vertex per incident face. The renderer derives the
//!   face normal from screen-space derivatives (`main.wgsl.ts`) and uses the
//!   vertex normal only to orient its sign, so the record keeps the oct-encoded
//!   SUM of the welded corners' normals, and nodes whose corners face opposite
//!   sides are kept apart (see `mesh_compact_weld.rs`);
//! - indices are mesh-local u16, with triangles that collapse to a repeated
//!   node dropped;
//! - each mesh's f64 AABB in that frame rides along, so no consumer scans
//!   positions.
//!
//! Precision: a stored position is at most half a step from its source on each
//! axis: 0.49 mm at level 10, 0.98 mm at level 9 (meshes too wide for a level
//! 10 window), and finer at levels 11 to 14 (meshes the level 10 lattice would
//! collapse or crumple, the renderer's #9068 and #11444 rule).
//!
//! Encoded meshes have their positions, normals and indices taken (emptied),
//! so the per-mesh getters copy nothing for them. A mesh that cannot encode is
//! left untouched and counted under its [`Refusal`]; the caller keeps it on the
//! f32 path.
//!
//! Rows are sorted by (base-level cell, colour, finish), which keeps the
//! meshes of one GPU bucket together. A row's window is named by its level AND
//! cell: a mesh that moved to another level carries that level's cell index,
//! so consumers group rows by (level, cell, colour), never by cell alone.

use super::{MeshCollection, MeshDataJs};
use wasm_bindgen::prelude::*;

#[path = "mesh_compact_weld.rs"]
mod weld;
use weld::{round_half_up, sort_indices, weld_mesh, Scratch};

/// Base lattice level: step 2^-10 m, the renderer's `QUANT_STEP`. A mesh that
/// collapses on it retries at the finer levels (smaller step, proportionally
/// smaller cells and windows); one too wide for its window retries one level
/// coarser. Every level keeps 12-byte records and u16 offsets.
const BASE_LEVEL: u32 = 10;
const FINER_LEVELS: [u32; 4] = [11, 12, 13, 14];
const COARSER_LEVEL: u32 = 9;

fn step_of(level: u32) -> f64 {
    1.0 / (1u64 << level) as f64
}

/// u16 range of one window, in lattice steps.
const Q_MAX: i64 = 65535;
/// Highest picking id the 24-bit entity lane carries (`packEntityLane`).
const MAX_LANE_ID: u32 = 0x00FF_FFFF;
/// Cell sizes `encode_compact` accepts: two base steps, up to half a base window (rounded up: a
/// mesh exactly as wide as a 32 m cell can miss its window by a step and move one level coarser).
const MIN_CELL_METRES: f64 = 1.0 / 512.0;
const MAX_CELL_METRES: f64 = 32.0;
/// Bytes per vertex record.
const RECORD_BYTES: usize = 12;
/// u32 columns per table row.
const TABLE_STRIDE: usize = 6;

/// Why a mesh stayed on the f32 path. The discriminant indexes
/// `CompactBatch::refusals`; the TypeScript side names the columns in this
/// order, so append, never reorder.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Refusal {
    /// Carries texture coordinates or a texture reference.
    Textured = 0,
    /// Fewer than three vertices or indices, or no triangle left after welding.
    Empty = 1,
    /// A non-finite coordinate or normal.
    NonFinite = 2,
    /// Express id past the 24-bit entity lane.
    IdRange = 3,
    /// Wider than the base level's and the coarser level's window, or outside the i32 cell range.
    Extent = 4,
    /// More welded vertices than u16 indices address.
    WeldedVertices = 5,
    /// Loses more than 1% of its area to triangles the lattice collapses, or 5% to faces it turns past 20°: at the base level with
    /// no finer level holding it (whatever stops the retry there, the collapse is why it left the
    /// base level), or at the coarser level for a mesh too wide for the base window.
    Collapse = 6,
    /// No per-vertex normals, or corners no stored normal can witness.
    Normals = 7,
    /// An index past the vertex count.
    IndexRange = 8,
}
const REFUSAL_KINDS: usize = 9;

/// One batch's compact records, returned by [`MeshCollection::encode_compact`].
/// Every getter copies its column into a new typed array.
#[wasm_bindgen]
#[derive(Default)]
pub struct CompactBatch {
    records: Vec<u8>,
    indices: Vec<u16>,
    table: Vec<u32>,
    /// Window origins are integers held as f64 (exact below 2^53).
    windows: Vec<f64>,
    bounds: Vec<f64>,
    cells: Vec<i32>,
    totals: [f64; 4],
    refusals: [u32; REFUSAL_KINDS],
}

#[wasm_bindgen]
impl CompactBatch {
    /// Number of encoded meshes (table rows).
    #[wasm_bindgen(getter, js_name = meshCount)]
    pub fn mesh_count(&self) -> usize {
        self.table.len() / TABLE_STRIDE
    }
    /// 12 bytes per welded vertex: u16 x, y, z offsets, u16 oct normal, u32 entity lane.
    #[wasm_bindgen(getter)]
    pub fn records(&self) -> js_sys::Uint8Array {
        js_sys::Uint8Array::from(&self.records[..])
    }
    /// Mesh-local u16 triangle indices.
    #[wasm_bindgen(getter)]
    pub fn indices(&self) -> js_sys::Uint16Array {
        js_sys::Uint16Array::from(&self.indices[..])
    }
    /// Six u32 per encoded mesh: mesh index in the collection, vertex start,
    /// vertex count, index start, index count, lattice level (step = 2^-level m).
    #[wasm_bindgen(getter)]
    pub fn table(&self) -> js_sys::Uint32Array {
        js_sys::Uint32Array::from(&self.table[..])
    }
    /// Three f64 per encoded mesh: its window origin in units of its level's step.
    #[wasm_bindgen(getter)]
    pub fn windows(&self) -> js_sys::Float64Array {
        js_sys::Float64Array::from(&self.windows[..])
    }
    /// Six f64 per encoded mesh: its AABB in the collection's frame (Y-up,
    /// RTC-relative `origin + position`), min x, y, z then max x, y, z.
    #[wasm_bindgen(getter)]
    pub fn bounds(&self) -> js_sys::Float64Array {
        js_sys::Float64Array::from(&self.bounds[..])
    }
    /// Three i32 per encoded mesh: its cell indices at its level.
    #[wasm_bindgen(getter)]
    pub fn cells(&self) -> js_sys::Int32Array {
        js_sys::Int32Array::from(&self.cells[..])
    }
    /// `[inVertices, inTriangles, outVertices, outTriangles]` over the encoded meshes.
    #[wasm_bindgen(getter)]
    pub fn totals(&self) -> js_sys::Float64Array {
        js_sys::Float64Array::from(&self.totals[..])
    }
    /// Meshes left on the f32 path, by reason: textured, empty, non-finite, id
    /// range, extent, welded vertices, collapse, normals, index range.
    #[wasm_bindgen(getter)]
    pub fn refusals(&self) -> js_sys::Uint32Array {
        js_sys::Uint32Array::from(&self.refusals[..])
    }
}

/// The renderer's `colorSaltByte` (scene-geometry.ts), bit for bit.
fn color_salt(color: &[f32; 4]) -> u32 {
    let byte = |c: f32| -> i32 { (round_half_up(c as f64 * 255.0) as i64 & 0xFF) as i32 };
    let h = (byte(color[0]).wrapping_mul(73_856_093)
        ^ byte(color[1]).wrapping_mul(19_349_663)
        ^ byte(color[2]).wrapping_mul(83_492_791)) as u32;
    h & 0xFF
}

/// The renderer's `octEncode` (quantize.ts), packed `(bx << 8) | by`.
fn oct_encode(nx: f64, ny: f64, nz: f64) -> u16 {
    let l1 = nx.abs() + ny.abs() + nz.abs();
    let (mut ox, mut oy) = (0.0, 0.0);
    if l1 >= 1e-12 {
        ox = nx / l1;
        oy = ny / l1;
        if nz < 0.0 {
            let tx = (1.0 - oy.abs()) * if ox >= 0.0 { 1.0 } else { -1.0 };
            let ty = (1.0 - ox.abs()) * if oy >= 0.0 { 1.0 } else { -1.0 };
            ox = tx;
            oy = ty;
        }
    }
    let to_byte = |v: f64| -> u16 { round_half_up((v * 0.5 + 0.5) * 255.0).clamp(0.0, 255.0) as u16 };
    (to_byte(ox) << 8) | to_byte(oy)
}

/// Sort key grouping a batch's meshes by GPU bucket (cell, colour, finish).
fn bucket_sort_key(cell: [i32; 3], mesh: &MeshDataJs) -> ([i32; 3], [u32; 6]) {
    let q = |v: f32| round_half_up(v as f64 * 1000.0) as i64 as u32;
    let c = &mesh.color;
    let m = mesh.metallic.map_or(u32::MAX, q);
    let r = mesh.roughness.map_or(u32::MAX, q);
    (cell, [q(c[0]), q(c[1]), q(c[2]), q(c[3]), m, r])
}

/// AABB of a mesh the encoder may take, in the collection's frame (f64 `origin +
/// position`, Y-up, RTC-relative), or the refusal.
fn frame_bounds(mesh: &MeshDataJs) -> Result<[f64; 6], Refusal> {
    if !mesh.uvs.is_empty() || mesh.texture_id != 0 || mesh.texture_url.is_some() {
        return Err(Refusal::Textured);
    }
    if mesh.positions.len() < 9 || mesh.indices.len() < 3 {
        return Err(Refusal::Empty);
    }
    if mesh.normals.len() != mesh.positions.len() {
        return Err(Refusal::Normals);
    }
    if mesh.express_id > MAX_LANE_ID {
        return Err(Refusal::IdRange);
    }
    let o = mesh.origin;
    let mut b = [f64::INFINITY, f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    for (p, n) in mesh.positions.chunks_exact(3).zip(mesh.normals.chunks_exact(3)) {
        for axis in 0..3 {
            let w = o[axis] + p[axis] as f64;
            // A non-finite normal would poison its node's sum and oct-encode to garbage.
            if !w.is_finite() || !n[axis].is_finite() {
                return Err(Refusal::NonFinite);
            }
            b[axis] = b[axis].min(w);
            b[axis + 3] = b[axis + 3].max(w);
        }
    }
    Ok(b)
}

/// The cell that holds the box's minimum corner, and that cell's window origin
/// in lattice steps. Cell `c` spans `[c·cell − cell/2, c·cell + cell/2)` and
/// its window starts at the same corner, `Q_MAX` steps wide; `cell_q` is the
/// cell size in steps (the same at every level).
fn cell_window(bounds: &[f64; 6], cell_q: i64, step: f64) -> Result<([i32; 3], [i64; 3]), Refusal> {
    let half_q = cell_q / 2;
    let mut cell = [0i32; 3];
    let mut window = [0i64; 3];
    for axis in 0..3 {
        let c = ((bounds[axis] / step + half_q as f64) / cell_q as f64).floor();
        if !(c.abs() <= i32::MAX as f64) {
            return Err(Refusal::Extent);
        }
        cell[axis] = c as i32;
        window[axis] = c as i64 * cell_q - half_q;
        // Absolute node first, then the integer window, as `weld_mesh` places each vertex.
        let lo = round_half_up(bounds[axis] / step) as i64 - window[axis];
        let hi = round_half_up(bounds[axis + 3] / step) as i64 - window[axis];
        if lo < 0 || hi > Q_MAX {
            return Err(Refusal::Extent);
        }
    }
    Ok((cell, window))
}

/// Where a mesh landed: its lattice level, cell and window.
struct Fit {
    level: u32,
    cell: [i32; 3],
    window: [i64; 3],
}

/// Weld `mesh` at the first level that holds it, or the refusal: the base level, then one coarser
/// when the mesh is too wide for its window, or the finer ones while the lattice collapses it.
fn fit_mesh(mesh: &MeshDataJs, bounds: &[f64; 6], cell_q: i64, s: &mut Scratch) -> Result<Fit, Refusal> {
    let mut level = BASE_LEVEL;
    let mut finer = FINER_LEVELS.iter();
    // One call site for the weld: the optimizer otherwise inlines the whole pass once per level branch.
    loop {
        let step = step_of(level);
        let attempt = cell_window(bounds, cell_q, step).and_then(|(cell, window)| {
            weld_mesh(mesh, window, step, s)?;
            Ok(Fit { level, cell, window })
        });
        level = match attempt {
            Err(Refusal::Extent) if level == BASE_LEVEL => COARSER_LEVEL,
            Err(Refusal::Collapse) if level >= BASE_LEVEL => match finer.next() {
                Some(&next) => next,
                None => return Err(Refusal::Collapse),
            },
            // A finer level is only tried for a collapse, which stays the reason whatever stops the retry.
            Err(_) if level > BASE_LEVEL => return Err(Refusal::Collapse),
            other => return other,
        };
    }
}

impl CompactBatch {
    /// Append one welded mesh's records, indices and table row.
    fn commit(&mut self, index: usize, mesh: &MeshDataJs, fit: &Fit, bounds: [f64; 6], s: &Scratch) {
        let vertex_start = (self.records.len() / RECORD_BYTES) as u32;
        let index_start = self.indices.len() as u32;
        let lane = (mesh.express_id & MAX_LANE_ID) | (color_salt(&mesh.color) << 24);
        self.records.reserve(s.nodes.len() * RECORD_BYTES);
        for (q, n) in s.nodes.iter().zip(&s.normal_sums) {
            for c in q {
                self.records.extend_from_slice(&c.to_le_bytes());
            }
            self.records.extend_from_slice(&oct_encode(n[0], n[1], n[2]).to_le_bytes());
            self.records.extend_from_slice(&lane.to_le_bytes());
        }
        self.indices.extend_from_slice(&s.tris);
        self.table.extend_from_slice(&[index as u32, vertex_start, s.nodes.len() as u32, index_start, s.tris.len() as u32, fit.level]);
        self.windows.extend(fit.window.iter().map(|&w| w as f64));
        self.bounds.extend_from_slice(&bounds);
        self.cells.extend_from_slice(&fit.cell);
        self.totals[0] += (mesh.positions.len() / 3) as f64;
        self.totals[1] += (mesh.indices.len() / 3) as f64;
        self.totals[2] += s.nodes.len() as f64;
        self.totals[3] += (s.tris.len() / 3) as f64;
    }
}

#[wasm_bindgen]
impl MeshCollection {
    /// Encode every eligible mesh into compact GPU records (see the module
    /// docs) and empty its vertex arrays. `cell_size` is the spatial cell size
    /// in metres at the base level (step 2^-10 m), snapped to that lattice;
    /// it must lie in [2^-9, 32] m so a window (65,535 steps) holds any mesh
    /// that starts in its cell and is narrower than the cell. Outside that
    /// range nothing is encoded and the collection is left as it was.
    #[wasm_bindgen(js_name = encodeCompact)]
    pub fn encode_compact(&mut self, cell_size: f64) -> CompactBatch {
        let mut batch = CompactBatch::default();
        let base_step = step_of(BASE_LEVEL);
        // Judge the argument itself, not its snapped value: 0.0015 would round up into range.
        if !(cell_size >= MIN_CELL_METRES && cell_size <= MAX_CELL_METRES) {
            return batch;
        }
        let cell_q = round_half_up(cell_size / base_step) as i64;
        // (bucket key, mesh index, box) per candidate, visited in key order.
        let mut plan = Vec::new();
        for (i, mesh) in self.meshes.iter().enumerate() {
            match frame_bounds(mesh) {
                Ok(b) => {
                    // The base-level cell; a mesh that changes level later only splits a run.
                    let cell = cell_window(&b, cell_q, base_step).map_or([i32::MAX; 3], |(c, _)| c);
                    plan.push((bucket_sort_key(cell, mesh), i, b));
                }
                Err(r) => batch.refusals[r as usize] += 1,
            }
        }
        let mut order: Vec<u32> = (0..plan.len() as u32).collect();
        sort_indices(&mut order, |a, b| (&plan[a as usize].0, a) < (&plan[b as usize].0, b));
        let mut scratch = Scratch::default();
        for at in order {
            let (_, i, bounds) = plan[at as usize];
            let mesh = &mut self.meshes[i];
            match fit_mesh(mesh, &bounds, cell_q, &mut scratch) {
                Ok(fit) => {
                    batch.commit(i, mesh, &fit, bounds, &scratch);
                    mesh.positions = Vec::new();
                    mesh.normals = Vec::new();
                    mesh.indices = Vec::new();
                }
                Err(r) => batch.refusals[r as usize] += 1,
            }
        }
        batch
    }
}

#[cfg(test)]
#[path = "mesh_compact_tests.rs"]
mod tests;
