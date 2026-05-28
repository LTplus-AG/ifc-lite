// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Portions derived from csg.js (Copyright (c) 2011 Evan Wallace,
// http://madebyevan.com/), used under the MIT License:
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions: The above copyright
// notice and this permission notice shall be included in all copies or
// substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS",
// WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.

//! BSP-tree CSG (Constructive Solid Geometry) implementation.
//!
//! Classic algorithm from csg.js by Evan Wallace.
//! Supports difference, union, and intersection of triangle meshes.

const EPSILON: f64 = 1e-5;

const COPLANAR: u8 = 0;
const FRONT: u8 = 1;
const BACK: u8 = 2;
const SPANNING: u8 = 3;

#[derive(Clone, Debug)]
pub struct Vertex {
    pub pos: [f64; 3],
    pub normal: [f64; 3],
}

impl Vertex {
    pub fn new(pos: [f64; 3], normal: [f64; 3]) -> Self {
        Self { pos, normal }
    }

    fn interpolate(&self, other: &Vertex, t: f64) -> Vertex {
        Vertex {
            pos: [
                self.pos[0] + t * (other.pos[0] - self.pos[0]),
                self.pos[1] + t * (other.pos[1] - self.pos[1]),
                self.pos[2] + t * (other.pos[2] - self.pos[2]),
            ],
            normal: [
                self.normal[0] + t * (other.normal[0] - self.normal[0]),
                self.normal[1] + t * (other.normal[1] - self.normal[1]),
                self.normal[2] + t * (other.normal[2] - self.normal[2]),
            ],
        }
    }

    fn flip(&mut self) {
        self.normal[0] = -self.normal[0];
        self.normal[1] = -self.normal[1];
        self.normal[2] = -self.normal[2];
    }
}

#[derive(Clone, Debug)]
pub struct Polygon {
    pub vertices: Vec<Vertex>,
}

impl Polygon {
    pub fn new(vertices: Vec<Vertex>) -> Self {
        Self { vertices }
    }

    fn flip(&mut self) {
        self.vertices.reverse();
        for v in &mut self.vertices {
            v.flip();
        }
    }
}

#[derive(Clone, Debug)]
struct Plane {
    normal: [f64; 3],
    w: f64,
}

impl Plane {
    fn from_polygon(poly: &Polygon) -> Option<Self> {
        if poly.vertices.len() < 3 {
            return None;
        }
        let a = &poly.vertices[0].pos;
        let b = &poly.vertices[1].pos;
        let c = &poly.vertices[2].pos;

        let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];

        let n = [
            ab[1] * ac[2] - ab[2] * ac[1],
            ab[2] * ac[0] - ab[0] * ac[2],
            ab[0] * ac[1] - ab[1] * ac[0],
        ];

        let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        if len < 1e-10 {
            return None;
        }

        let normal = [n[0] / len, n[1] / len, n[2] / len];
        let w = normal[0] * a[0] + normal[1] * a[1] + normal[2] * a[2];

        Some(Plane { normal, w })
    }

    fn flip(&mut self) {
        self.normal[0] = -self.normal[0];
        self.normal[1] = -self.normal[1];
        self.normal[2] = -self.normal[2];
        self.w = -self.w;
    }

    fn split_polygon(
        &self,
        polygon: &Polygon,
        coplanar_front: &mut Vec<Polygon>,
        coplanar_back: &mut Vec<Polygon>,
        front: &mut Vec<Polygon>,
        back: &mut Vec<Polygon>,
    ) {
        let mut polygon_type = 0u8;
        let mut types = Vec::with_capacity(polygon.vertices.len());

        for v in &polygon.vertices {
            let t = self.normal[0] * v.pos[0]
                + self.normal[1] * v.pos[1]
                + self.normal[2] * v.pos[2]
                - self.w;
            let vtype = if t < -EPSILON {
                BACK
            } else if t > EPSILON {
                FRONT
            } else {
                COPLANAR
            };
            polygon_type |= vtype;
            types.push(vtype);
        }

        match polygon_type {
            COPLANAR => {
                let dot = self.normal[0] * polygon.vertices[0].normal[0]
                    + self.normal[1] * polygon.vertices[0].normal[1]
                    + self.normal[2] * polygon.vertices[0].normal[2];
                if dot > 0.0 {
                    coplanar_front.push(polygon.clone());
                } else {
                    coplanar_back.push(polygon.clone());
                }
            }
            FRONT => front.push(polygon.clone()),
            BACK => back.push(polygon.clone()),
            _ => {
                let mut f_verts = Vec::new();
                let mut b_verts = Vec::new();
                let n = polygon.vertices.len();

                for i in 0..n {
                    let j = (i + 1) % n;
                    let ti = types[i];
                    let tj = types[j];
                    let vi = &polygon.vertices[i];
                    let vj = &polygon.vertices[j];

                    if ti != BACK {
                        f_verts.push(vi.clone());
                    }
                    if ti != FRONT {
                        b_verts.push(vi.clone());
                    }

                    if (ti | tj) == SPANNING {
                        let denom = self.normal[0] * (vj.pos[0] - vi.pos[0])
                            + self.normal[1] * (vj.pos[1] - vi.pos[1])
                            + self.normal[2] * (vj.pos[2] - vi.pos[2]);
                        if denom.abs() > 1e-10 {
                            let t_val = (self.w
                                - (self.normal[0] * vi.pos[0]
                                    + self.normal[1] * vi.pos[1]
                                    + self.normal[2] * vi.pos[2]))
                                / denom;
                            let v = vi.interpolate(vj, t_val);
                            f_verts.push(v.clone());
                            b_verts.push(v);
                        }
                    }
                }

                if f_verts.len() >= 3 {
                    front.push(Polygon::new(f_verts));
                }
                if b_verts.len() >= 3 {
                    back.push(Polygon::new(b_verts));
                }
            }
        }
    }
}

struct BspNode {
    plane: Option<Plane>,
    front: Option<Box<BspNode>>,
    back: Option<Box<BspNode>>,
    polygons: Vec<Polygon>,
}

impl Drop for BspNode {
    /// Drop the sub-tree iteratively. The naive recursive drop of nested
    /// `Box<BspNode>` overflows the stack on the same degenerate trees
    /// that `build` does (4000+ near-coplanar polygons → linked-list-like
    /// partition). We move each child out into an explicit stack and
    /// let it drop after its grandchildren have been hoisted, so the
    /// recursion never exceeds depth 1.
    fn drop(&mut self) {
        let mut stack: Vec<Box<BspNode>> = Vec::new();
        if let Some(front) = self.front.take() {
            stack.push(front);
        }
        if let Some(back) = self.back.take() {
            stack.push(back);
        }
        while let Some(mut node) = stack.pop() {
            if let Some(front) = node.front.take() {
                stack.push(front);
            }
            if let Some(back) = node.back.take() {
                stack.push(back);
            }
            // `node` falls out of scope here. Its `front` / `back` are now
            // both `None`, so the implicit recursive drop terminates after
            // a single level.
        }
    }
}

impl BspNode {
    fn new(polygons: Vec<Polygon>) -> Self {
        let mut node = BspNode {
            plane: None,
            front: None,
            back: None,
            polygons: Vec::new(),
        };
        if !polygons.is_empty() {
            node.build(polygons);
        }
        node
    }

    fn invert(&mut self) {
        // Iterative pre-order walk with an explicit stack to bound JS+WASM
        // call depth on degenerate BSP trees. The naive recursive form
        // overflowed Firefox's combined call-stack limit (~10K frames) on
        // House.ifc, whose facetted breps fold into deeply unbalanced
        // trees because so many wall/roof polygons are coplanar.
        let mut stack: Vec<*mut BspNode> = vec![self as *mut _];
        while let Some(ptr) = stack.pop() {
            // SAFETY: `self` is mutably borrowed for the duration of this
            // function; child nodes are reached only through their Boxes
            // owned by the parent we already mutably hold. Each raw ptr
            // is dereferenced once and not aliased across iterations.
            let node = unsafe { &mut *ptr };
            for poly in &mut node.polygons {
                poly.flip();
            }
            if let Some(ref mut plane) = node.plane {
                plane.flip();
            }
            std::mem::swap(&mut node.front, &mut node.back);
            if let Some(ref mut front) = node.front {
                stack.push(front.as_mut() as *mut _);
            }
            if let Some(ref mut back) = node.back {
                stack.push(back.as_mut() as *mut _);
            }
        }
    }

    fn clip_polygons(&self, polygons: Vec<Polygon>) -> Vec<Polygon> {
        // Iterative post-order walk. Each frame describes a node + the
        // polygons that are still being routed through its sub-tree; the
        // pending sub-traversals are pushed back on the stack.
        let mut out: Vec<Polygon> = Vec::new();
        let mut stack: Vec<(&BspNode, Vec<Polygon>)> = vec![(self, polygons)];
        while let Some((node, polys)) = stack.pop() {
            let plane = match &node.plane {
                Some(p) => p,
                None => {
                    // No splitting plane at this node — everything passes through.
                    out.extend(polys);
                    continue;
                }
            };

            let mut front = Vec::new();
            let mut back = Vec::new();
            for poly in polys {
                let mut cf = Vec::new();
                let mut cb = Vec::new();
                let mut f = Vec::new();
                let mut b = Vec::new();
                plane.split_polygon(&poly, &mut cf, &mut cb, &mut f, &mut b);
                front.extend(cf);
                front.extend(f);
                back.extend(cb);
                back.extend(b);
            }

            // Back side: drop polygons that don't have a back sub-tree to
            // descend into (mirrors the original `back = Vec::new()` branch).
            if let Some(ref back_node) = node.back {
                stack.push((back_node.as_ref(), back));
            }

            if let Some(ref front_node) = node.front {
                stack.push((front_node.as_ref(), front));
            } else {
                out.extend(front);
            }
        }
        out
    }

    fn clip_to(&mut self, other: &BspNode) {
        let mut stack: Vec<*mut BspNode> = vec![self as *mut _];
        while let Some(ptr) = stack.pop() {
            // SAFETY: same argument as `invert` — each pointer is the
            // owner of an exclusive borrow walked once via the BspNode
            // box tree, never aliased across loop iterations.
            let node = unsafe { &mut *ptr };
            node.polygons = other.clip_polygons(std::mem::take(&mut node.polygons));
            if let Some(ref mut front) = node.front {
                stack.push(front.as_mut() as *mut _);
            }
            if let Some(ref mut back) = node.back {
                stack.push(back.as_mut() as *mut _);
            }
        }
    }

    fn all_polygons(&self) -> Vec<Polygon> {
        let mut polygons = Vec::new();
        let mut stack: Vec<&BspNode> = vec![self];
        while let Some(node) = stack.pop() {
            polygons.extend(node.polygons.iter().cloned());
            if let Some(ref front) = node.front {
                stack.push(front.as_ref());
            }
            if let Some(ref back) = node.back {
                stack.push(back.as_ref());
            }
        }
        polygons
    }

    fn build(&mut self, polygons: Vec<Polygon>) {
        // Iterative pre-order build. Each work item is (target node, polygons
        // to insert into the sub-tree rooted at that node). Replaces the
        // naive recursive form that overflowed Firefox's combined JS+WASM
        // call-stack limit (~10K frames) on House.ifc — its facetted breps
        // have many coplanar wall/roof polygons, which degenerate the
        // partition tree into a near-linked-list.
        let mut stack: Vec<(*mut BspNode, Vec<Polygon>)> = vec![(self as *mut _, polygons)];
        while let Some((ptr, polygons)) = stack.pop() {
            if polygons.is_empty() {
                continue;
            }
            // SAFETY: each pointer either targets `self` (a unique
            // mutable borrow held for the duration of `build`) or a
            // Box owned by an ancestor we already mutably hold; the
            // explicit stack visits each node at most once.
            let node = unsafe { &mut *ptr };

            if node.plane.is_none() {
                for poly in &polygons {
                    if let Some(plane) = Plane::from_polygon(poly) {
                        node.plane = Some(plane);
                        break;
                    }
                }
            }

            let plane = match node.plane.clone() {
                Some(p) => p,
                None => {
                    node.polygons.extend(polygons);
                    continue;
                }
            };

            let mut front = Vec::new();
            let mut back = Vec::new();
            for poly in polygons {
                let mut cf = Vec::new();
                let mut cb = Vec::new();
                let mut f = Vec::new();
                let mut b = Vec::new();
                plane.split_polygon(&poly, &mut cf, &mut cb, &mut f, &mut b);
                node.polygons.extend(cf);
                node.polygons.extend(cb);
                front.extend(f);
                back.extend(b);
            }

            if !front.is_empty() {
                if node.front.is_none() {
                    node.front = Some(Box::new(BspNode {
                        plane: None,
                        front: None,
                        back: None,
                        polygons: Vec::new(),
                    }));
                }
                let front_ptr = node.front.as_mut().unwrap().as_mut() as *mut _;
                stack.push((front_ptr, front));
            }

            if !back.is_empty() {
                if node.back.is_none() {
                    node.back = Some(Box::new(BspNode {
                        plane: None,
                        front: None,
                        back: None,
                        polygons: Vec::new(),
                    }));
                }
                let back_ptr = node.back.as_mut().unwrap().as_mut() as *mut _;
                stack.push((back_ptr, back));
            }
        }
    }
}

pub fn union(a: Vec<Polygon>, b: Vec<Polygon>) -> Vec<Polygon> {
    if a.is_empty() {
        return b;
    }
    if b.is_empty() {
        return a;
    }
    let mut a_node = BspNode::new(a);
    let mut b_node = BspNode::new(b);
    a_node.clip_to(&b_node);
    b_node.clip_to(&a_node);
    b_node.invert();
    b_node.clip_to(&a_node);
    b_node.invert();
    a_node.build(b_node.all_polygons());
    a_node.all_polygons()
}

pub fn difference(a: Vec<Polygon>, b: Vec<Polygon>) -> Vec<Polygon> {
    if a.is_empty() {
        return Vec::new();
    }
    if b.is_empty() {
        return a;
    }
    let mut a_node = BspNode::new(a);
    let mut b_node = BspNode::new(b);
    a_node.invert();
    a_node.clip_to(&b_node);
    b_node.clip_to(&a_node);
    b_node.invert();
    b_node.clip_to(&a_node);
    b_node.invert();
    a_node.build(b_node.all_polygons());
    a_node.invert();
    a_node.all_polygons()
}

pub fn intersection(a: Vec<Polygon>, b: Vec<Polygon>) -> Vec<Polygon> {
    if a.is_empty() || b.is_empty() {
        return Vec::new();
    }
    let mut a_node = BspNode::new(a);
    let mut b_node = BspNode::new(b);
    a_node.invert();
    b_node.clip_to(&a_node);
    b_node.invert();
    a_node.clip_to(&b_node);
    b_node.clip_to(&a_node);
    a_node.build(b_node.all_polygons());
    a_node.invert();
    a_node.all_polygons()
}

#[cfg(test)]
mod stack_safety_tests {
    use super::*;

    /// Build a deeply-degenerate BSP tree by feeding the kernel a long
    /// stack of slightly-offset coplanar quads. Each new quad goes to the
    /// "back" side of every prior partition plane, producing a linked-list
    /// shaped tree of depth `N`. Pre-fix the recursive `build` /
    /// `clip_polygons` / `clip_to` / `all_polygons` overflowed Firefox's
    /// combined JS+WASM call-stack limit (~10K frames) for
    /// `N ≥ a few thousand` on House.ifc — issue #841's "too much
    /// recursion" repro.
    ///
    /// Native stack would tolerate the original recursion (8 MB) but the
    /// browser limit is much tighter, so we run the regression against a
    /// large enough N to fail the old code on native too: a degenerate
    /// drop chain blows the much smaller default 1 MB drop-frame budget
    /// well before 10K nodes.
    #[test]
    fn deep_bsp_does_not_overflow() {
        // 4096 deep quads -> tree depth 4096. Each frame in the old
        // recursive code held a Vec<Polygon> + cloned Plane on the stack
        // (~hundreds of bytes); the iterative replacement keeps the
        // process-level call depth at 1 regardless of tree depth.
        const N: usize = 4096;

        fn quad(z: f64) -> Polygon {
            let v = |x: f64, y: f64| Vertex::new([x, y, z], [0.0, 0.0, 1.0]);
            Polygon::new(vec![v(0.0, 0.0), v(1.0, 0.0), v(1.0, 1.0), v(0.0, 1.0)])
        }

        let polys: Vec<Polygon> = (0..N).map(|i| quad(i as f64)).collect();

        // build (was recursive)
        let mut node = BspNode::new(polys);
        // all_polygons (was recursive)
        let collected = node.all_polygons();
        assert_eq!(collected.len(), N, "every input polygon survives the walk");

        // invert (was recursive) — purely in-place, just must not panic.
        node.invert();

        // clip_polygons + clip_to against an out-of-the-way cutter.
        // The cutter is far above the input quads so nothing should get
        // clipped — we're exercising the recursion, not the math.
        let cutter: Vec<Polygon> = vec![quad((N + 1) as f64)];
        let cutter_node = BspNode::new(cutter);
        node.clip_to(&cutter_node);
        let _ = cutter_node.clip_polygons(node.all_polygons());

        // Drop (was recursive via Box). Forcing the destructor to run on
        // a depth-N tree confirms the iterative `Drop` impl works too.
        drop(node);
        drop(cutter_node);
    }
}
