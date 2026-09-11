/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Half-edge walking iterators over a [`SpacePlate`]: one face cycle, and
//! the outgoing fan around a vertex. Split out of `mod.rs` for the
//! module-size ratchet; `SpacePlate::face_half_edges` / `vertex_fan`
//! construct them.

use super::{HalfEdgeId, SpacePlate};

/// Iterator over the half-edges of one face cycle.
pub(super) struct FaceWalk<'a> {
    pub(super) plate: &'a SpacePlate,
    pub(super) start: Option<HalfEdgeId>,
    pub(super) cur: Option<HalfEdgeId>,
}

impl Iterator for FaceWalk<'_> {
    type Item = HalfEdgeId;
    fn next(&mut self) -> Option<HalfEdgeId> {
        let start = self.start?;
        let cur = match self.cur {
            None => start,
            Some(c) => {
                let n = self.plate.half_edges[c.0 as usize].next;
                if n == start {
                    return None;
                }
                n
            }
        };
        self.cur = Some(cur);
        Some(cur)
    }
}

/// Iterator over the outgoing half-edges around a vertex (twin → next).
pub(super) struct VertexFan<'a> {
    pub(super) plate: &'a SpacePlate,
    pub(super) start: Option<HalfEdgeId>,
    pub(super) cur: Option<HalfEdgeId>,
}

impl Iterator for VertexFan<'_> {
    type Item = HalfEdgeId;
    fn next(&mut self) -> Option<HalfEdgeId> {
        let start = self.start?;
        loop {
            let cur = match self.cur {
                None => start,
                Some(c) => {
                    // Around a vertex: twin (incoming) then its next (outgoing).
                    let twin = self.plate.half_edges[c.0 as usize].twin;
                    let n = self.plate.half_edges[twin.0 as usize].next;
                    if n == start {
                        return None;
                    }
                    n
                }
            };
            self.cur = Some(cur);
            if self.plate.half_edges[cur.0 as usize].alive {
                return Some(cur);
            }
            if cur == start {
                return None;
            }
        }
    }
}
