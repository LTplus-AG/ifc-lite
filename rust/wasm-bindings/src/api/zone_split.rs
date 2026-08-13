// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! WASM API: splitMeshByZones - cut one element into one closed solid per
//! location zone (issue #2508 item 2).
//!
//! The kernel side is `ifc_lite_geometry::zone_split`; this is the boundary.
//! Two things about the contract matter more than the shape:
//!
//! - **Everything is in the CALLER's frame.** The viewer passes render-frame
//!   positions (Y-up, RTC-subtracted, metres) and zone boxes authored against
//!   that same frame, so no conversion happens here and none is implied. The
//!   only axis assumption is that zone rotation is about Y, which is the
//!   viewer's own zone model.
//! - **Positions cross as f64.** The split's whole value over an AABB estimate
//!   is exactness, and a per-piece f64 -> f32 -> f64 round trip at this
//!   boundary would put a crack back into every shared zone plane. The caller
//!   narrows to f32 when it uploads to the GPU, once, at the end.

use ifc_lite_geometry::zone_split::{split_mesh_by_zones, ZoneBox, ZoneShape};
use wasm_bindgen::prelude::*;

/// One closed solid of a split element.
#[wasm_bindgen]
pub struct ZonePieceJs {
    zone: i32,
    positions: Vec<f64>,
    indices: Vec<u32>,
    volume: f64,
}

#[wasm_bindgen]
impl ZonePieceJs {
    /// Index into the zone array that was passed in, or `-1` for the part of
    /// the element inside no zone.
    #[wasm_bindgen(getter, js_name = zoneIndex)]
    pub fn zone_index(&self) -> i32 {
        self.zone
    }

    /// Flat `[x, y, z, ...]` in the caller's frame.
    #[wasm_bindgen(getter)]
    pub fn positions(&self) -> js_sys::Float64Array {
        js_sys::Float64Array::from(&self.positions[..])
    }

    /// Flat triangle indices into `positions`.
    #[wasm_bindgen(getter)]
    pub fn indices(&self) -> js_sys::Uint32Array {
        js_sys::Uint32Array::from(&self.indices[..])
    }

    /// Enclosed volume of this piece, cubic units of the caller's frame.
    #[wasm_bindgen(getter)]
    pub fn volume(&self) -> f64 {
        self.volume
    }
}

/// The result of splitting one element.
#[wasm_bindgen]
pub struct ZoneSplitJs {
    pieces: Vec<ZonePieceJs>,
    whole_volume: f64,
    sum_error_rel: f64,
}

#[wasm_bindgen]
impl ZoneSplitJs {
    #[wasm_bindgen(getter, js_name = pieceCount)]
    pub fn piece_count(&self) -> usize {
        self.pieces.len()
    }

    /// Piece `index`, or `undefined` when out of range. Each call COPIES the
    /// piece out, matching the rest of this API surface.
    pub fn piece(&self, index: usize) -> Option<ZonePieceJs> {
        self.pieces.get(index).map(|p| ZonePieceJs {
            zone: p.zone,
            positions: p.positions.clone(),
            indices: p.indices.clone(),
            volume: p.volume,
        })
    }

    /// Enclosed volume of the input element.
    #[wasm_bindgen(getter, js_name = wholeVolume)]
    pub fn whole_volume(&self) -> f64 {
        self.whole_volume
    }

    /// How far the pieces are from summing to the whole, relative.
    ///
    /// The invariant #2508 puts above everything else here. Exposed rather than
    /// enforced: the caller decides what to do with a split that does not add
    /// up (the expected cause is zones that overlap each other), and a number
    /// it can show beats a silent refusal.
    #[wasm_bindgen(getter, js_name = sumErrorRel)]
    pub fn sum_error_rel(&self) -> f64 {
        self.sum_error_rel
    }
}

/// Split a mesh into one closed solid per zone, plus the remainder.
///
/// `positions` is flat XYZ (f64, caller's frame), `indices` flat triangle
/// indices. `zones` is flat, SEVEN numbers per zone:
/// `[cx, cy, cz, sx, sy, sz, rotationY]`, where the sizes are FULL extents
/// (matching the viewer's `Zone.size`) and the rotation is radians about the
/// vertical axis. A trailing partial zone is ignored rather than guessed at.
///
/// A zone becomes a PRISM (#2508 item 4) when `footprint_counts[i]` is
/// non-zero: it then takes that many `[x, z]` pairs from `footprints`, in
/// order, and uses the 7-tuple only for its vertical extent
/// (`cy +/- sy/2`). The footprint must be CONVEX; the viewer gates that on
/// import, because a concave polygon fans into overlapping triangles and would
/// cut wrong rather than fail. Passing empty arrays keeps every zone a box.
///
/// The caller must have established that the mesh is a closed orientable solid
/// first, exactly as it must before quoting a volume at all (#1891/#1993): a
/// clip of an open shell produces pieces whose volumes are arbitrary rather
/// than approximate.
///
/// A triangle with an out-of-range index or a non-finite coordinate is DROPPED
/// rather than reported, matching `kernel::mesh_bridge::mesh_to_tris`, which is
/// panic-free for the same reason: the alternative is a crash deep in the
/// predicates. It does mean a malformed caller can open the surface and get
/// meaningless volumes with a plausible `sumErrorRel`, so the closure proof
/// above is the caller's responsibility and not a formality.
///
/// ```javascript
/// const split = splitMeshByZones(positions, indices, new Float64Array([
///   0, 0, 0, 10, 10, 10, 0,
/// ]));
/// for (let i = 0; i < split.pieceCount; i++) {
///   const piece = split.piece(i);
///   // piece.zoneIndex, piece.positions, piece.indices, piece.volume
///   piece.free();
/// }
/// split.free();
/// ```
#[wasm_bindgen(js_name = splitMeshByZones)]
pub fn split_mesh_by_zones_js(
    positions: &[f64],
    indices: &[u32],
    zones: &[f64],
    footprints: Option<Vec<f64>>,
    footprint_counts: Option<Vec<u32>>,
) -> ZoneSplitJs {
    let tris: Vec<[[f64; 3]; 3]> = indices
        .chunks_exact(3)
        .filter_map(|c| {
            let vertex = |i: u32| -> Option<[f64; 3]> {
                let b = (i as usize) * 3;
                let p = [
                    *positions.get(b)?,
                    *positions.get(b + 1)?,
                    *positions.get(b + 2)?,
                ];
                p.iter().all(|v| v.is_finite()).then_some(p)
            };
            Some([vertex(c[0])?, vertex(c[1])?, vertex(c[2])?])
        })
        .collect();

    let footprints = footprints.unwrap_or_default();
    let counts = footprint_counts.unwrap_or_default();
    let mut cursor = 0usize;
    let shapes: Vec<ZoneShape> = zones
        .chunks_exact(7)
        .enumerate()
        .map(|(i, z)| {
            let points = counts.get(i).copied().unwrap_or(0) as usize;
            let start = cursor * 2;
            let end = start + points * 2;
            cursor += points;
            // A count that runs past the buffer is a caller bug; falling back to
            // the box rather than panicking keeps one malformed zone from
            // taking down the whole split.
            if points >= 3 && end <= footprints.len() {
                ZoneShape::Prism {
                    footprint: footprints[start..end]
                        .chunks_exact(2)
                        .map(|p| [p[0], p[1]])
                        .collect(),
                    min_y: z[1] - z[4] / 2.0,
                    max_y: z[1] + z[4] / 2.0,
                }
            } else {
                ZoneShape::Box(ZoneBox {
                    center: [z[0], z[1], z[2]],
                    size: [z[3], z[4], z[5]],
                    rotation_y: z[6],
                })
            }
        })
        .collect();

    let split = split_mesh_by_zones(&tris, &shapes);
    let sum_error_rel = split.sum_error_rel();
    let pieces = split
        .pieces
        .into_iter()
        .map(|p| {
            let mut flat = Vec::with_capacity(p.tris.len() * 9);
            let mut idx = Vec::with_capacity(p.tris.len() * 3);
            for t in &p.tris {
                let base = (flat.len() / 3) as u32;
                for v in t {
                    flat.extend_from_slice(v);
                }
                idx.extend_from_slice(&[base, base + 1, base + 2]);
            }
            ZonePieceJs {
                zone: p.zone.map_or(-1, |z| z as i32),
                positions: flat,
                indices: idx,
                volume: p.volume,
            }
        })
        .collect();

    ZoneSplitJs {
        pieces,
        whole_volume: split.whole_volume,
        sum_error_rel,
    }
}
