// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Removal edits on a [`SpacePlate`]: spur and edge deletion plus the orphan
//! sweep that cleans up after them. Split out of `mod.rs` for the module-size
//! ratchet; the construction, split/merge/dissolve edits and queries stay there.

use super::{EditError, FacePatch, HalfEdgeId, SpacePlate, VertexId, EPS_COLL};
use super::geom2d::perp_distance;

impl SpacePlate {
    /// Live degree of a vertex (its number of live outgoing half-edges).
    pub(super) fn vertex_degree(&self, v: VertexId) -> usize {
        let vi = v.0 as usize;
        if vi >= self.vertices.len() || !self.vertices[vi].alive {
            return 0;
        }
        self.outgoing_half_edges(v).count()
    }

    /// Remove the undirected edge of a **degree-1 spur tip** — a dangling wall
    /// poking into a face — splicing the face cycle closed and tombstoning the
    /// tip. `spur_he` may be either half-edge of the spur. Internal; driven by
    /// `prune_orphans` / `remove_edge`. Area-neutral: the tip's out-and-back
    /// boundary contributes cancelling shoelace terms, so no face area changes.
    pub(super) fn remove_spur_edge(&mut self, spur_he: HalfEdgeId) -> Result<(), EditError> {
        let hi = spur_he.0 as usize;
        if hi >= self.half_edges.len() || !self.half_edges[hi].alive {
            return Err(EditError::StaleHandle);
        }
        let t = self.half_edges[hi].twin;
        // Orient so `s = T→J` (origin is the degree-1 tip) and `s_t = J→T`.
        let (s, s_t) = if self.vertex_degree(self.half_edges[hi].origin) == 1 {
            (spur_he, t)
        } else if self.vertex_degree(self.half_edges[t.0 as usize].origin) == 1 {
            (t, spur_he)
        } else {
            return Err(EditError::VertexNotDissolvable); // neither end is a tip
        };
        let tip = self.half_edges[s.0 as usize].origin;
        let j = self.half_edges[s_t.0 as usize].origin;
        let f = self.half_edges[s.0 as usize].face;
        // A genuine tip is a peninsula: both half-edges share one face and the
        // rotation at the tip is the out-and-back pattern. Else it's corrupt.
        if self.half_edges[s_t.0 as usize].face != f
            || self.half_edges[s_t.0 as usize].next != s
            || self.half_edges[s.0 as usize].prev != s_t
        {
            return Err(EditError::StaleHandle);
        }
        let a = self.half_edges[s_t.0 as usize].prev; // ends at J
        let b = self.half_edges[s.0 as usize].next; // starts at J

        if a == s {
            // Lone stick: J is degree-1 too — the whole 2-vertex component is just
            // this edge bounding one outer face. Tombstone the lot.
            if !self.faces[f.0 as usize].is_outer {
                return Err(EditError::StaleHandle); // a lone stick can't bound a room
            }
            self.half_edges[s.0 as usize].alive = false;
            self.half_edges[s_t.0 as usize].alive = false;
            self.vertices[tip.0 as usize].outgoing = None;
            self.vertices[tip.0 as usize].alive = false;
            self.vertices[j.0 as usize].outgoing = None;
            self.vertices[j.0 as usize].alive = false;
            self.faces[f.0 as usize].alive = false;
            self.faces[f.0 as usize].half_edge = None;
            return Ok(());
        }

        // Splice the spur out of F's cycle: A → B directly.
        self.half_edges[a.0 as usize].next = b;
        self.half_edges[b.0 as usize].prev = a;
        self.half_edges[s.0 as usize].alive = false;
        self.half_edges[s_t.0 as usize].alive = false;
        self.vertices[tip.0 as usize].outgoing = None;
        self.vertices[tip.0 as usize].alive = false;
        self.repair_vertex_outgoing(j, s_t);
        if matches!(self.faces[f.0 as usize].half_edge, Some(h) if h == s || h == s_t) {
            self.faces[f.0 as usize].half_edge = Some(a);
        }
        Ok(())
    }

    /// Remove all orphaned cruft the wall arrangement leaves behind: dangling
    /// spur walls (degree-1 chains), isolated vertices, and redundant collinear
    /// degree-2 nodes. Idempotent, and never changes a room's area (spurs bound
    /// no room; collinear dissolve only straightens a node already on its chord).
    /// Returns how many topology elements were pruned.
    pub fn prune_orphans(&mut self) -> usize {
        let mut removed = 0usize;
        // Phase A — spur sweep to a fixpoint (chews whole chains).
        loop {
            let tips: Vec<VertexId> = (0..self.vertices.len())
                .map(|i| VertexId(i as u32))
                .filter(|&v| self.vertex_degree(v) == 1)
                .collect();
            if tips.is_empty() {
                break;
            }
            for tip in tips {
                if self.vertex_degree(tip) != 1 {
                    continue; // a sibling removal already changed it
                }
                let s = self.outgoing_half_edges(tip).next();
                if let Some(s) = s {
                    if self.remove_spur_edge(s).is_ok() {
                        removed += 1;
                    }
                }
            }
        }
        // Phase B — drop leftover degree-0 (isolated) vertices.
        for i in 0..self.vertices.len() {
            let v = VertexId(i as u32);
            if self.vertices[i].alive && self.vertex_degree(v) == 0 {
                self.vertices[i].alive = false;
                self.vertices[i].outgoing = None;
                removed += 1;
            }
        }
        // Phase C — dissolve redundant collinear degree-2 nodes (fixpoint).
        loop {
            let mut progress = false;
            let cands: Vec<VertexId> = (0..self.vertices.len())
                .map(|i| VertexId(i as u32))
                .filter(|&v| self.vertex_degree(v) == 2)
                .collect();
            for v in cands {
                if self.vertex_degree(v) != 2 {
                    continue;
                }
                let outs: Vec<HalfEdgeId> = self.outgoing_half_edges(v).collect();
                let p = self.vertices[v.0 as usize].pos;
                let x = self.vertices[self.dest(outs[0]).0 as usize].pos;
                let y = self.vertices[self.dest(outs[1]).0 as usize].pos;
                if perp_distance(p, x, y) >= EPS_COLL {
                    continue; // a genuine corner — keep it
                }
                if self.dissolve_vertex(v).is_ok() {
                    removed += 1;
                    progress = true;
                }
            }
            if !progress {
                break;
            }
        }
        removed
    }

    /// Remove the wall `edge`, choosing the right semantics from its two
    /// incident faces, and auto-clean the orphans it leaves:
    /// - room ↔ room → union the two rooms (`merge_faces`);
    /// - bridge (same face both sides) or outer ↔ outer → delete it + `prune_orphans`;
    /// - room ↔ outer (a real enclosing wall) → `BordersExterior` (don't open a room).
    pub fn remove_edge(&mut self, edge: HalfEdgeId) -> Result<Vec<FacePatch>, EditError> {
        let hi = edge.0 as usize;
        if hi >= self.half_edges.len() || !self.half_edges[hi].alive {
            return Err(EditError::StaleHandle);
        }
        let t = self.half_edges[hi].twin;
        let f_keep = self.half_edges[hi].face;
        let f_drop = self.half_edges[t.0 as usize].face;
        let keep_outer = self.faces[f_keep.0 as usize].is_outer;
        let drop_outer = self.faces[f_drop.0 as usize].is_outer;

        if f_keep != f_drop && !keep_outer && !drop_outer {
            return self.merge_faces(edge); // two real rooms → union
        }
        if f_keep != f_drop && keep_outer != drop_outer {
            return Err(EditError::BordersExterior); // would open a room
        }

        // Bridge (f_keep == f_drop) or outer ↔ outer → delete + clean.
        let hn = self.half_edges[hi].next;
        let hp = self.half_edges[hi].prev;
        let tn = self.half_edges[t.0 as usize].next;
        let tp = self.half_edges[t.0 as usize].prev;
        let oh = self.half_edges[hi].origin;
        let ot = self.half_edges[t.0 as usize].origin;

        self.half_edges[hp.0 as usize].next = tn;
        self.half_edges[tn.0 as usize].prev = hp;
        self.half_edges[tp.0 as usize].next = hn;
        self.half_edges[hn.0 as usize].prev = tp;

        if f_drop != f_keep {
            // outer ↔ outer: fold f_drop's loop into f_keep.
            self.faces[f_keep.0 as usize].half_edge = Some(hp);
            let merged: Vec<HalfEdgeId> = self.face_half_edges(f_keep).collect();
            for he in merged {
                self.half_edges[he.0 as usize].face = f_keep;
            }
            self.faces[f_drop.0 as usize].alive = false;
            self.faces[f_drop.0 as usize].half_edge = None;
        }
        self.half_edges[hi].alive = false;
        self.half_edges[t.0 as usize].alive = false;
        self.repair_vertex_outgoing(oh, edge);
        self.repair_vertex_outgoing(ot, t);
        // The face's anchor may have been one of the removed half-edges (esp. a
        // bridge / spur in the outer face) — re-point it at a survivor.
        self.reanchor_face_if_dead(f_keep);

        self.prune_orphans();

        let mut out = Vec::new();
        if self.faces[f_keep.0 as usize].alive && !self.faces[f_keep.0 as usize].is_outer {
            out.push(self.face_patch(f_keep));
        }
        Ok(out)
    }
}
