// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Finite edge incidence for extended opening cutters (#7635).
//!
//! An infinite plane alone does not identify the surface a cutter belongs to.
//! Here a cutter arris must contain a complete host arris exactly. Both edges
//! need two opposite uses on noncoplanar faces: a triangulation diagonal or a
//! nonmanifold edge supplies no certificate. An incident cutter face must
//! also be exactly coplanar with the protected host face: a crossing angular
//! sector sharing only the arris is not evidence of an existing wall. No
//! distance tolerance is used.

use super::incidence::{key, Key};
use super::Tri;
use rustc_hash::FxHashMap;

type Point = [f64; 3];
type EdgeKey = (Key, Key);

#[derive(Clone, Copy)]
struct Side {
    third: Point,
    forward: bool,
}
struct Edge {
    ends: [Point; 2],
    sides: [Option<Side>; 2],
    nonmanifold: bool,
}

pub(super) struct Edges(FxHashMap<EdgeKey, Edge>);

impl Edges {
    pub(super) fn new<'a>(tris: impl Iterator<Item = &'a Tri>) -> Self {
        let mut edges: FxHashMap<EdgeKey, Edge> = FxHashMap::default();
        for t in tris {
            for i in 0..3 {
                let (a, b) = (t[i], t[(i + 1) % 3]);
                let (ka, kb) = (key(&a), key(&b));
                if ka == kb {
                    continue;
                }
                let forward = ka < kb;
                let edge = edges
                    .entry((ka.min(kb), ka.max(kb)))
                    .or_insert_with(|| Edge {
                        ends: [a, b],
                        sides: [None, None],
                        nonmanifold: false,
                    });
                if edge.sides[1].is_some() {
                    edge.nonmanifold = true;
                } else {
                    let slot = usize::from(edge.sides[0].is_some());
                    edge.sides[slot] = Some(Side {
                        third: t[(i + 2) % 3],
                        forward,
                    });
                }
            }
        }
        Self(edges)
    }

    pub(super) fn is_arris(&self, a: &Point, b: &Point) -> bool {
        let (a, b) = (key(a), key(b));
        self.0.get(&(a.min(b), a.max(b))).is_some_and(is_arris)
    }
}

fn is_arris(edge: &Edge) -> bool {
    let [Some(a), Some(b)] = edge.sides else {
        return false;
    };
    !edge.nonmanifold
        && a.forward != b.forward
        && geometry_predicates::orient3d(edge.ends[0], edge.ends[1], a.third, b.third) != 0.0
}

/// Original cutter adjacency, captured before any vertex is welded. Every
/// copy of one coordinate therefore sees the same finite-edge certificate.
struct IncidentEdge {
    end: Point,
    thirds: [Point; 2],
}

pub(super) struct CutterEdges(FxHashMap<Key, Vec<IncidentEdge>>);

impl CutterEdges {
    pub(super) fn new(cutter: &[Tri]) -> Self {
        let edges = Edges::new(cutter.iter());
        let mut at: FxHashMap<Key, Vec<IncidentEdge>> = FxHashMap::default();
        for edge in edges.0.values().filter(|e| is_arris(e)) {
            let [a, b] = edge.ends;
            let [Some(first), Some(second)] = edge.sides else {
                unreachable!()
            };
            let thirds = [first.third, second.third];
            at.entry(key(&a))
                .or_default()
                .push(IncidentEdge { end: b, thirds });
            at.entry(key(&b))
                .or_default()
                .push(IncidentEdge { end: a, thirds });
        }
        Self(at)
    }

    pub(super) fn contains(&self, v: &Point, a: &Point, b: &Point, face: &Tri) -> bool {
        let on_plane =
            |p: Point| geometry_predicates::orient3d(face[0], face[1], face[2], p) == 0.0;
        self.0.get(&key(v)).is_some_and(|ends| {
            ends.iter().any(|edge| {
                on_segment(v, &edge.end, a)
                    && on_segment(v, &edge.end, b)
                    && on_plane(*v)
                    && on_plane(edge.end)
                    && edge.thirds.iter().any(|&p| on_plane(p))
            })
        })
    }
}

fn on_segment(a: &Point, b: &Point, p: &Point) -> bool {
    (0..3).all(|i| a[i].min(b[i]) <= p[i] && p[i] <= a[i].max(b[i]))
        && [(0, 1), (0, 2), (1, 2)].into_iter().all(|(i, j)| {
            geometry_predicates::orient2d([a[i], a[j]], [b[i], b[j]], [p[i], p[j]]) == 0.0
        })
}

#[cfg(test)]
#[path = "finite_tests.rs"]
mod tests;
