// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! # Persistent, editable space topology (DCEL)
//!
//! This is the Rust core of the interactive space-sketch editor. It does
//! what the one-shot TS `auto-space-detect` pipeline does — turn a set of
//! 2D wall-axis segments into the enclosed room faces of a floor plate —
//! but instead of building a half-edge graph, walking it once, and
//! **throwing it away** (returning bare `Vec<[f64;2]>` outlines), it keeps
//! the [`SpacePlate`] alive as the authoritative topology and exposes
//! local, O(degree) edit operations on it:
//!
//! - [`SpacePlate::drag_vertex`] — move a vertex; every incident face
//!   follows in the same call because a shared wall is **one** edge whose
//!   endpoints are shared vertices. This is the whole "pull one room, the
//!   neighbour follows" trick, and it falls out of the structure for free.
//! - [`SpacePlate::split_face`] — insert a partition between two vertices
//!   of a face (subdivide a room). O(1) surgery; both children valid
//!   immediately.
//! - [`SpacePlate::merge_faces`] — remove a shared edge, unioning the two
//!   rooms it separated. O(1) surgery.
//!
//! Every edit returns the [`FaceId`]s it touched (with recomputed outline
//! + area) so the TS mirror can re-render only what changed.
//!
//! ## What this adds over the TS detector
//!
//! 1. **Persistence.** The DCEL survives across edits; ids are stable
//!    (tombstoned, never reused) so a TS-side hit-test mirror can reference
//!    a face/edge across frames.
//! 2. **Source-element provenance.** Each input segment carries the IFC
//!    element id it came from; that id is propagated through snapping,
//!    T-junction resolution and intersection-splitting onto every bounding
//!    half-edge. This is what makes `IfcRelSpaceBoundary` emission and the
//!    leak-repair affordance possible at bake — the TS detector drops it.
//! 3. **`prev` pointers + the outer face as a real face**, so split/merge
//!    are pure pointer surgery with no re-walk of the whole plate.
//!
//! ## Conventions
//!
//! - Interior (room) faces wind **CCW** (signed area > 0). The unbounded
//!   exterior winds **CW** and is flagged [`Face::is_outer`]. A plate with
//!   several disconnected wall clusters has one outer face per component.
//! - A half-edge's [`HalfEdge::face`] is the face on its **left**.
//! - Holes / nested faces (a room enclosing a courtyard) are out of scope
//!   for this prototype: every CW cycle is treated as exterior, matching
//!   the TS detector. See the module TODO at the bottom.

use rustc_hash::FxHashMap;

/// Stable handle to a vertex. Survives edits; never reused after tombstoning.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct VertexId(pub u32);

/// Stable handle to a directed half-edge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct HalfEdgeId(pub u32);

/// Stable handle to a face (a room, or the unbounded exterior).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct FaceId(pub u32);

/// An input wall-axis segment tagged with the IFC element it came from.
///
/// `source_element` is the express id of the originating wall / divider.
/// `None` marks a synthetic segment with no single source (rare; e.g. a
/// user-drawn guide). It is propagated to every half-edge derived from this
/// segment so the bake step can recover `IfcRelSpaceBoundary` links.
#[derive(Debug, Clone, Copy)]
pub struct InputSegment {
    pub a: [f64; 2],
    pub b: [f64; 2],
    pub source_element: Option<u32>,
    /// Half the source wall's thickness (metres). Carried onto every half-edge
    /// derived from this segment so `net_outline` can inset each room edge by
    /// its own wall's half-thickness — no fuzzy edge↔wall matching, unlike the
    /// TS `offsetRoomFootprint`. `0.0` = unknown/no thickness (centreline only).
    pub half_thickness: f64,
}

impl InputSegment {
    pub fn new(a: [f64; 2], b: [f64; 2], source_element: Option<u32>) -> Self {
        Self { a, b, source_element, half_thickness: 0.0 }
    }

    /// Builder: set the half-thickness (metres) carried to derived half-edges.
    pub fn with_half_thickness(mut self, half_thickness: f64) -> Self {
        self.half_thickness = half_thickness;
        self
    }
}

/// Tuning for the arrangement pass. Distances are in the same units as the
/// input segments (the caller is expected to pre-scale to metres, exactly
/// as `extract-walls` does on the TS side).
#[derive(Debug, Clone, Copy)]
pub struct BuildOptions {
    /// Endpoints closer than this merge to one vertex. Also the radius for
    /// snapping a dangling wall-end onto a neighbour's interior (T-junction).
    pub snap_tolerance: f64,
    /// Faces below this absolute area are discarded as slivers.
    pub min_area: f64,
}

impl Default for BuildOptions {
    fn default() -> Self {
        // Mirrors the TS `generate-spaces` defaults.
        Self { snap_tolerance: 0.1, min_area: 0.5 }
    }
}

#[derive(Debug, Clone)]
struct Vertex {
    pos: [f64; 2],
    /// One outgoing half-edge, or `None` once isolated/tombstoned.
    outgoing: Option<HalfEdgeId>,
    alive: bool,
}

#[derive(Debug, Clone)]
struct HalfEdge {
    origin: VertexId,
    twin: HalfEdgeId,
    next: HalfEdgeId,
    prev: HalfEdgeId,
    face: FaceId,
    /// The IFC element this edge bounds, propagated from the input segment.
    /// `None` for the exterior side of a boundary-less cut or a user split.
    source_element: Option<u32>,
    /// Half the source wall's thickness (metres); `0.0` for a user-drawn edge.
    /// Both twins carry the same value (it's the wall, not a side).
    half_thickness: f64,
    alive: bool,
}

#[derive(Debug, Clone)]
struct Face {
    /// One boundary half-edge, or `None` once tombstoned.
    half_edge: Option<HalfEdgeId>,
    is_outer: bool,
    /// Whether this bounded face is surfaced as a ROOM. Classified ONCE at build
    /// (every bounded face for a centreline plate; only the gaps between wall
    /// rectangles for a face-based plate) and then carried THROUGH edits — a
    /// split inherits it, a merge ORs it. Never re-derived from geometry, so
    /// dragging a vertex or cutting a room can't silently re-classify faces into
    /// phantom rooms (the wall-rect centroid test was the culprit).
    is_room: bool,
    floor_z: f64,
    ceiling_z: f64,
    /// Set when the ceiling plane is inferred (e.g. pitched roof underside);
    /// carried through edits so the sketch UI can telegraph "approximate".
    non_planar_ceiling: bool,
    alive: bool,
}

/// A face touched by an edit, with enough geometry for the caller to
/// re-render it without re-querying the whole plate.
#[derive(Debug, Clone, PartialEq)]
pub struct FacePatch {
    pub face: FaceId,
    /// CCW outline; the first vertex is **not** repeated.
    pub outline: Vec<[f64; 2]>,
    pub area: f64,
    /// `false` when the edit left the face self-intersecting or degenerate.
    /// The op still applies (fluid dragging shouldn't fight the user); the
    /// caller decides whether to telegraph the invalid state.
    pub simple: bool,
}

/// Errors an edit op can reject with. Build never fails — a malformed input
/// just yields fewer (or zero) interior faces, matching the TS detector.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EditError {
    /// A referenced id is tombstoned or out of range.
    StaleHandle,
    /// `split_face`: the two vertices aren't both on the target face.
    VerticesNotOnFace,
    /// `split_face`: the two endpoints are the same, or already adjacent on
    /// the face (the cut would have zero area on one side).
    DegenerateCut,
    /// `merge_faces`: the edge borders the exterior, so there's no second
    /// room to merge with (that's a delete, not a merge).
    BordersExterior,
    /// `merge_faces`: both sides are the same face — the edge is a bridge,
    /// and removing it would change connectivity rather than union two rooms.
    BridgeEdge,
    /// `dissolve_vertex`: the vertex isn't a simple degree-2 node (a junction
    /// where 3+ walls meet, or a dangling tip), so there's no unambiguous pair
    /// of edges to weld into one.
    VertexNotDissolvable,
    /// `add_face`: the ring has fewer than 3 points, self-intersects, or
    /// encloses near-zero area.
    InvalidPolygon,
}

/// The persistent floor-plate topology. See the module docs.
#[derive(Debug, Clone)]
pub struct SpacePlate {
    vertices: Vec<Vertex>,
    half_edges: Vec<HalfEdge>,
    faces: Vec<Face>,
    /// Wall footprint rectangles (4 corners each), set only by the FACE-BASED
    /// build (`build_from_wall_rects`). When non-empty, a bounded face is a ROOM
    /// only if its centroid lies OUTSIDE every wall rectangle (it's a gap between
    /// walls, not a wall interior). Empty for the centreline build, where every
    /// non-outer bounded face is a room.
    wall_rects: Vec<[[f64; 2]; 4]>,
}

const EPS: f64 = 1e-9;
/// Perpendicular-distance threshold (metres) for "this degree-2 node is a
/// redundant collinear point on a straight run" — used by `prune_orphans` to
/// dissolve derivation cruft. Far below the wall snap tolerance (default 0.1 m)
/// so genuine corners are never mistaken for collinear and dissolved away.
const EPS_COLL: f64 = 1e-6;

impl SpacePlate {
    // ───────────────────────── construction ─────────────────────────

    /// Build the plate from tagged wall-axis segments.
    ///
    /// Pipeline (ported from `auto-space-detect.ts`, provenance added):
    /// 1. snap endpoints onto a spatial-hash grid,
    /// 2. snap dangling endpoints onto nearby edge interiors (T-junctions),
    /// 3. resolve interior crossings, splitting both hosts,
    /// 4. dedupe undirected edges,
    /// 5. build the half-edge graph with angle-sorted vertex fans,
    /// 6. assign `next`/`prev` by the leftmost-turn rule and walk faces,
    /// 7. flag CW cycles as exterior and drop sub-`min_area` rooms.
    pub fn build(segments: &[InputSegment], options: BuildOptions) -> Self {
        let arr = Arrangement::resolve(segments, options.snap_tolerance);
        let mut plate = Self::from_arrangement(arr, options.min_area);
        // The arrangement is non-destructive, so it can carry cruft that bounds
        // no room — dangling spur walls and the redundant collinear nodes they
        // leave behind. Clean them so a derived plate starts as just its rooms
        // (a no-op on already-clean inputs; never changes a room's area).
        plate.prune_orphans();
        plate
    }

    /// FACE-BASED build → an editable CENTRELINE plate sitting on the wall axes.
    ///
    /// Two stages. (1) DETECT: arrange the wall footprint rectangle edges and keep
    /// each bounded face whose centroid lies OUTSIDE every rectangle — i.e. a GAP
    /// between walls (not a wall interior or a junction overlap). This locates the
    /// rooms accurately, with the room boundary literally on the rendered wall
    /// faces (no centroid-derived-centreline drift). (2) LIFT: take each gap room's
    /// wall-AXIS outline (the net gap offset out by ½ thickness, corners
    /// re-intersected) and arrange THOSE edges into the returned plate.
    ///
    /// The returned plate is therefore a normal centreline plate whose room
    /// outlines ARE the wall axes and whose vertices ARE the displayed nodes — so
    /// every editing op (drag / split / merge / dissolve) acts directly on what the
    /// user sees, with no axis-vs-face offset. Each axis edge carries its wall's
    /// half-thickness, so `net_outline` recovers the inner (net) and outer (gross)
    /// faces. Adjacent rooms' shared wall maps to one shared centreline edge.
    pub fn build_from_wall_rects(rects: &[[[f64; 2]; 4]], options: BuildOptions) -> Self {
        // --- Stage 1: detect rooms as the gaps between wall rectangles. ---
        let mut rect_edges: Vec<InputSegment> = Vec::with_capacity(rects.len() * 4);
        for (wi, r) in rects.iter().enumerate() {
            // Wall thickness = the rectangle's shorter side (faces are the long pair).
            let side = |a: [f64; 2], b: [f64; 2]| ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2)).sqrt();
            let half = side(r[0], r[1]).min(side(r[1], r[2])) / 2.0;
            let src = Some(wi as u32);
            for i in 0..4 {
                rect_edges.push(InputSegment::new(r[i], r[(i + 1) % 4], src).with_half_thickness(half));
            }
        }
        let mut gap = Self::from_arrangement(Arrangement::resolve(&rect_edges, options.snap_tolerance), options.min_area);
        gap.wall_rects = rects.to_vec();

        // --- Stage 2: lift each gap room to its wall-axis outline and re-arrange. ---
        let mut axis_edges: Vec<InputSegment> = Vec::new();
        for i in 0..gap.faces.len() {
            let f = FaceId(i as u32);
            if gap.faces[i].is_outer || !gap.is_gap_face(f) {
                continue;
            }
            let axis = gap.gap_boundary(f, 1.0); // net gap → wall axis (½ thickness out)
            let cycle: Vec<HalfEdgeId> = gap.face_half_edges(f).collect();
            if axis.len() < 3 || axis.len() != cycle.len() {
                continue;
            }
            for k in 0..axis.len() {
                let he = &gap.half_edges[cycle[k].0 as usize];
                axis_edges.push(
                    InputSegment::new(axis[k], axis[(k + 1) % axis.len()], he.source_element)
                        .with_half_thickness(he.half_thickness),
                );
            }
        }
        // Fallback: if the lift produced nothing usable (degenerate input), return
        // the gap plate as-is so the caller still gets rooms.
        if axis_edges.is_empty() {
            for i in 0..gap.faces.len() {
                let f = FaceId(i as u32);
                gap.faces[i].is_room = !gap.faces[i].is_outer && gap.is_gap_face(f);
            }
            return gap;
        }
        // The returned plate has no `wall_rects`, so `is_room` defaults to every
        // bounded face — exactly the lifted axis rooms.
        Self::from_arrangement(Arrangement::resolve(&axis_edges, options.snap_tolerance), options.min_area)
    }

    fn from_arrangement(arr: Arrangement, min_area: f64) -> Self {
        let mut plate = SpacePlate {
            vertices: arr
                .vertices
                .iter()
                .map(|&pos| Vertex { pos, outgoing: None, alive: true })
                .collect(),
            half_edges: Vec::with_capacity(arr.edges.len() * 2),
            faces: Vec::new(),
            wall_rects: Vec::new(),
        };

        // Two half-edges per undirected edge, twinned. Record outgoing fans.
        let mut fans: Vec<Vec<(HalfEdgeId, f64)>> = vec![Vec::new(); arr.vertices.len()];
        for e in &arr.edges {
            let (a, b, src, ht) = (e.a, e.b, e.source, e.half_thickness);
            let pa = arr.vertices[a];
            let pb = arr.vertices[b];
            let fwd = HalfEdgeId(plate.half_edges.len() as u32);
            let bwd = HalfEdgeId(plate.half_edges.len() as u32 + 1);
            // Placeholder next/prev/face — patched after fans are sorted.
            plate.half_edges.push(HalfEdge {
                origin: VertexId(a as u32),
                twin: bwd,
                next: fwd,
                prev: fwd,
                face: FaceId(0),
                source_element: src,
                half_thickness: ht,
                alive: true,
            });
            plate.half_edges.push(HalfEdge {
                origin: VertexId(b as u32),
                twin: fwd,
                next: bwd,
                prev: bwd,
                face: FaceId(0),
                source_element: src,
                half_thickness: ht,
                alive: true,
            });
            fans[a].push((fwd, (pb[1] - pa[1]).atan2(pb[0] - pa[0])));
            fans[b].push((bwd, (pa[1] - pb[1]).atan2(pa[0] - pb[0])));
        }

        for (v, fan) in fans.iter_mut().enumerate() {
            // total_cmp (not partial_cmp/unwrap) so any NaN angle from a
            // degenerate/coincident segment sorts deterministically rather
            // than corrupting the next/prev wiring nondeterministically.
            fan.sort_by(|p, q| p.1.total_cmp(&q.1));
            plate.vertices[v].outgoing = fan.first().map(|(h, _)| *h);
        }

        // `next`: after arriving along `e` at vertex v = dest(e), leave on the
        // clockwise neighbour of `e.twin` in v's angular fan. That yields a
        // CCW interior walk. `prev` is the inverse.
        for he in 0..plate.half_edges.len() {
            let h = HalfEdgeId(he as u32);
            let dest = plate.dest(h);
            let twin = plate.half_edges[he].twin;
            let fan = &fans[dest.0 as usize];
            let idx = fan.iter().position(|(e, _)| *e == twin);
            let Some(idx) = idx else { continue }; // structurally impossible
            let nxt = fan[(idx + fan.len() - 1) % fan.len()].0;
            plate.half_edges[he].next = nxt;
            plate.half_edges[nxt.0 as usize].prev = h;
        }

        // Walk cycles → faces. CCW (signed > 0) = room; CW = exterior.
        let mut visited = vec![false; plate.half_edges.len()];
        for start in 0..plate.half_edges.len() {
            if visited[start] {
                continue;
            }
            let mut cycle = Vec::new();
            let mut cur = HalfEdgeId(start as u32);
            loop {
                if visited[cur.0 as usize] {
                    break;
                }
                visited[cur.0 as usize] = true;
                cycle.push(cur);
                cur = plate.half_edges[cur.0 as usize].next;
                if cur.0 as usize == start {
                    break;
                }
            }
            let signed = plate.signed_area_of_cycle(&cycle);
            let is_outer = signed <= 0.0;
            // Drop sub-min-area rooms by folding them into no face: we still
            // need a face record (half-edges must point somewhere), so we
            // keep the cycle but flag tiny CCW faces as outer so they're not
            // surfaced as rooms. Exterior cycles are always kept as outer.
            let too_small = !is_outer && signed.abs() < min_area;
            let face = FaceId(plate.faces.len() as u32);
            plate.faces.push(Face {
                half_edge: cycle.first().copied(),
                is_outer: is_outer || too_small,
                // Centreline default: every bounded, non-tiny face is a room.
                // `build_from_wall_rects` re-classifies to gaps-only afterwards.
                is_room: !(is_outer || too_small),
                floor_z: 0.0,
                ceiling_z: 0.0,
                non_planar_ceiling: false,
                alive: true,
            });
            for h in cycle {
                plate.half_edges[h.0 as usize].face = face;
            }
        }

        plate
    }

    // ───────────────────────────── edits ─────────────────────────────

    /// Move `v` to `(x, y)`. Topology is untouched; every incident face is
    /// updated by construction (they all reference this one vertex). Returns
    /// a patch per incident *room* face — the same call updates a room and
    /// its neighbour across a shared wall.
    pub fn drag_vertex(&mut self, v: VertexId, x: f64, y: f64) -> Result<Vec<FacePatch>, EditError> {
        let idx = v.0 as usize;
        if idx >= self.vertices.len() || !self.vertices[idx].alive {
            return Err(EditError::StaleHandle);
        }
        self.vertices[idx].pos = [x, y];
        let mut faces: Vec<FaceId> = self
            .outgoing_half_edges(v)
            .map(|h| self.half_edges[h.0 as usize].face)
            .collect();
        faces.sort();
        faces.dedup();
        Ok(faces
            .into_iter()
            .filter(|f| !self.faces[f.0 as usize].is_outer)
            .map(|f| self.face_patch(f))
            .collect())
    }

    /// Subdivide `face` by inserting a partition edge between two of its
    /// vertices. Returns patches for the kept face and the new face.
    ///
    /// The new edge carries `source_element` (`None` = a brand-new partition
    /// the user drew, which the bake step materialises as a fresh wall or a
    /// virtual boundary).
    pub fn split_face(
        &mut self,
        face: FaceId,
        va: VertexId,
        vb: VertexId,
        source_element: Option<u32>,
    ) -> Result<Vec<FacePatch>, EditError> {
        self.check_face(face)?;
        if va == vb {
            return Err(EditError::DegenerateCut);
        }
        // Find the boundary half-edges of `face` leaving va and vb.
        let mut ha = None;
        let mut hb = None;
        for h in self.face_half_edges(face) {
            let o = self.half_edges[h.0 as usize].origin;
            if o == va {
                ha = Some(h);
            }
            if o == vb {
                hb = Some(h);
            }
        }
        let (ha, hb) = match (ha, hb) {
            (Some(a), Some(b)) => (a, b),
            _ => return Err(EditError::VerticesNotOnFace),
        };
        // Adjacent on the face → one side has zero area. Reject.
        if self.half_edges[ha.0 as usize].next == hb
            || self.half_edges[hb.0 as usize].next == ha
        {
            return Err(EditError::DegenerateCut);
        }

        let pa_prev = self.half_edges[ha.0 as usize].prev;
        let pb_prev = self.half_edges[hb.0 as usize].prev;

        // New twin pair: e_ab (va→vb) keeps `face`; e_ba (vb→va) gets a new face.
        let e_ab = HalfEdgeId(self.half_edges.len() as u32);
        let e_ba = HalfEdgeId(self.half_edges.len() as u32 + 1);
        let new_face = FaceId(self.faces.len() as u32);

        self.half_edges.push(HalfEdge {
            origin: va,
            twin: e_ba,
            next: hb,
            prev: pa_prev,
            face,
            source_element,
            half_thickness: 0.0, // a user-drawn partition has no wall thickness yet
            alive: true,
        });
        self.half_edges.push(HalfEdge {
            origin: vb,
            twin: e_ab,
            next: ha,
            prev: pb_prev,
            face: new_face,
            source_element,
            half_thickness: 0.0,
            alive: true,
        });

        // Rewire the four neighbours around the new diagonal.
        self.half_edges[pa_prev.0 as usize].next = e_ab;
        self.half_edges[hb.0 as usize].prev = e_ab;
        self.half_edges[pb_prev.0 as usize].next = e_ba;
        self.half_edges[ha.0 as usize].prev = e_ba;

        // Kept face anchors on e_ab; new face owns e_ba's cycle.
        self.faces[face.0 as usize].half_edge = Some(e_ab);
        let parent = self.faces[face.0 as usize].clone();
        self.faces.push(Face {
            half_edge: Some(e_ba),
            is_outer: false,
            is_room: parent.is_room, // both halves of a split stay rooms
            floor_z: parent.floor_z,
            ceiling_z: parent.ceiling_z,
            non_planar_ceiling: parent.non_planar_ceiling,
            alive: true,
        });
        // Re-home the new face's cycle (collect first — the walk borrows
        // `self`, the assignment mutates it).
        let new_cycle: Vec<HalfEdgeId> = self.face_half_edges(new_face).collect();
        for h in new_cycle {
            self.half_edges[h.0 as usize].face = new_face;
        }

        Ok(vec![self.face_patch(face), self.face_patch(new_face)])
    }

    /// Insert a new vertex at `(x, y)` on the undirected edge `edge` (and its
    /// twin), subdividing it. No face is created — both incident faces simply
    /// gain a boundary vertex. Returns the new vertex so the caller can use it
    /// as a `split_face` endpoint. Pass a point on the edge segment to keep
    /// areas unchanged (the caller projects the click onto the edge).
    ///
    /// This is what lets the user add a node where there wasn't a corner, so a
    /// partition can start/end mid-wall rather than only at existing vertices.
    pub fn split_edge(&mut self, edge: HalfEdgeId, x: f64, y: f64) -> Result<VertexId, EditError> {
        let h = edge;
        if h.0 as usize >= self.half_edges.len() || !self.half_edges[h.0 as usize].alive {
            return Err(EditError::StaleHandle);
        }
        let t = self.half_edges[h.0 as usize].twin;
        let f1 = self.half_edges[h.0 as usize].face;
        let f2 = self.half_edges[t.0 as usize].face;
        let h_next = self.half_edges[h.0 as usize].next;
        let t_next = self.half_edges[t.0 as usize].next;
        let h_src = self.half_edges[h.0 as usize].source_element;
        let t_src = self.half_edges[t.0 as usize].source_element;
        // The two new halves continue the same wall → inherit its thickness.
        let h_ht = self.half_edges[h.0 as usize].half_thickness;
        let t_ht = self.half_edges[t.0 as usize].half_thickness;

        let n = VertexId(self.vertices.len() as u32);
        let e1 = HalfEdgeId(self.half_edges.len() as u32); // N → B (was dest of h)
        let e2 = HalfEdgeId(self.half_edges.len() as u32 + 1); // N → A (was dest of t)

        self.vertices.push(Vertex { pos: [x, y], outgoing: Some(e1), alive: true });
        self.half_edges.push(HalfEdge {
            origin: n, twin: t, next: h_next, prev: h, face: f1, source_element: h_src, half_thickness: h_ht, alive: true,
        });
        self.half_edges.push(HalfEdge {
            origin: n, twin: h, next: t_next, prev: t, face: f2, source_element: t_src, half_thickness: t_ht, alive: true,
        });

        // h becomes A→N; t becomes B→N. Their twins/nexts re-point through N.
        self.half_edges[h.0 as usize].twin = e2;
        self.half_edges[h.0 as usize].next = e1;
        self.half_edges[t.0 as usize].twin = e1;
        self.half_edges[t.0 as usize].next = e2;
        self.half_edges[h_next.0 as usize].prev = e1;
        self.half_edges[t_next.0 as usize].prev = e2;

        Ok(n)
    }

    /// Remove the shared edge `edge` (and its twin), unioning the two rooms
    /// it separated into one. Returns a patch for the surviving face.
    pub fn merge_faces(&mut self, edge: HalfEdgeId) -> Result<Vec<FacePatch>, EditError> {
        let h = edge;
        if h.0 as usize >= self.half_edges.len() || !self.half_edges[h.0 as usize].alive {
            return Err(EditError::StaleHandle);
        }
        let t = self.half_edges[h.0 as usize].twin;
        let f_keep = self.half_edges[h.0 as usize].face;
        let f_drop = self.half_edges[t.0 as usize].face;
        if self.faces[f_keep.0 as usize].is_outer || self.faces[f_drop.0 as usize].is_outer {
            return Err(EditError::BordersExterior);
        }
        if f_keep == f_drop {
            return Err(EditError::BridgeEdge);
        }

        let (hn, hp) = {
            let he = &self.half_edges[h.0 as usize];
            (he.next, he.prev)
        };
        let (tn, tp) = {
            let te = &self.half_edges[t.0 as usize];
            (te.next, te.prev)
        };

        // Bypass both half-edges of the shared wall.
        self.half_edges[hp.0 as usize].next = tn;
        self.half_edges[tn.0 as usize].prev = hp;
        self.half_edges[tp.0 as usize].next = hn;
        self.half_edges[hn.0 as usize].prev = tp;

        // The merged face is a room if either side was.
        self.faces[f_keep.0 as usize].is_room |= self.faces[f_drop.0 as usize].is_room;
        // Re-home f_drop's loop onto f_keep, then tombstone f_drop + the edge.
        self.faces[f_keep.0 as usize].half_edge = Some(hp);
        let merged_cycle: Vec<HalfEdgeId> = self.face_half_edges(f_keep).collect();
        for he in merged_cycle {
            self.half_edges[he.0 as usize].face = f_keep;
        }
        self.faces[f_drop.0 as usize].alive = false;
        self.faces[f_drop.0 as usize].half_edge = None;

        // Detach the removed half-edges from their endpoints' outgoing slot,
        // tombstone them, and drop any vertex left isolated.
        for (he, origin) in [(h, self.half_edges[h.0 as usize].origin), (t, self.half_edges[t.0 as usize].origin)] {
            self.half_edges[he.0 as usize].alive = false;
            self.repair_vertex_outgoing(origin, he);
        }

        Ok(vec![self.face_patch(f_keep)])
    }

    /// Dissolve a **degree-2** vertex `v`, welding its two incident edges into
    /// one straight edge between its neighbours — the inverse of `split_edge`,
    /// and the "delete this corner / errant node" affordance. Both incident
    /// faces lose a boundary vertex; if `v` was a real corner the faces change
    /// shape (the edge becomes the straight chord A→B), which is the intended
    /// edit. Returns a patch per incident *room* face.
    ///
    /// Rejects:
    /// - a vertex whose degree isn't exactly 2 — a wall junction or dangling
    ///   tip has no unambiguous edge pair to merge (`VertexNotDissolvable`);
    /// - a weld whose two neighbours are already directly joined, which would
    ///   make a parallel edge / collapse a triangle to a digon (`DegenerateCut`).
    pub fn dissolve_vertex(&mut self, v: VertexId) -> Result<Vec<FacePatch>, EditError> {
        let vi = v.0 as usize;
        if vi >= self.vertices.len() || !self.vertices[vi].alive {
            return Err(EditError::StaleHandle);
        }
        // Degree must be exactly 2 (two live outgoing half-edges).
        let outs: Vec<HalfEdgeId> = self.outgoing_half_edges(v).collect();
        if outs.len() != 2 {
            return Err(EditError::VertexNotDissolvable);
        }
        let (o1, o2) = (outs[0], outs[1]); // v→X, v→Y
        let t1 = self.half_edges[o1.0 as usize].twin; // X→v — kept, becomes X→Y
        let t2 = self.half_edges[o2.0 as usize].twin; // Y→v — kept, becomes Y→X
        let x = self.dest(o1);
        let y = self.dest(o2);
        if x == y {
            return Err(EditError::DegenerateCut); // both edges to one neighbour (digon)
        }
        // Welding X and Y when they already share an edge would duplicate it.
        if self.outgoing_half_edges(x).any(|h| self.dest(h) == y) {
            return Err(EditError::DegenerateCut);
        }
        // Degree-2 invariant: the edge arriving at v before o1 (in o1's face) is
        // t2, and symmetrically prev(o2)==t1. If this doesn't hold one edge is a
        // dangling antenna — bail rather than corrupt the rotation.
        if self.half_edges[o1.0 as usize].prev != t2 || self.half_edges[o2.0 as usize].prev != t1 {
            return Err(EditError::VertexNotDissolvable);
        }
        let fa = self.half_edges[t2.0 as usize].face; // face that saw Y→v→X
        let fb = self.half_edges[t1.0 as usize].face; // face that saw X→v→Y
        let qa = self.half_edges[o1.0 as usize].next; // what followed o1 in fa
        let qb = self.half_edges[o2.0 as usize].next; // what followed o2 in fb

        // The welded X↔Y edge only carries a wall provenance when BOTH survivors
        // agreed on one — otherwise it spans two different source walls and must
        // drop to `None`, so we don't emit a stale IfcRelSpaceBoundary link.
        let welded_source = if self.half_edges[t1.0 as usize].source_element
            == self.half_edges[t2.0 as usize].source_element
        {
            self.half_edges[t1.0 as usize].source_element
        } else {
            None
        };

        // Re-twin the survivors into one undirected edge X↔Y, splicing out v.
        self.half_edges[t1.0 as usize].twin = t2; // t1 now X→Y
        self.half_edges[t1.0 as usize].source_element = welded_source;
        self.half_edges[t1.0 as usize].next = qb;
        self.half_edges[qb.0 as usize].prev = t1;
        self.half_edges[t2.0 as usize].twin = t1; // t2 now Y→X
        self.half_edges[t2.0 as usize].source_element = welded_source;
        self.half_edges[t2.0 as usize].next = qa;
        self.half_edges[qa.0 as usize].prev = t2;

        // Tombstone the two v-originating half-edges and v itself.
        self.half_edges[o1.0 as usize].alive = false;
        self.half_edges[o2.0 as usize].alive = false;
        self.vertices[vi].outgoing = None;
        self.vertices[vi].alive = false;

        // A face anchor may have pointed at a now-dead half-edge.
        for (face, keep) in [(fa, t2), (fb, t1)] {
            let anchor = self.faces[face.0 as usize].half_edge;
            if anchor == Some(o1) || anchor == Some(o2) {
                self.faces[face.0 as usize].half_edge = Some(keep);
            }
        }
        // X keeps its survivor t1 (origin X) and Y keeps t2 (origin Y); their
        // outgoing slots could only have referenced o1/o2 via v, now gone.

        let mut faces = vec![fa, fb];
        faces.sort();
        faces.dedup();
        Ok(faces
            .into_iter()
            .filter(|f| !self.faces[f.0 as usize].is_outer)
            .map(|f| self.face_patch(f))
            .collect())
    }

    /// Live degree of a vertex (its number of live outgoing half-edges).
    fn vertex_degree(&self, v: VertexId) -> usize {
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
    fn remove_spur_edge(&mut self, spur_he: HalfEdgeId) -> Result<(), EditError> {
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

    /// Author a brand-new room from a closed ring of points — the "draw a
    /// room" affordance. The polygon becomes its **own** connected component:
    /// a CCW interior room face plus the CW exterior face bounding it. It does
    /// NOT merge into existing topology (there's no arrangement overlay), so
    /// drawing over an existing room leaves two independent components — the
    /// documented prototype limitation.
    ///
    /// `points` is the ring with no repeated closing vertex; winding is
    /// normalised to CCW. Rejects a ring that is too short, self-intersecting,
    /// or near-zero area (`InvalidPolygon`). Returns the new room's patch.
    pub fn add_face(&mut self, points: &[[f64; 2]], source_element: Option<u32>) -> Result<FacePatch, EditError> {
        if points.len() < 3 || !is_simple_polygon(points) {
            return Err(EditError::InvalidPolygon);
        }
        // Reject consecutive coincident points, including the closing wrap. A
        // zero-length edge slips past `is_simple_polygon` (its segment-cross test
        // treats a degenerate segment as parallel), so a ring like [A, A, B, C]
        // has non-zero area yet would persist a duplicate vertex + zero-length
        // half-edge — malformed for later editing/offsetting/baking. Reachable
        // from the draw UI (e.g. a double-click landing the final corner twice).
        let n = points.len();
        for i in 0..n {
            let a = points[i];
            let b = points[(i + 1) % n];
            if (a[0] - b[0]).abs() < EPS && (a[1] - b[1]).abs() < EPS {
                return Err(EditError::InvalidPolygon);
            }
        }
        let signed = polygon_area(points);
        if signed.abs() < EPS {
            return Err(EditError::InvalidPolygon);
        }
        // Normalise to CCW so the interior winds positive (room on the left).
        let ring: Vec<[f64; 2]> =
            if signed > 0.0 { points.to_vec() } else { points.iter().rev().copied().collect() };
        let nn = ring.len() as u32;

        let v0 = self.vertices.len() as u32; // first new vertex id
        let h0 = self.half_edges.len() as u32; // first interior half-edge id
        let g0 = h0 + nn; // first exterior (twin) half-edge id
        let room = FaceId(self.faces.len() as u32);
        let outer = FaceId(self.faces.len() as u32 + 1);

        for (i, &p) in ring.iter().enumerate() {
            self.vertices.push(Vertex { pos: p, outgoing: Some(HalfEdgeId(h0 + i as u32)), alive: true });
        }
        // Interior half-edges h_i: v_i → v_{i+1}, CCW, room on the left.
        for i in 0..nn {
            self.half_edges.push(HalfEdge {
                origin: VertexId(v0 + i),
                twin: HalfEdgeId(g0 + i),
                next: HalfEdgeId(h0 + (i + 1) % nn),
                prev: HalfEdgeId(h0 + (i + nn - 1) % nn),
                face: room,
                source_element,
                half_thickness: 0.0, // a drawn room has no source wall thickness
                alive: true,
            });
        }
        // Exterior twins g_i: v_{i+1} → v_i, winding CW around the room.
        for i in 0..nn {
            self.half_edges.push(HalfEdge {
                origin: VertexId(v0 + (i + 1) % nn),
                twin: HalfEdgeId(h0 + i),
                next: HalfEdgeId(g0 + (i + nn - 1) % nn),
                prev: HalfEdgeId(g0 + (i + 1) % nn),
                face: outer,
                source_element,
                half_thickness: 0.0,
                alive: true,
            });
        }
        self.faces.push(Face {
            half_edge: Some(HalfEdgeId(h0)),
            is_outer: false,
            is_room: true, // a user-drawn partition is a room
            floor_z: 0.0,
            ceiling_z: 0.0,
            non_planar_ceiling: false,
            alive: true,
        });
        self.faces.push(Face {
            half_edge: Some(HalfEdgeId(g0)),
            is_outer: true,
            is_room: false,
            floor_z: 0.0,
            ceiling_z: 0.0,
            non_planar_ceiling: false,
            alive: true,
        });

        Ok(self.face_patch(room))
    }

    // ─────────────────────────── queries ────────────────────────────

    /// The face on the far side of `edge` — its twin's face. O(1). This is
    /// the "who's my neighbour across this wall" query the UX leans on.
    pub fn neighbor_across(&self, edge: HalfEdgeId) -> Option<FaceId> {
        let he = self.half_edges.get(edge.0 as usize)?;
        if !he.alive {
            return None;
        }
        Some(self.half_edges[he.twin.0 as usize].face)
    }

    /// Every live interior (room) face. In the FACE-BASED build (`wall_rects`
    /// non-empty) a bounded face is a room only if it's a gap between walls — its
    /// centroid lies outside every wall rectangle, so wall interiors and junction
    /// overlaps are excluded.
    pub fn rooms(&self) -> impl Iterator<Item = FaceId> + '_ {
        (0..self.faces.len())
            .map(|i| FaceId(i as u32))
            .filter(move |f| {
                let face = &self.faces[f.0 as usize];
                face.alive && face.is_room
            })
    }

    /// Geometric gap test used ONCE at build to classify face-based rooms: a
    /// bounded face is a gap (room) when its centroid is not inside any wall
    /// rectangle. True for the centreline build (no `wall_rects`). Not used after
    /// build — `Face::is_room` is the carried-through source of truth.
    fn is_gap_face(&self, face: FaceId) -> bool {
        if self.wall_rects.is_empty() {
            return true;
        }
        let outline = self.face_outline(face);
        if outline.len() < 3 {
            return false;
        }
        let (mut cx, mut cy) = (0.0, 0.0);
        for p in &outline {
            cx += p[0];
            cy += p[1];
        }
        let c = [cx / outline.len() as f64, cy / outline.len() as f64];
        !self.wall_rects.iter().any(|r| point_in_quad(c, r))
    }

    /// CCW outline of a face (no repeated closing vertex).
    pub fn face_outline(&self, face: FaceId) -> Vec<[f64; 2]> {
        self.face_half_edges(face)
            .map(|h| self.vertices[self.half_edges[h.0 as usize].origin.0 as usize].pos)
            .collect()
    }

    /// Absolute area of a face.
    pub fn face_area(&self, face: FaceId) -> f64 {
        self.signed_area_of_cycle(&self.face_half_edges(face).collect::<Vec<_>>()).abs()
    }

    /// The room's outline offset to a wall **boundary face** rather than the
    /// centreline: each boundary edge is moved perpendicular by its own wall's
    /// half-thickness — inward for the net (inner) face, outward for the gross
    /// (outer) face — then adjacent offset lines are re-intersected for the
    /// corners. Because every half-edge carries its source wall's thickness,
    /// this needs no fuzzy edge↔wall matching (unlike the TS `offsetRoomFootprint`).
    ///
    /// An edge shared with another room (its twin bounds a room, not the
    /// exterior) is pinned to the centreline in **outward** mode so it can't
    /// push into the neighbour. Falls back to the unchanged centreline outline
    /// when no offset applies, a corner is degenerate, or an inset would invert
    /// the polygon — so the result is always a sane ring.
    pub fn net_outline(&self, face: FaceId, inset: bool) -> Vec<[f64; 2]> {
        let centre = self.face_outline(face);
        let n = centre.len();
        if n < 3 {
            return centre;
        }
        let cycle: Vec<HalfEdgeId> = self.face_half_edges(face).collect();
        if cycle.len() != n {
            return centre; // outline / cycle mismatch (e.g. a hole) — don't guess
        }
        let sign = if inset { 1.0 } else { -1.0 };
        // Per edge: a point on its offset line + the edge's unit direction.
        let mut lines: Vec<([f64; 2], [f64; 2])> = Vec::with_capacity(n);
        for i in 0..n {
            let a = centre[i];
            let b = centre[(i + 1) % n];
            let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
            let l = (dx * dx + dy * dy).sqrt();
            if l < EPS {
                return centre;
            }
            let (ux, uy) = (dx / l, dy / l);
            let mut half = self.half_edges[cycle[i].0 as usize].half_thickness;
            // Outward: a shared (room↔room) edge would overlap the neighbour, so pin it.
            if !inset {
                if let Some(nbr) = self.neighbor_across(cycle[i]) {
                    if !self.faces[nbr.0 as usize].is_outer {
                        half = 0.0;
                    }
                }
            }
            let off = sign * half;
            // Inward normal of a CCW outline is to the left of a→b: (-uy, ux).
            lines.push(([a[0] - uy * off, a[1] + ux * off], [ux, uy]));
        }
        let mut verts: Vec<[f64; 2]> = Vec::with_capacity(n);
        for i in 0..n {
            let (pp, pd) = lines[(i + n - 1) % n];
            let (cp, cd) = lines[i];
            let hit = line_intersection(pp, [pp[0] + pd[0], pp[1] + pd[1]], cp, [cp[0] + cd[0], cp[1] + cd[1]]);
            // Parallel offset lines (a collinear node, e.g. a mid-wall split, or
            // two edges of equal thickness in a straight run) don't intersect —
            // drop the corner onto the current offset line so it sits flush on
            // the inset boundary instead of poking back to the centreline.
            verts.push(hit.unwrap_or_else(|| {
                let t = (centre[i][0] - cp[0]) * cd[0] + (centre[i][1] - cp[1]) * cd[1];
                [cp[0] + t * cd[0], cp[1] + t * cd[1]]
            }));
        }
        if verts.iter().any(|v| !v[0].is_finite() || !v[1].is_finite()) {
            return centre;
        }
        let got = polygon_area(&verts).abs();
        if got <= EPS {
            return centre;
        }
        if inset && got > polygon_area(&centre).abs() + 1e-6 {
            return centre; // the inset inverted the polygon — keep the centreline
        }
        verts
    }

    /// FACE-BASED boundary of a gap room: the gap outline IS the net (inner-face)
    /// area, so this pushes every edge OUTWARD (into the wall, away from the room)
    /// by `factor × the source wall's half-thickness`, then re-intersects corners.
    /// `factor = 0` → net (the gap itself); `1` → the wall **axis / centre line**
    /// (½ thickness — where the editable node sits, on the wall mid); `2` → the
    /// gross outer face (full thickness). No shared-edge pinning: two rooms across
    /// a wall correctly meet at the mid axis and overlap into it for gross.
    pub fn gap_boundary(&self, face: FaceId, factor: f64) -> Vec<[f64; 2]> {
        let centre = self.face_outline(face);
        let n = centre.len();
        if n < 3 || factor.abs() < EPS {
            return centre;
        }
        let cycle: Vec<HalfEdgeId> = self.face_half_edges(face).collect();
        if cycle.len() != n {
            return centre;
        }
        // Per edge: the offset line (anchor + dir), the outward displacement
        // vector applied, and |offset| (for the corner miter clamp below).
        let mut lines: Vec<([f64; 2], [f64; 2])> = Vec::with_capacity(n);
        let mut disp: Vec<[f64; 2]> = Vec::with_capacity(n);
        let mut off_mag: Vec<f64> = Vec::with_capacity(n);
        for i in 0..n {
            let a = centre[i];
            let b = centre[(i + 1) % n];
            let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
            let l = (dx * dx + dy * dy).sqrt();
            if l < EPS {
                return centre;
            }
            let (ux, uy) = (dx / l, dy / l);
            let half = self.half_edges[cycle[i].0 as usize].half_thickness;
            // Outward (right of a→b on a CCW ring) = (uy, -ux), i.e. negate the
            // inward normal (-uy, ux). Push the edge out by factor × half.
            let off = factor * half;
            let d = [uy * off, -ux * off];
            lines.push(([a[0] + d[0], a[1] + d[1]], [ux, uy]));
            disp.push(d);
            off_mag.push(off.abs());
        }
        // Re-intersect adjacent offset lines at each corner. At a concave / very
        // acute corner the two near-parallel lines meet far away (an unbounded
        // miter), which would blow the polygon up; clamp any corner that moves
        // more than MITER_LIMIT × the local offset to a bevel (the original
        // corner displaced by the mean of its two edges' offsets).
        const MITER_LIMIT: f64 = 4.0;
        let mut verts: Vec<[f64; 2]> = Vec::with_capacity(n);
        for i in 0..n {
            let pj = (i + n - 1) % n;
            let (pp, pd) = lines[pj];
            let (cp, cd) = lines[i];
            let bevel = [
                centre[i][0] + 0.5 * (disp[pj][0] + disp[i][0]),
                centre[i][1] + 0.5 * (disp[pj][1] + disp[i][1]),
            ];
            let limit = MITER_LIMIT * off_mag[i].max(off_mag[pj]) + EPS;
            let pt = match line_intersection(pp, [pp[0] + pd[0], pp[1] + pd[1]], cp, [cp[0] + cd[0], cp[1] + cd[1]]) {
                Some(m) => {
                    let (ddx, ddy) = (m[0] - centre[i][0], m[1] - centre[i][1]);
                    if (ddx * ddx + ddy * ddy).sqrt() <= limit { m } else { bevel }
                }
                None => bevel,
            };
            verts.push(pt);
        }
        // Final guards: any non-finite / degenerate / runaway (a still-exploded
        // offset polygon should never dwarf the net area) → fall back to the net.
        let net_area = polygon_area(&centre).abs();
        let off_area = polygon_area(&verts).abs();
        if verts.iter().any(|v| !v[0].is_finite() || !v[1].is_finite())
            || off_area <= EPS
            || off_area > 4.0 * net_area + 25.0
        {
            return centre;
        }
        verts
    }

    /// The bounding half-edges of a face paired with the IFC element each
    /// came from — the raw material for `IfcRelSpaceBoundary` at bake.
    pub fn bounding_elements(&self, face: FaceId) -> Vec<(HalfEdgeId, Option<u32>)> {
        self.face_half_edges(face)
            .map(|h| (h, self.half_edges[h.0 as usize].source_element))
            .collect()
    }

    /// Set the floor / ceiling planes of a face (the vertical dimension that
    /// turns a 2D face into a prismatic space at bake).
    pub fn set_face_height(&mut self, face: FaceId, floor_z: f64, ceiling_z: f64, non_planar_ceiling: bool) {
        if let Some(f) = self.faces.get_mut(face.0 as usize) {
            f.floor_z = floor_z;
            f.ceiling_z = ceiling_z;
            f.non_planar_ceiling = non_planar_ceiling;
        }
    }

    pub fn vertex_position(&self, v: VertexId) -> Option<[f64; 2]> {
        self.vertices.get(v.0 as usize).filter(|v| v.alive).map(|v| v.pos)
    }

    /// Count of live rooms — handy for tests / UI summaries.
    pub fn room_count(&self) -> usize {
        self.rooms().count()
    }

    /// Nearest live vertex to `(x, y)` within `tol`, for hit-testing a drag
    /// target from the TS side. Linear scan — a floor plate is small.
    pub fn find_vertex_near(&self, x: f64, y: f64, tol: f64) -> Option<VertexId> {
        let tol2 = tol * tol;
        let mut best: Option<(VertexId, f64)> = None;
        for (i, vtx) in self.vertices.iter().enumerate() {
            if !vtx.alive {
                continue;
            }
            let (dx, dy) = (vtx.pos[0] - x, vtx.pos[1] - y);
            let d2 = dx * dx + dy * dy;
            if d2 <= tol2 && best.map(|(_, b)| d2 < b).unwrap_or(true) {
                best = Some((VertexId(i as u32), d2));
            }
        }
        best.map(|(v, _)| v)
    }

    /// Snapshot every live room as a patch (outline + area + simple flag) —
    /// for bulk render or seeding a fresh TS mirror after a rebuild.
    pub fn room_patches(&self) -> Vec<FacePatch> {
        self.rooms().map(|f| self.face_patch(f)).collect()
    }

    // ─────────────────────────── internals ──────────────────────────

    fn dest(&self, h: HalfEdgeId) -> VertexId {
        self.half_edges[self.half_edges[h.0 as usize].twin.0 as usize].origin
    }

    /// Walk the face cycle starting at its anchor half-edge.
    fn face_half_edges(&self, face: FaceId) -> FaceWalk<'_> {
        // Tolerate an out-of-range or tombstoned face id (a stale handle from
        // JS) — yield an empty walk instead of panicking, so every public
        // query (`face_outline`/`face_area`/`bounding_elements`) is safe at the
        // wasm boundary.
        let start = self
            .faces
            .get(face.0 as usize)
            .filter(|f| f.alive)
            .and_then(|f| f.half_edge);
        FaceWalk { plate: self, start, cur: None }
    }

    /// Outgoing half-edges around a vertex (via twin/next), live only.
    fn outgoing_half_edges(&self, v: VertexId) -> impl Iterator<Item = HalfEdgeId> + '_ {
        let start = self.vertices[v.0 as usize].outgoing;
        VertexFan { plate: self, start, cur: None }
    }

    fn signed_area_of_cycle(&self, cycle: &[HalfEdgeId]) -> f64 {
        let mut acc = 0.0;
        for &h in cycle {
            let p = self.vertices[self.half_edges[h.0 as usize].origin.0 as usize].pos;
            let q = self.vertices[self.dest(h).0 as usize].pos;
            acc += p[0] * q[1] - q[0] * p[1];
        }
        acc * 0.5
    }

    fn check_face(&self, face: FaceId) -> Result<(), EditError> {
        match self.faces.get(face.0 as usize) {
            Some(f) if f.alive && !f.is_outer => Ok(()),
            Some(_) => Err(EditError::StaleHandle),
            None => Err(EditError::StaleHandle),
        }
    }

    /// After an edit, ensure `v.outgoing` doesn't point at the now-dead
    /// half-edge `dead`; pick any surviving outgoing edge, else isolate. We
    /// can't walk the vertex fan here (its start may be the dead edge), so we
    /// scan — merges are rare and this keeps the rotation system honest.
    fn repair_vertex_outgoing(&mut self, v: VertexId, dead: HalfEdgeId) {
        if self.vertices[v.0 as usize].outgoing != Some(dead) {
            return;
        }
        let replacement = (0..self.half_edges.len())
            .map(|i| HalfEdgeId(i as u32))
            .find(|h| {
                let he = &self.half_edges[h.0 as usize];
                he.alive && he.origin == v && *h != dead
            });
        self.vertices[v.0 as usize].outgoing = replacement;
        if replacement.is_none() {
            self.vertices[v.0 as usize].alive = false;
        }
    }

    /// Ensure `f`'s anchor half-edge is a live half-edge that still belongs to
    /// `f`; if the anchor was tombstoned (or re-homed), re-point it at any
    /// surviving member, and tombstone the face if none remain.
    fn reanchor_face_if_dead(&mut self, f: FaceId) {
        let fi = f.0 as usize;
        if fi >= self.faces.len() || !self.faces[fi].alive {
            return;
        }
        let ok = matches!(self.faces[fi].half_edge, Some(h)
            if self.half_edges[h.0 as usize].alive && self.half_edges[h.0 as usize].face == f);
        if ok {
            return;
        }
        let replacement = (0..self.half_edges.len())
            .map(|i| HalfEdgeId(i as u32))
            .find(|h| {
                let he = &self.half_edges[h.0 as usize];
                he.alive && he.face == f
            });
        self.faces[fi].half_edge = replacement;
        if replacement.is_none() {
            self.faces[fi].alive = false;
        }
    }

    fn face_patch(&self, face: FaceId) -> FacePatch {
        let outline = self.face_outline(face);
        let area = polygon_area(&outline).abs();
        let simple = is_simple_polygon(&outline);
        FacePatch { face, outline, area, simple }
    }
}

/// Iterator over the half-edges of one face cycle.
struct FaceWalk<'a> {
    plate: &'a SpacePlate,
    start: Option<HalfEdgeId>,
    cur: Option<HalfEdgeId>,
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
struct VertexFan<'a> {
    plate: &'a SpacePlate,
    start: Option<HalfEdgeId>,
    cur: Option<HalfEdgeId>,
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

// ───────────────────── arrangement (the 2D sweep) ─────────────────────

/// An undirected edge of the resolved arrangement.
struct ArrEdge {
    a: usize,
    b: usize,
    source: Option<u32>,
    half_thickness: f64,
}

/// The planar arrangement: snapped vertices + split, deduped edges. This is
/// the faithful port of the `auto-space-detect.ts` geometry, with a
/// `source` tag threaded through every stage.
struct Arrangement {
    vertices: Vec<[f64; 2]>,
    edges: Vec<ArrEdge>,
}

impl Arrangement {
    fn resolve(segments: &[InputSegment], snap: f64) -> Arrangement {
        // Corner cleanup first: real wall centrelines miss each corner by ~half
        // a wall thickness (one overshoots, the neighbour undershoots), so a
        // plain endpoint snap closes them at a skewed position → trapezoids.
        // Pull each wall-end onto the true intersection of its line with the
        // nearest crossing wall so orthogonal walls form clean rectangles.
        let mut owned: Vec<InputSegment> = segments.to_vec();
        snap_corners(&mut owned, snap);
        let segments: &[InputSegment] = &owned;
        let cell = snap.max(EPS);
        let mut vertices: Vec<[f64; 2]> = Vec::new();
        let mut grid: FxHashMap<(i64, i64), Vec<usize>> = FxHashMap::default();
        let snap_sq = snap * snap;

        let mut lookup = |pt: [f64; 2], vertices: &mut Vec<[f64; 2]>| -> usize {
            let cx = (pt[0] / cell).floor() as i64;
            let cy = (pt[1] / cell).floor() as i64;
            for dx in -1..=1 {
                for dy in -1..=1 {
                    if let Some(bucket) = grid.get(&(cx + dx, cy + dy)) {
                        for &id in bucket {
                            let ddx = vertices[id][0] - pt[0];
                            let ddy = vertices[id][1] - pt[1];
                            if ddx * ddx + ddy * ddy <= snap_sq {
                                return id;
                            }
                        }
                    }
                }
            }
            let id = vertices.len();
            vertices.push(pt);
            grid.entry((cx, cy)).or_default().push(id);
            id
        };

        // 1. Snap endpoints. `Seg` carries its source through every stage.
        let mut segs: Vec<Seg> = Vec::with_capacity(segments.len());
        for s in segments {
            let ai = lookup(s.a, &mut vertices);
            let bi = lookup(s.b, &mut vertices);
            if ai != bi {
                segs.push(Seg { a: ai, b: bi, source: s.source_element, half_thickness: s.half_thickness });
            }
        }

        // 2. T-junction snap: a dangling endpoint that lands inside another
        // segment splits that host at the projection.
        let mut guard = 0usize;
        let limit = (segments.len() * 5).max(50);
        loop {
            let mut applied = false;
            let endpoints: Vec<usize> = {
                let mut s: Vec<usize> = segs.iter().flat_map(|s| [s.a, s.b]).collect();
                s.sort_unstable();
                s.dedup();
                s
            };
            'outer: for vid in endpoints {
                let p = vertices[vid];
                for si in 0..segs.len() {
                    let Seg { a, b, source, half_thickness } = segs[si];
                    if a == vid || b == vid {
                        continue;
                    }
                    if let Some((proj, t)) = closest_point_on_segment(p, vertices[a], vertices[b]) {
                        let ddx = proj[0] - p[0];
                        let ddy = proj[1] - p[1];
                        if ddx * ddx + ddy * ddy > snap_sq {
                            continue;
                        }
                        if !(1e-6..=1.0 - 1e-6).contains(&t) {
                            continue; // endpoint, not interior
                        }
                        segs[si] = Seg { a, b: vid, source, half_thickness };
                        segs.push(Seg { a: vid, b, source, half_thickness });
                        applied = true;
                        break 'outer;
                    }
                }
            }
            guard += 1;
            if !applied || guard >= limit {
                break;
            }
        }

        // 3. Interior crossings: collect every split position per seed segment
        // in one O(N²) pass (bbox-pruned), then cut each segment once.
        let seeds: Vec<Seg> = segs.clone();
        let mut splits: Vec<Vec<(f64, usize)>> =
            seeds.iter().map(|s| vec![(0.0, s.a), (1.0, s.b)]).collect();
        let bboxes: Vec<[f64; 4]> = seeds
            .iter()
            .map(|s| {
                let (pa, pb) = (vertices[s.a], vertices[s.b]);
                [pa[0].min(pb[0]), pa[1].min(pb[1]), pa[0].max(pb[0]), pa[1].max(pb[1])]
            })
            .collect();
        for i in 0..seeds.len() {
            for j in (i + 1)..seeds.len() {
                let (si, sj) = (&seeds[i], &seeds[j]);
                if si.a == sj.a || si.a == sj.b || si.b == sj.a || si.b == sj.b {
                    continue;
                }
                let (bi, bj) = (bboxes[i], bboxes[j]);
                if bi[2] < bj[0] || bj[2] < bi[0] || bi[3] < bj[1] || bj[3] < bi[1] {
                    continue;
                }
                if let Some((point, t, u)) = segment_intersection_param(
                    vertices[si.a], vertices[si.b], vertices[sj.a], vertices[sj.b],
                ) {
                    let nv = lookup(point, &mut vertices);
                    if nv != si.a && nv != si.b {
                        splits[i].push((t, nv));
                    }
                    if nv != sj.a && nv != sj.b {
                        splits[j].push((u, nv));
                    }
                }
            }
        }

        // 4. Emit split pieces, deduped on the undirected pair.
        let mut edges: Vec<ArrEdge> = Vec::new();
        let mut seen: std::collections::HashSet<(usize, usize)> = std::collections::HashSet::new();
        for (i, mut cuts) in splits.into_iter().enumerate() {
            let source = seeds[i].source;
            let ht = seeds[i].half_thickness;
            if cuts.len() <= 2 {
                push_edge(&mut edges, &mut seen, cuts[0].1, cuts[1].1, source, ht);
                continue;
            }
            cuts.sort_by(|p, q| p.0.partial_cmp(&q.0).unwrap_or(std::cmp::Ordering::Equal));
            for w in cuts.windows(2) {
                push_edge(&mut edges, &mut seen, w[0].1, w[1].1, source, ht);
            }
        }

        Arrangement { vertices, edges }
    }
}

#[derive(Clone, Copy)]
struct Seg {
    a: usize,
    b: usize,
    source: Option<u32>,
    half_thickness: f64,
}

#[allow(clippy::too_many_arguments)]
fn push_edge(
    edges: &mut Vec<ArrEdge>,
    seen: &mut std::collections::HashSet<(usize, usize)>,
    a: usize,
    b: usize,
    source: Option<u32>,
    half_thickness: f64,
) {
    if a == b {
        return;
    }
    let key = if a < b { (a, b) } else { (b, a) };
    if seen.insert(key) {
        edges.push(ArrEdge { a, b, source, half_thickness });
    }
}

/// Intersection of the two infinite lines through `a1→b1` and `a2→b2`.
/// `None` when (near-)parallel.
fn line_intersection(a1: [f64; 2], b1: [f64; 2], a2: [f64; 2], b2: [f64; 2]) -> Option<[f64; 2]> {
    let d1 = [b1[0] - a1[0], b1[1] - a1[1]];
    let d2 = [b2[0] - a2[0], b2[1] - a2[1]];
    let denom = d1[0] * d2[1] - d1[1] * d2[0];
    if denom.abs() < EPS {
        return None;
    }
    let t = ((a2[0] - a1[0]) * d2[1] - (a2[1] - a1[1]) * d2[0]) / denom;
    Some([a1[0] + t * d1[0], a1[1] + t * d1[1]])
}

/// Pull each wall-end onto the true line-intersection with the nearest crossing
/// wall (within `tol`), so offset centrelines — whose ends miss the corner by
/// ~half a wall thickness — close into clean (e.g. rectangular) rooms instead
/// of trapezoids. Intersections are computed against the original geometry;
/// ends with no crossing wall within `tol` are left untouched (leaks stay
/// leaks). T-junctions fall out for free: an end near where its line crosses
/// another wall snaps onto that crossing.
fn snap_corners(segs: &mut [InputSegment], tol: f64) {
    let lines: Vec<([f64; 2], [f64; 2])> = segs.iter().map(|s| (s.a, s.b)).collect();
    let n = lines.len();
    let tol2 = tol * tol;
    for i in 0..n {
        for slot in 0..2 {
            let e = if slot == 0 { segs[i].a } else { segs[i].b };
            let mut best: Option<[f64; 2]> = None;
            let mut best_d2 = tol2;
            for j in 0..n {
                if i == j {
                    continue;
                }
                let Some(p) = line_intersection(lines[i].0, lines[i].1, lines[j].0, lines[j].1) else {
                    continue;
                };
                // The intersection must lie near segment j's FINITE extent, not
                // just its infinite line — else a distant aligned wall could
                // pull this end onto a phantom corner and fabricate a room.
                match closest_point_on_segment(p, lines[j].0, lines[j].1) {
                    Some((host, _)) if (host[0] - p[0]).powi(2) + (host[1] - p[1]).powi(2) <= tol2 => {}
                    _ => continue,
                }
                let d2 = (p[0] - e[0]).powi(2) + (p[1] - e[1]).powi(2);
                if d2 < best_d2 {
                    best_d2 = d2;
                    best = Some(p);
                }
            }
            if let Some(p) = best {
                if slot == 0 {
                    segs[i].a = p;
                } else {
                    segs[i].b = p;
                }
            }
        }
    }
}

fn closest_point_on_segment(q: [f64; 2], a: [f64; 2], b: [f64; 2]) -> Option<([f64; 2], f64)> {
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    let len2 = dx * dx + dy * dy;
    if len2 < 1e-12 {
        return None;
    }
    let mut t = ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / len2;
    t = t.clamp(0.0, 1.0);
    Some(([a[0] + t * dx, a[1] + t * dy], t))
}

/// Proper-crossing test. Returns the point + both parametric positions when
/// the segments cross strictly inside at least one of them (a shared endpoint
/// alone produces no new vertex). Naive f64 — see the robustness TODO.
fn segment_intersection_param(
    p1: [f64; 2], p2: [f64; 2], p3: [f64; 2], p4: [f64; 2],
) -> Option<([f64; 2], f64, f64)> {
    let denom = (p1[0] - p2[0]) * (p3[1] - p4[1]) - (p1[1] - p2[1]) * (p3[0] - p4[0]);
    if denom.abs() < EPS {
        return None;
    }
    let t = ((p1[0] - p3[0]) * (p3[1] - p4[1]) - (p1[1] - p3[1]) * (p3[0] - p4[0])) / denom;
    let u = -((p1[0] - p2[0]) * (p1[1] - p3[1]) - (p1[1] - p2[1]) * (p1[0] - p3[0])) / denom;
    let tol = 1e-7;
    if !(-tol..=1.0 + tol).contains(&t) || !(-tol..=1.0 + tol).contains(&u) {
        return None;
    }
    if (t < tol || t > 1.0 - tol) && (u < tol || u > 1.0 - tol) {
        return None;
    }
    Some(([p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])], t, u))
}

fn polygon_area(pts: &[[f64; 2]]) -> f64 {
    if pts.len() < 3 {
        return 0.0;
    }
    let mut acc = 0.0;
    for i in 0..pts.len() {
        let p = pts[i];
        let q = pts[(i + 1) % pts.len()];
        acc += p[0] * q[1] - q[0] * p[1];
    }
    acc * 0.5
}

/// Ray-cast point-in-polygon for a wall rectangle (4 corners). A face centroid
/// inside any wall rect = a wall interior / junction overlap, not a room gap.
fn point_in_quad(p: [f64; 2], quad: &[[f64; 2]; 4]) -> bool {
    let mut inside = false;
    let mut j = 3;
    for i in 0..4 {
        let (xi, yi) = (quad[i][0], quad[i][1]);
        let (xj, yj) = (quad[j][0], quad[j][1]);
        if ((yi > p[1]) != (yj > p[1])) && (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Perpendicular distance of point `p` to the infinite line through `a` and `b`
/// (degenerates to the point distance when `a == b`). Used to judge whether a
/// degree-2 node is a redundant collinear point on its neighbours' chord.
fn perp_distance(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    let len = (dx * dx + dy * dy).sqrt();
    if len < EPS {
        return ((p[0] - a[0]).powi(2) + (p[1] - a[1]).powi(2)).sqrt();
    }
    ((p[0] - a[0]) * dy - (p[1] - a[1]) * dx).abs() / len
}

/// Cheap self-intersection screen for edit feedback: O(n²) edge-pair test on a
/// single face boundary (faces are small). Not a robustness guarantee.
fn is_simple_polygon(pts: &[[f64; 2]]) -> bool {
    let n = pts.len();
    if n < 4 {
        return n == 3;
    }
    for i in 0..n {
        let a1 = pts[i];
        let a2 = pts[(i + 1) % n];
        for j in (i + 1)..n {
            // Skip shared-endpoint neighbours.
            if j == i || (i + 1) % n == j || (j + 1) % n == i {
                continue;
            }
            let b1 = pts[j];
            let b2 = pts[(j + 1) % n];
            if segment_intersection_param(a1, a2, b1, b2).is_some() {
                return false;
            }
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a closed loop of `corners` (CCW), each edge tagged with one
    /// source element id (so we can assert provenance).
    fn loop_segments(corners: &[[f64; 2]], source_base: u32) -> Vec<InputSegment> {
        let n = corners.len();
        (0..n)
            .map(|i| InputSegment::new(corners[i], corners[(i + 1) % n], Some(source_base + i as u32)))
            .collect()
    }

    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<[f64; 2]> {
        vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    }

    #[test]
    fn single_room_area_matches() {
        let segs = loop_segments(&rect(0.0, 0.0, 4.0, 3.0), 100);
        let plate = SpacePlate::build(&segs, BuildOptions::default());
        assert_eq!(plate.room_count(), 1);
        let room = plate.rooms().next().unwrap();
        assert!((plate.face_area(room) - 12.0).abs() < 1e-6, "area {}", plate.face_area(room));
    }

    #[test]
    fn face_based_room_is_the_gap_between_wall_rects() {
        // A 4×3 room boxed by four 0.2 m-thick wall rectangles (they overlap at
        // the corners, as real walls do). The room is the GAP between them: net
        // (inner faces) = 3.8×2.8 = 10.64; axis (+½t) = 4×3 = 12; gross (+t) =
        // 4.2×3.2 = 13.44. Nodes sit on the axis = the true wall mid.
        let rects = vec![
            [[-0.1, -0.1], [4.1, -0.1], [4.1, 0.1], [-0.1, 0.1]], // bottom
            [[-0.1, 2.9], [4.1, 2.9], [4.1, 3.1], [-0.1, 3.1]],   // top
            [[-0.1, -0.1], [0.1, -0.1], [0.1, 3.1], [-0.1, 3.1]], // left
            [[3.9, -0.1], [4.1, -0.1], [4.1, 3.1], [3.9, 3.1]],   // right
        ];
        let plate = SpacePlate::build_from_wall_rects(&rects, BuildOptions::default());
        assert_eq!(plate.room_count(), 1, "the gap between the four walls is the one room");
        let room = plate.rooms().next().unwrap();
        // The editable plate sits on the wall AXIS: the room outline IS the axis
        // (4×3 = 12), and net_outline recovers the inner (net) / outer (gross) faces.
        let axis = polygon_area(&plate.face_outline(room)).abs();
        assert!((axis - 12.0).abs() < 1e-6, "room outline is the wall axis (4×3=12), got {axis}");
        let net = polygon_area(&plate.net_outline(room, true)).abs();
        assert!((net - 10.64).abs() < 1e-3, "net (inner faces) = 10.64, got {net}");
        let gross = polygon_area(&plate.net_outline(room, false)).abs();
        assert!((gross - 13.44).abs() < 1e-3, "gross (outer faces) = 13.44, got {gross}");
    }

    #[test]
    fn face_based_edits_preserve_room_classification() {
        // The 4-wall box → one gap room. `is_room` is set once at build and
        // carried through edits, so neither a drag nor a split can re-classify
        // wall-interior faces into phantom rooms — and a split yields TWO rooms.
        let rects = vec![
            [[-0.1, -0.1], [4.1, -0.1], [4.1, 0.1], [-0.1, 0.1]],
            [[-0.1, 2.9], [4.1, 2.9], [4.1, 3.1], [-0.1, 3.1]],
            [[-0.1, -0.1], [0.1, -0.1], [0.1, 3.1], [-0.1, 3.1]],
            [[3.9, -0.1], [4.1, -0.1], [4.1, 3.1], [3.9, 3.1]],
        ];
        let mut plate = SpacePlate::build_from_wall_rects(&rects, BuildOptions::default());
        assert_eq!(plate.room_count(), 1);
        // The plate sits on the wall axis, so the room corners are the axis corners
        // (0,0)…(4,3). Drag one inward — must NOT spawn a phantom room.
        let corner = plate.find_vertex([4.0, 3.0]);
        plate.drag_vertex(corner, 3.7, 2.7).expect("drag");
        assert_eq!(plate.room_count(), 1, "a drag must not spawn phantom rooms");
        // Cut the room across → two rooms (both halves inherit is_room; this was
        // the "can't cut a space in half" bug).
        let room = plate.rooms().next().unwrap();
        let a = plate.find_vertex([0.0, 0.0]);
        let b = plate.find_vertex([3.7, 2.7]);
        plate.split_face(room, a, b, None).expect("split");
        assert_eq!(plate.room_count(), 2, "a split produces two rooms");
    }

    /// Two rooms sharing a central wall — the canonical "shared edge"
    /// fixture. A vertical wall at x=4 splits a 8×3 box into two 4×3 rooms.
    fn two_room_plate() -> SpacePlate {
        let segs = vec![
            // outer box
            InputSegment::new([0.0, 0.0], [8.0, 0.0], Some(1)),
            InputSegment::new([8.0, 0.0], [8.0, 3.0], Some(2)),
            InputSegment::new([8.0, 3.0], [0.0, 3.0], Some(3)),
            InputSegment::new([0.0, 3.0], [0.0, 0.0], Some(4)),
            // shared central wall
            InputSegment::new([4.0, 0.0], [4.0, 3.0], Some(99)),
        ];
        SpacePlate::build(&segs, BuildOptions::default())
    }

    #[test]
    fn shared_wall_yields_two_rooms() {
        let plate = two_room_plate();
        assert_eq!(plate.room_count(), 2, "central wall splits the box into two rooms");
        let total: f64 = plate.rooms().map(|f| plate.face_area(f)).sum();
        assert!((total - 24.0).abs() < 1e-6, "areas sum to the box: {total}");
    }

    #[test]
    fn shared_wall_is_one_edge_with_a_twin_in_the_neighbour() {
        let plate = two_room_plate();
        let rooms: Vec<FaceId> = plate.rooms().collect();
        // Find the half-edge of room[0] whose twin sits in a different room.
        let mut found = false;
        for h in plate.face_half_edges(rooms[0]) {
            if let Some(nbr) = plate.neighbor_across(h) {
                if nbr != rooms[0] && !plate.faces[nbr.0 as usize].is_outer {
                    found = true;
                    // The shared wall carries source element 99 on BOTH sides.
                    assert_eq!(plate.half_edges[h.0 as usize].source_element, Some(99));
                    let twin = plate.half_edges[h.0 as usize].twin;
                    assert_eq!(plate.half_edges[twin.0 as usize].source_element, Some(99));
                }
            }
        }
        assert!(found, "the two rooms must share exactly one wall edge via twin()");
    }

    #[test]
    fn drag_shared_vertex_updates_both_rooms_in_one_call() {
        let mut plate = two_room_plate();
        // The shared wall's bottom endpoint is the snapped vertex at (4,0).
        // Find it, then slide it to x=5 — room A grows, room B shrinks, both
        // returned by the single drag call.
        let v = (0..plate.vertices.len())
            .map(|i| VertexId(i as u32))
            .find(|v| {
                let p = plate.vertices[v.0 as usize].pos;
                (p[0] - 4.0).abs() < 1e-9 && (p[1] - 0.0).abs() < 1e-9
            })
            .expect("shared bottom vertex at (4,0)");
        let patches = plate.drag_vertex(v, 5.0, 0.0).expect("drag");
        assert_eq!(patches.len(), 2, "both incident rooms come back from one drag");
        let total: f64 = patches.iter().map(|p| p.area).sum();
        // Trapezoids, but the plate area is conserved.
        assert!((total - 24.0).abs() < 1e-6, "total area conserved under drag: {total}");
        assert!(patches.iter().all(|p| p.simple), "both faces stay simple");
        // The areas actually diverged from 12/12.
        let areas: Vec<f64> = patches.iter().map(|p| p.area).collect();
        assert!((areas[0] - areas[1]).abs() > 1.0, "drag must make the rooms unequal: {areas:?}");
    }

    #[test]
    fn split_then_areas_sum_to_parent() {
        let segs = loop_segments(&rect(0.0, 0.0, 4.0, 4.0), 200);
        let mut plate = SpacePlate::build(&segs, BuildOptions::default());
        let room = plate.rooms().next().unwrap();
        let before = plate.face_area(room);
        // Split corner (0,0)→(4,4) diagonal.
        let v00 = plate.find_vertex([0.0, 0.0]);
        let v44 = plate.find_vertex([4.0, 4.0]);
        let patches = plate.split_face(room, v00, v44, None).expect("split");
        assert_eq!(patches.len(), 2);
        assert_eq!(plate.room_count(), 2, "one room became two");
        let after: f64 = patches.iter().map(|p| p.area).sum();
        assert!((after - before).abs() < 1e-6, "split conserves area: {before} vs {after}");
        // Each child is ~half the 16 m² square = 8 m².
        for p in &patches {
            assert!((p.area - 8.0).abs() < 1e-6, "each half is 8 m²: {}", p.area);
            assert!(p.simple);
        }
    }

    #[test]
    fn split_rejects_degenerate_cuts() {
        let segs = loop_segments(&rect(0.0, 0.0, 4.0, 4.0), 300);
        let mut plate = SpacePlate::build(&segs, BuildOptions::default());
        let room = plate.rooms().next().unwrap();
        let v00 = plate.find_vertex([0.0, 0.0]);
        let v40 = plate.find_vertex([4.0, 0.0]);
        // Adjacent corners → zero-area sliver. Must reject.
        assert_eq!(plate.split_face(room, v00, v40, None), Err(EditError::DegenerateCut));
        // Same vertex twice.
        assert_eq!(plate.split_face(room, v00, v00, None), Err(EditError::DegenerateCut));
    }

    #[test]
    fn split_edge_adds_a_shared_node_without_changing_area() {
        let mut plate = two_room_plate();
        let rooms: Vec<FaceId> = plate.rooms().collect();
        let areas_before: Vec<f64> = rooms.iter().map(|f| plate.face_area(*f)).collect();
        let verts_before = plate.face_outline(rooms[0]).len();

        // The shared interior wall edge of room 0, and its midpoint.
        let shared = plate
            .face_half_edges(rooms[0])
            .find(|h| {
                plate
                    .neighbor_across(*h)
                    .map(|n| n != rooms[0] && !plate.faces[n.0 as usize].is_outer)
                    .unwrap_or(false)
            })
            .expect("shared edge");
        let a = plate.vertices[plate.half_edges[shared.0 as usize].origin.0 as usize].pos;
        let bvid = plate.half_edges[plate.half_edges[shared.0 as usize].twin.0 as usize].origin;
        let b = plate.vertices[bvid.0 as usize].pos;
        let mid = [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0];

        let n = plate.split_edge(shared, mid[0], mid[1]).expect("split_edge");
        assert_eq!(plate.vertex_position(n), Some(mid), "node sits at the requested point");
        assert_eq!(plate.room_count(), 2, "edge split creates no new face");
        let areas_after: Vec<f64> = rooms.iter().map(|f| plate.face_area(*f)).collect();
        for (a0, a1) in areas_before.iter().zip(&areas_after) {
            assert!((a0 - a1).abs() < 1e-6, "areas unchanged on-segment: {a0} vs {a1}");
        }
        assert_eq!(plate.face_outline(rooms[0]).len(), verts_before + 1, "room 0 gained the node");
        assert!(
            plate.face_outline(rooms[1]).iter().any(|p| (p[0] - mid[0]).abs() < 1e-9 && (p[1] - mid[1]).abs() < 1e-9),
            "the neighbour room shares the new node",
        );
    }

    #[test]
    fn merge_undoes_a_shared_wall() {
        let mut plate = two_room_plate();
        assert_eq!(plate.room_count(), 2);
        // Find the interior shared edge.
        let rooms: Vec<FaceId> = plate.rooms().collect();
        let shared = plate
            .face_half_edges(rooms[0])
            .find(|h| {
                plate
                    .neighbor_across(*h)
                    .map(|n| n != rooms[0] && !plate.faces[n.0 as usize].is_outer)
                    .unwrap_or(false)
            })
            .expect("shared edge");
        let patches = plate.merge_faces(shared).expect("merge");
        assert_eq!(patches.len(), 1, "merge returns the surviving room");
        assert_eq!(plate.room_count(), 1, "two rooms became one");
        assert!((patches[0].area - 24.0).abs() < 1e-6, "merged area = full box: {}", patches[0].area);
        assert!(patches[0].simple, "merged room is a clean rectangle");
    }

    #[test]
    fn merge_rejects_exterior_walls() {
        let mut plate = two_room_plate();
        let rooms: Vec<FaceId> = plate.rooms().collect();
        // An edge whose twin is the exterior.
        let exterior_edge = plate
            .face_half_edges(rooms[0])
            .find(|h| {
                plate
                    .neighbor_across(*h)
                    .map(|n| plate.faces[n.0 as usize].is_outer)
                    .unwrap_or(false)
            })
            .expect("an outer wall");
        assert_eq!(plate.merge_faces(exterior_edge), Err(EditError::BordersExterior));
    }

    #[test]
    fn offset_centrelines_close_into_a_clean_rectangle() {
        // An 8×8 room whose wall centrelines miss each corner by ~0.1 m (one
        // wall overshoots, the neighbour undershoots) — the real-world case
        // that produced trapezoids. Corner-snap must recover the exact
        // rectangle (area 64), not a skewed quad.
        let segs = vec![
            InputSegment::new([-0.1, 8.0], [8.1, 8.0], Some(1)), // top, overshoots both ends
            InputSegment::new([8.0, 7.9], [8.0, -0.1], Some(2)), // right, undershoots top
            InputSegment::new([8.1, 0.0], [-0.1, 0.0], Some(3)), // bottom
            InputSegment::new([0.0, 8.1], [0.0, 0.1], Some(4)),  // left, undershoots bottom
        ];
        let plate = SpacePlate::build(&segs, BuildOptions { snap_tolerance: 0.25, min_area: 0.5 });
        assert_eq!(plate.room_count(), 1, "the four offset walls close into one room");
        let room = plate.rooms().next().unwrap();
        assert!(
            (plate.face_area(room) - 64.0).abs() < 1e-6,
            "corners must snap to the line intersections → exact 8×8; got {}",
            plate.face_area(room),
        );
    }

    #[test]
    fn corner_snap_skips_distant_wall_extensions() {
        // A short wall's end (1.9, 0) sits near where a FAR wall's line (x=2,
        // y 3..8) would cross, but that wall is nowhere near — the corner-snap
        // must NOT pull the end onto the phantom (2, 0).
        let mut segs = vec![
            InputSegment::new([0.0, 0.0], [1.9, 0.0], None),
            InputSegment::new([2.0, 3.0], [2.0, 8.0], None),
        ];
        super::snap_corners(&mut segs, 0.25);
        let e = segs[0].b;
        assert!(
            (e[0] - 1.9).abs() < 1e-9 && e[1].abs() < 1e-9,
            "end must stay put (no phantom snap to 2,0): {e:?}",
        );
    }

    #[test]
    fn t_junction_closes_a_room_without_shared_corners() {
        // Two rooms where the central wall's axis ends ON the outer walls'
        // interiors (no shared corner vertex) — the messy-IFC case the TS
        // detector's T-junction pass exists for. Central wall runs y=0..3 at
        // x=4 but its endpoints are at (4, 0.02) and (4, 2.98), i.e. they
        // don't coincide with the box corners; T-junction snap must still
        // close two rooms.
        let segs = vec![
            InputSegment::new([0.0, 0.0], [8.0, 0.0], Some(1)),
            InputSegment::new([8.0, 0.0], [8.0, 3.0], Some(2)),
            InputSegment::new([8.0, 3.0], [0.0, 3.0], Some(3)),
            InputSegment::new([0.0, 3.0], [0.0, 0.0], Some(4)),
            InputSegment::new([4.0, 0.02], [4.0, 2.98], Some(99)),
        ];
        let plate = SpacePlate::build(&segs, BuildOptions { snap_tolerance: 0.1, min_area: 0.5 });
        assert_eq!(plate.room_count(), 2, "T-junction snap should still yield two rooms");
    }

    #[test]
    fn queries_tolerate_invalid_face_ids() {
        // A stale/out-of-range face id from JS must not panic the wasm module.
        let plate = two_room_plate();
        let bogus = FaceId(99_999);
        assert_eq!(plate.face_area(bogus), 0.0);
        assert!(plate.face_outline(bogus).is_empty());
        assert!(plate.bounding_elements(bogus).is_empty());
    }

    #[test]
    fn clone_is_independent_for_undo_snapshots() {
        // The wasm handle's `duplicate()` clones the plate for undo/redo.
        // Editing the clone must NOT touch the original (and vice-versa) —
        // that independence is what makes the undo stack correct.
        let plate = two_room_plate();
        let snapshot = plate.clone();

        let mut edited = plate;
        // Collapse a room by merging across the shared wall on the edited copy.
        let rooms: Vec<FaceId> = edited.rooms().collect();
        let shared = edited
            .face_half_edges(rooms[0])
            .find(|h| {
                edited
                    .neighbor_across(*h)
                    .map(|n| n != rooms[0] && !edited.faces[n.0 as usize].is_outer)
                    .unwrap_or(false)
            })
            .expect("shared edge");
        edited.merge_faces(shared).expect("merge");

        assert_eq!(edited.room_count(), 1, "edited copy merged to one room");
        assert_eq!(snapshot.room_count(), 2, "snapshot is untouched by the edit");
        let snap_total: f64 = snapshot.rooms().map(|f| snapshot.face_area(f)).sum();
        assert!((snap_total - 24.0).abs() < 1e-6, "snapshot geometry intact: {snap_total}");
    }

    #[test]
    fn provenance_distinguishes_walls_from_user_splits() {
        let segs = loop_segments(&rect(0.0, 0.0, 4.0, 4.0), 500);
        let mut plate = SpacePlate::build(&segs, BuildOptions::default());
        let room = plate.rooms().next().unwrap();
        // Every boundary edge of the derived room came from a real wall.
        for (_h, src) in plate.bounding_elements(room) {
            assert!(src.is_some(), "derived walls carry their source element");
        }
        // After a user split with source None, the new partition is unsourced.
        let v00 = plate.find_vertex([0.0, 0.0]);
        let v44 = plate.find_vertex([4.0, 4.0]);
        plate.split_face(room, v00, v44, None).expect("split");
        let child = plate.rooms().next().unwrap();
        let unsourced = plate
            .bounding_elements(child)
            .iter()
            .filter(|(_, s)| s.is_none())
            .count();
        assert!(unsourced >= 1, "the user-drawn partition has no source element");
    }

    #[test]
    fn dissolve_is_the_inverse_of_split_edge() {
        let mut plate = two_room_plate();
        let rooms: Vec<FaceId> = plate.rooms().collect();
        let areas_before: Vec<f64> = rooms.iter().map(|f| plate.face_area(*f)).collect();
        let verts_before: Vec<usize> = rooms.iter().map(|f| plate.face_outline(*f).len()).collect();
        // Add a node mid-shared-wall, then dissolve it back out.
        let shared = plate
            .face_half_edges(rooms[0])
            .find(|h| {
                plate
                    .neighbor_across(*h)
                    .map(|n| n != rooms[0] && !plate.faces[n.0 as usize].is_outer)
                    .unwrap_or(false)
            })
            .expect("shared edge");
        let a = plate.vertices[plate.half_edges[shared.0 as usize].origin.0 as usize].pos;
        let bvid = plate.half_edges[plate.half_edges[shared.0 as usize].twin.0 as usize].origin;
        let b = plate.vertices[bvid.0 as usize].pos;
        let mid = [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0];
        let n = plate.split_edge(shared, mid[0], mid[1]).expect("split_edge");
        assert_eq!(plate.face_outline(rooms[0]).len(), verts_before[0] + 1, "node added");

        let patches = plate.dissolve_vertex(n).expect("dissolve the node");
        assert_eq!(patches.len(), 2, "both rooms touching the welded wall come back");
        assert_eq!(plate.vertex_position(n), None, "the node is tombstoned");
        assert_eq!(plate.room_count(), 2, "no room added or lost");
        for (f, (a0, v0)) in rooms.iter().zip(areas_before.iter().zip(&verts_before)) {
            assert!((plate.face_area(*f) - a0).abs() < 1e-6, "area restored");
            assert_eq!(plate.face_outline(*f).len(), *v0, "vertex count restored");
        }
    }

    #[test]
    fn dissolve_corner_straightens_the_room() {
        // A 4×3 rectangle; dropping corner (0,0) leaves the triangle
        // (4,0)-(4,3)-(0,3) = 12 − 6 = 6 m².
        let segs = loop_segments(&rect(0.0, 0.0, 4.0, 3.0), 400);
        let mut plate = SpacePlate::build(&segs, BuildOptions::default());
        let v00 = plate.find_vertex([0.0, 0.0]);
        let patches = plate.dissolve_vertex(v00).expect("dissolve a convex corner");
        assert_eq!(plate.room_count(), 1);
        assert_eq!(patches.len(), 1, "one incident room (the other side is exterior)");
        assert!((patches[0].area - 6.0).abs() < 1e-6, "area = 6 m²: {}", patches[0].area);
        assert!(patches[0].simple, "the triangle stays simple");
        assert_eq!(plate.face_outline(patches[0].face).len(), 3, "now a triangle");
    }

    #[test]
    fn dissolve_rejects_a_wall_junction() {
        // (4,0) is where the central wall meets the bottom wall: degree 3.
        let mut plate = two_room_plate();
        let junction = plate.find_vertex([4.0, 0.0]);
        assert_eq!(plate.dissolve_vertex(junction), Err(EditError::VertexNotDissolvable));
    }

    #[test]
    fn dissolve_rejects_triangle_collapse() {
        // A triangle room: dropping any corner welds two already-adjacent
        // neighbours into a parallel edge → a digon. Reject.
        let segs = loop_segments(&[[0.0, 0.0], [4.0, 0.0], [0.0, 3.0]], 500);
        let mut plate = SpacePlate::build(&segs, BuildOptions::default());
        assert_eq!(plate.room_count(), 1, "triangle is one room");
        let corner = plate.find_vertex([0.0, 0.0]);
        assert_eq!(plate.dissolve_vertex(corner), Err(EditError::DegenerateCut));
    }

    #[test]
    fn dissolve_rejects_a_stale_handle() {
        let mut plate = two_room_plate();
        assert_eq!(plate.dissolve_vertex(VertexId(9999)), Err(EditError::StaleHandle));
    }

    #[test]
    fn add_face_creates_a_room_on_an_empty_plate() {
        let mut plate = SpacePlate::build(&[], BuildOptions::default());
        assert_eq!(plate.room_count(), 0, "no walls → no rooms");
        let patch = plate.add_face(&rect(0.0, 0.0, 5.0, 4.0), None).expect("draw a room");
        assert_eq!(plate.room_count(), 1, "the drawn room exists");
        assert!((patch.area - 20.0).abs() < 1e-6, "area = 20 m²: {}", patch.area);
        assert!(patch.simple);
        assert!((plate.face_area(patch.face) - 20.0).abs() < 1e-6, "queryable like any room");
    }

    #[test]
    fn add_face_normalises_clockwise_winding() {
        let mut plate = SpacePlate::build(&[], BuildOptions::default());
        // CW ring (reverse of a rect): area must still come out correct.
        let cw = vec![[0.0, 0.0], [0.0, 4.0], [5.0, 4.0], [5.0, 0.0]];
        let patch = plate.add_face(&cw, Some(7)).expect("draw a CW room");
        assert!((patch.area - 20.0).abs() < 1e-6, "winding normalised: {}", patch.area);
        assert!(polygon_area(&patch.outline) > 0.0, "interior face winds CCW");
    }

    #[test]
    fn add_face_into_an_existing_plate_keeps_the_old_rooms() {
        let mut plate = two_room_plate();
        let before: f64 = plate.rooms().map(|f| plate.face_area(f)).sum();
        plate.add_face(&rect(20.0, 20.0, 23.0, 22.0), None).expect("draw a third room"); // 3×2 = 6 m²
        assert_eq!(plate.room_count(), 3, "two original + one drawn");
        let total: f64 = plate.rooms().map(|f| plate.face_area(f)).sum();
        assert!((total - (before + 6.0)).abs() < 1e-6, "old rooms intact: {total} vs {}", before + 6.0);
    }

    #[test]
    fn add_face_rejects_bad_rings() {
        let mut plate = SpacePlate::build(&[], BuildOptions::default());
        // Too few points.
        assert_eq!(plate.add_face(&[[0.0, 0.0], [1.0, 0.0]], None), Err(EditError::InvalidPolygon));
        // Self-intersecting bow-tie.
        let bowtie = vec![[0.0, 0.0], [4.0, 4.0], [4.0, 0.0], [0.0, 4.0]];
        assert_eq!(plate.add_face(&bowtie, None), Err(EditError::InvalidPolygon));
        // Collinear (zero area).
        let line = vec![[0.0, 0.0], [2.0, 0.0], [4.0, 0.0]];
        assert_eq!(plate.add_face(&line, None), Err(EditError::InvalidPolygon));
        // Consecutive duplicate point (zero-length edge) — non-zero area, but a
        // degenerate edge that is_simple_polygon misses. Reachable via a
        // double-click that lands the final corner twice.
        let dup = vec![[0.0, 0.0], [0.0, 0.0], [4.0, 0.0], [4.0, 4.0]];
        assert_eq!(plate.add_face(&dup, None), Err(EditError::InvalidPolygon));
        // Repeated closing point (first == last) — the wrap-around case.
        let closed = vec![[0.0, 0.0], [4.0, 0.0], [4.0, 4.0], [0.0, 0.0]];
        assert_eq!(plate.add_face(&closed, None), Err(EditError::InvalidPolygon));
    }

    // ───────────────── orphan removal + auto-cleanup ─────────────────

    /// rect(0,0,4,3) plus a spur wall poking out of the right wall's midpoint
    /// to (6, 1.5). The T-junction snap splits the right wall at (4,1.5), so
    /// the arrangement carries a degree-1 tip at (6,1.5) and a redundant
    /// collinear node at (4,1.5).
    fn spur_segs() -> Vec<InputSegment> {
        let mut s = loop_segments(&rect(0.0, 0.0, 4.0, 3.0), 100);
        s.push(InputSegment::new([4.0, 1.5], [6.0, 1.5], Some(200)));
        s
    }

    /// Build the spur plate WITHOUT the `build` auto-prune (via the raw
    /// `from_arrangement`) so the spur survives for the removal/prune tests.
    fn spur_plate_unpruned() -> SpacePlate {
        let arr = Arrangement::resolve(&spur_segs(), 0.1);
        SpacePlate::from_arrangement(arr, 0.5)
    }

    fn live_vertex_count(plate: &SpacePlate) -> usize {
        (0..plate.vertices.len()).filter(|&i| plate.vertices[i].alive).count()
    }

    #[test]
    fn spur_fixture_actually_has_a_spur() {
        let plate = spur_plate_unpruned();
        assert_eq!(plate.room_count(), 1, "the rectangle is still one room");
        let tip = plate.find_vertex([6.0, 1.5]);
        assert_eq!(plate.vertex_degree(tip), 1, "the spur end is a degree-1 tip");
        let junction = plate.find_vertex([4.0, 1.5]);
        assert_eq!(plate.vertex_degree(junction), 3, "the spur base is a T-junction");
    }

    #[test]
    fn remove_spur_edge_drops_the_tip_and_keeps_area() {
        let mut plate = spur_plate_unpruned();
        let area_before: f64 = plate.rooms().map(|f| plate.face_area(f)).sum();
        let tip = plate.find_vertex([6.0, 1.5]);
        let spur_he = plate.outgoing_half_edges(tip).next().expect("tip has an outgoing he");
        plate.remove_spur_edge(spur_he).expect("remove the spur");
        assert_eq!(plate.vertex_position(tip), None, "the tip is tombstoned");
        assert_eq!(plate.room_count(), 1, "no room gained or lost");
        let area_after: f64 = plate.rooms().map(|f| plate.face_area(f)).sum();
        assert!(
            (area_before - area_after).abs() < 1e-6,
            "spur removal is area-neutral: {area_before} vs {area_after}",
        );
    }

    #[test]
    fn remove_spur_edge_rejects_a_non_tip_and_a_stale_handle() {
        let mut plate = spur_plate_unpruned();
        // Any room boundary edge has both ends at degree ≥ 2 → not a spur.
        let room = plate.rooms().next().unwrap();
        let non_spur = plate.face_half_edges(room).next().expect("a room edge");
        assert_eq!(plate.remove_spur_edge(non_spur), Err(EditError::VertexNotDissolvable));
        assert_eq!(plate.remove_spur_edge(HalfEdgeId(99_999)), Err(EditError::StaleHandle));
    }

    #[test]
    fn prune_orphans_removes_the_spur_and_dissolves_the_exposed_node() {
        let mut plate = spur_plate_unpruned();
        let room = plate.rooms().next().unwrap();
        assert!(
            plate.face_outline(room).len() >= 5,
            "unpruned room boundary carries the T-junction node",
        );
        let removed = plate.prune_orphans();
        assert!(removed >= 2, "pruned the spur edge + the now-collinear node: {removed}");
        let room = plate.rooms().next().unwrap();
        assert_eq!(plate.face_outline(room).len(), 4, "back to a clean 4-corner rectangle");
        assert!((plate.face_area(room) - 12.0).abs() < 1e-6, "area unchanged: {}", plate.face_area(room));
        assert_eq!(live_vertex_count(&plate), 4, "only the four corners survive");
    }

    #[test]
    fn prune_orphans_is_idempotent_and_a_noop_on_clean_plates() {
        // Clean by construction (build auto-prunes) → nothing to do.
        let mut clean = two_room_plate();
        assert_eq!(clean.prune_orphans(), 0, "a clean two-room plate prunes nothing");
        assert_eq!(clean.room_count(), 2);
        let total: f64 = clean.rooms().map(|f| clean.face_area(f)).sum();
        assert!((total - 24.0).abs() < 1e-6, "areas intact: {total}");
        // A second prune right after a real one finds nothing.
        let mut messy = spur_plate_unpruned();
        messy.prune_orphans();
        assert_eq!(messy.prune_orphans(), 0, "prune is idempotent");
    }

    #[test]
    fn prune_keeps_genuine_corners() {
        let segs = loop_segments(&rect(0.0, 0.0, 4.0, 3.0), 100);
        let mut plate = SpacePlate::build(&segs, BuildOptions::default());
        assert_eq!(plate.prune_orphans(), 0, "a clean rectangle has nothing to prune");
        assert_eq!(
            plate.face_outline(plate.rooms().next().unwrap()).len(),
            4,
            "all four real corners are kept (not mistaken for collinear)",
        );
    }

    #[test]
    fn build_auto_prunes_spur_walls() {
        let plate = SpacePlate::build(&spur_segs(), BuildOptions::default());
        assert_eq!(plate.room_count(), 1, "the spur doesn't create a phantom room");
        let room = plate.rooms().next().unwrap();
        assert_eq!(plate.face_outline(room).len(), 4, "derived room is a clean rectangle, no spur stub");
        assert!((plate.face_area(room) - 12.0).abs() < 1e-6, "area is the rectangle: {}", plate.face_area(room));
    }

    #[test]
    fn remove_edge_merges_two_real_rooms() {
        let mut plate = two_room_plate();
        let rooms: Vec<FaceId> = plate.rooms().collect();
        let shared = plate
            .face_half_edges(rooms[0])
            .find(|h| {
                plate
                    .neighbor_across(*h)
                    .map(|n| n != rooms[0] && !plate.faces[n.0 as usize].is_outer)
                    .unwrap_or(false)
            })
            .expect("shared edge");
        let patches = plate.remove_edge(shared).expect("remove the shared wall");
        assert_eq!(plate.room_count(), 1, "two rooms merged into one");
        let total: f64 = patches.iter().map(|p| p.area).sum();
        assert!((total - 24.0).abs() < 1e-6, "merged area = full box: {total}");
    }

    #[test]
    fn remove_edge_refuses_an_enclosing_wall() {
        let mut plate = two_room_plate();
        let rooms: Vec<FaceId> = plate.rooms().collect();
        let exterior_edge = plate
            .face_half_edges(rooms[0])
            .find(|h| {
                plate
                    .neighbor_across(*h)
                    .map(|n| plate.faces[n.0 as usize].is_outer)
                    .unwrap_or(false)
            })
            .expect("an outer wall");
        assert_eq!(plate.remove_edge(exterior_edge), Err(EditError::BordersExterior));
    }

    #[test]
    fn remove_edge_deletes_a_bridge_and_cleans_orphans() {
        let mut plate = spur_plate_unpruned();
        let tip = plate.find_vertex([6.0, 1.5]);
        let spur = plate.outgoing_half_edges(tip).next().expect("spur he");
        // Both of the spur's half-edges sit in the same (exterior) face → bridge.
        let t = plate.half_edges[spur.0 as usize].twin;
        assert_eq!(
            plate.half_edges[spur.0 as usize].face,
            plate.half_edges[t.0 as usize].face,
            "the spur is a bridge (same face both sides)",
        );
        let patches = plate.remove_edge(spur).expect("remove the bridge/spur wall");
        assert!(patches.is_empty(), "a bridge in the exterior bounds no room");
        assert_eq!(plate.room_count(), 1, "the rectangle room survives");
        let room = plate.rooms().next().unwrap();
        assert_eq!(plate.face_outline(room).len(), 4, "room cleaned back to a rectangle");
        assert!((plate.face_area(room) - 12.0).abs() < 1e-6, "area unchanged: {}", plate.face_area(room));
    }

    #[test]
    fn remove_edge_rejects_a_stale_handle() {
        let mut plate = two_room_plate();
        assert_eq!(plate.remove_edge(HalfEdgeId(99_999)), Err(EditError::StaleHandle));
    }

    // ───────────────── net-area (wall-thickness offset) ─────────────────

    /// A closed loop with a uniform wall half-thickness on every edge.
    fn thick_loop(corners: &[[f64; 2]], base: u32, half: f64) -> Vec<InputSegment> {
        loop_segments(corners, base).into_iter().map(|s| s.with_half_thickness(half)).collect()
    }

    fn thick_two_room_plate(half: f64) -> SpacePlate {
        let segs = vec![
            InputSegment::new([0.0, 0.0], [8.0, 0.0], Some(1)).with_half_thickness(half),
            InputSegment::new([8.0, 0.0], [8.0, 3.0], Some(2)).with_half_thickness(half),
            InputSegment::new([8.0, 3.0], [0.0, 3.0], Some(3)).with_half_thickness(half),
            InputSegment::new([0.0, 3.0], [0.0, 0.0], Some(4)).with_half_thickness(half),
            InputSegment::new([4.0, 0.0], [4.0, 3.0], Some(99)).with_half_thickness(half),
        ];
        SpacePlate::build(&segs, BuildOptions::default())
    }

    #[test]
    fn net_outline_insets_and_outsets_by_the_wall_half_thickness() {
        let plate = SpacePlate::build(&thick_loop(&rect(0.0, 0.0, 4.0, 3.0), 100, 0.25), BuildOptions::default());
        let room = plate.rooms().next().unwrap();
        // Inner: 0.25 in on every side → 3.5 × 2.5 = 8.75 m².
        let inner = polygon_area(&plate.net_outline(room, true)).abs();
        assert!((inner - 8.75).abs() < 1e-6, "inset 0.25 all round = 8.75, got {inner}");
        // Outer: 0.25 out on every side → 4.5 × 3.5 = 15.75 m².
        let outer = polygon_area(&plate.net_outline(room, false)).abs();
        assert!((outer - 15.75).abs() < 1e-6, "outset 0.25 all round = 15.75, got {outer}");
    }

    #[test]
    fn net_outline_is_the_centreline_without_thickness() {
        // loop_segments leaves half_thickness at 0 → nothing to offset.
        let plate = SpacePlate::build(&loop_segments(&rect(0.0, 0.0, 4.0, 3.0), 100), BuildOptions::default());
        let room = plate.rooms().next().unwrap();
        assert_eq!(plate.net_outline(room, true), plate.face_outline(room), "no thickness → unchanged");
        assert_eq!(plate.net_outline(room, false), plate.face_outline(room));
    }

    #[test]
    fn net_outline_pins_a_shared_wall_when_pushing_outward() {
        let plate = thick_two_room_plate(0.25);
        assert_eq!(plate.room_count(), 2);
        // The left room (centroid x < 4) shares the central wall at x = 4.
        let left = plate
            .rooms()
            .find(|f| {
                let o = plate.face_outline(*f);
                (o.iter().map(|p| p[0]).sum::<f64>() / o.len() as f64) < 4.0
            })
            .expect("a left room");
        let outer = plate.net_outline(left, false);
        let max_x = outer.iter().map(|p| p[0]).fold(f64::MIN, f64::max);
        let min_x = outer.iter().map(|p| p[0]).fold(f64::MAX, f64::min);
        assert!((max_x - 4.0).abs() < 1e-6, "shared wall (x=4) is pinned outward, got {max_x}");
        assert!((min_x + 0.25).abs() < 1e-6, "the exterior wall pushes out to -0.25, got {min_x}");
    }

    #[test]
    fn net_outline_thickness_survives_an_edge_split() {
        let mut plate = SpacePlate::build(&thick_loop(&rect(0.0, 0.0, 4.0, 3.0), 100, 0.25), BuildOptions::default());
        let room = plate.rooms().next().unwrap();
        // Split the bottom edge (y = 0) at its midpoint; both halves keep 0.25.
        let bottom = plate
            .face_half_edges(room)
            .find(|h| {
                let a = plate.vertices[plate.half_edges[h.0 as usize].origin.0 as usize].pos;
                let b = plate.vertices[plate.dest(*h).0 as usize].pos;
                a[1].abs() < 1e-9 && b[1].abs() < 1e-9
            })
            .expect("the bottom edge");
        plate.split_edge(bottom, 2.0, 0.0).expect("split");
        let inner = polygon_area(&plate.net_outline(room, true)).abs();
        assert!((inner - 8.75).abs() < 1e-6, "the split edge keeps its wall thickness: {inner}");
    }

    // Test-only helper.
    impl SpacePlate {
        fn find_vertex(&self, pt: [f64; 2]) -> VertexId {
            (0..self.vertices.len())
                .map(|i| VertexId(i as u32))
                .find(|v| {
                    let p = self.vertices[v.0 as usize].pos;
                    self.vertices[v.0 as usize].alive
                        && (p[0] - pt[0]).abs() < 1e-6
                        && (p[1] - pt[1]).abs() < 1e-6
                })
                .unwrap_or_else(|| panic!("no live vertex near {pt:?}"))
        }
    }
}

// TODO(space-dcel, follow-ups for the real feature):
//  - Robust predicates: `segment_intersection_param` is naive f64. Share the
//    adaptive-orientation floor being built for the pure-Rust CSG kernel
//    (csg-predicate-floor worktree) so dense national-grid wall sets don't
//    accumulate snap error.
//  - Holes / nested faces: a CW cycle is treated as exterior, so a room
//    enclosing a courtyard is mishandled. Add containment nesting.
//  - Net vs gross area: faces are centreline. Net area = inset each bounding
//    edge by half its source wall's thickness at quantity time; thickness must
//    ride `InputSegment` (extend with a `half_thickness` field).
//  - Leak diagnostics: detect open half-edges (a boundary that fails to close)
//    and surface them as per-face repair markers (§2.4 of the RFC).
//  - WASM seam: wrap `SpacePlate` in a stateful handle on `IfcAPI` with
//    explicit create/free — long-lived handles share the dlmalloc-GC hazard
//    from the cache-load crash fix; do NOT rely on JS GC to drop it.
