// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Shared helper functions for geometry processors.
//!
//! The face types and the polyloop reader the surface-model processors share.
//! Placements and directions are not read here: they go through
//! `crate::placement::Axis2Placement` and `EntityDecoder::direction3`.

use crate::Point3;
use ifc_lite_core::EntityDecoder;

/// Face data extracted from IFC for parallel triangulation
pub(super) struct FaceData {
    pub(super) outer_points: Vec<Point3<f64>>,
    pub(super) hole_points: Vec<Vec<Point3<f64>>>,
}

/// Triangulated face result
pub(super) struct FaceResult {
    pub(super) positions: Vec<f32>,
    pub(super) indices: Vec<u32>,
    /// The face was refused (empty, never an approximation) and the caller
    /// counts it on its own thread: this runs under rayon (#7686, D3).
    pub(super) refused: bool,
}

/// Append `points` as f32 positions after subtracting `rtc` in f64, so
/// national-grid coordinates narrow near the origin (#5698).
#[inline]
pub(super) fn push_rebased<'a>(
    positions: &mut Vec<f32>,
    points: impl IntoIterator<Item = &'a Point3<f64>>,
    rtc: (f64, f64, f64),
) {
    for p in points {
        positions.push((p.x - rtc.0) as f32);
        positions.push((p.y - rtc.1) as f32);
        positions.push((p.z - rtc.2) as f32);
    }
}

/// Every point of an `IfcPolyLoop`, however few. `None` means the loop or
/// one of its points does not decode, which is not a loop of under three
/// points; a face bound reader refuses the face on the former and skips the
/// latter (#7687, #7686, D14). Shared by the surface-model processors and the
/// advanced-face bound reader.
pub(super) fn read_loop_points_by_id(
    loop_id: u32,
    decoder: &mut EntityDecoder,
) -> Option<Vec<Point3<f64>>> {
    let point_ids = decoder.get_polyloop_point_ids_fast(loop_id)?;

    let mut points = Vec::with_capacity(point_ids.len());
    for point_id in point_ids {
        let [x, y, z] = decoder.point3(point_id).ok()?;
        points.push(Point3::new(x, y, z));
    }
    Some(points)
}

/// Most distinct points one [`PointMemo`] keeps: about 2-4 MB of table at the
/// limit, whatever the face set's size. Past it, new points are read uncached
/// (never refused), so a model with millions of distinct points keeps the old
/// per-read cost for the excess instead of a table that grows with the model.
pub(super) const POINT_MEMO_CAP: usize = 1 << 16;

/// Points already read by [`EntityDecoder::point3_fast`] during ONE walk over
/// ONE decoder, by express id. Scoped by its owner (a surface-model lowering)
/// and dropped with it, so it is never a cache across sources or jobs, and
/// bounded by [`POINT_MEMO_CAP`]. Only points of loops that read completely are
/// kept: a loop a later point rejects takes its new entries back out.
#[derive(Default)]
pub(super) struct PointMemo {
    points: rustc_hash::FxHashMap<u32, [f64; 3]>,
    /// Ids this loop added, removed again if the loop is rejected.
    pending: Vec<u32>,
}

#[cfg(test)]
impl PointMemo {
    /// Entries kept.
    pub(super) fn len(&self) -> usize {
        self.points.len()
    }

    pub(super) fn contains_key(&self, id: &u32) -> bool {
        self.points.contains_key(id)
    }
}

/// [`read_loop_points_by_id`], reusing points this walk already read. Same
/// result and the same refusals: a memo entry is only ever `point3_fast`'s
/// `Some`, which is exactly what `point3` returns for that id, and any id the
/// fast path cannot read goes through `point3` itself, every time, in order.
pub(super) fn read_loop_points_memo(
    loop_id: u32,
    decoder: &mut EntityDecoder,
    memo: &mut PointMemo,
) -> Option<Vec<Point3<f64>>> {
    let point_ids = decoder.get_polyloop_point_ids_fast(loop_id)?;

    memo.pending.clear();
    let mut points = Vec::with_capacity(point_ids.len());
    for point_id in point_ids {
        let [x, y, z] = match memo.points.get(&point_id) {
            Some(&point) => point,
            None => {
                // Test builds count the reads the memo could not serve.
                #[cfg(test)]
                super::tests::note_point_read();
                match decoder.point3_fast(point_id) {
                    Some(point) => {
                        if memo.points.len() < POINT_MEMO_CAP && memo.points.insert(point_id, point).is_none() {
                            memo.pending.push(point_id);
                        }
                        point
                    }
                    None => match decoder.point3(point_id) {
                        Ok(point) => point,
                        Err(_) => {
                            // Rejected: this loop's new entries go back out.
                            for id in memo.pending.drain(..) {
                                memo.points.remove(&id);
                            }
                            return None;
                        }
                    },
                }
            }
        };
        points.push(Point3::new(x, y, z));
    }
    memo.pending.clear();
    Some(points)
}
