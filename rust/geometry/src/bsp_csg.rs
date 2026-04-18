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
        for poly in &mut self.polygons {
            poly.flip();
        }
        if let Some(ref mut plane) = self.plane {
            plane.flip();
        }
        if let Some(ref mut front) = self.front {
            front.invert();
        }
        if let Some(ref mut back) = self.back {
            back.invert();
        }
        std::mem::swap(&mut self.front, &mut self.back);
    }

    fn clip_polygons(&self, polygons: Vec<Polygon>) -> Vec<Polygon> {
        let plane = match &self.plane {
            Some(p) => p,
            None => return polygons,
        };

        let mut front = Vec::new();
        let mut back = Vec::new();

        for poly in polygons {
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

        if let Some(ref node) = self.front {
            front = node.clip_polygons(front);
        }

        if let Some(ref node) = self.back {
            back = node.clip_polygons(back);
        } else {
            back = Vec::new();
        }

        front.extend(back);
        front
    }

    fn clip_to(&mut self, other: &BspNode) {
        self.polygons = other.clip_polygons(std::mem::take(&mut self.polygons));
        if let Some(ref mut front) = self.front {
            front.clip_to(other);
        }
        if let Some(ref mut back) = self.back {
            back.clip_to(other);
        }
    }

    fn all_polygons(&self) -> Vec<Polygon> {
        let mut polygons = self.polygons.clone();
        if let Some(ref front) = self.front {
            polygons.extend(front.all_polygons());
        }
        if let Some(ref back) = self.back {
            polygons.extend(back.all_polygons());
        }
        polygons
    }

    fn build(&mut self, polygons: Vec<Polygon>) {
        if polygons.is_empty() {
            return;
        }

        if self.plane.is_none() {
            for poly in &polygons {
                if let Some(plane) = Plane::from_polygon(poly) {
                    self.plane = Some(plane);
                    break;
                }
            }
        }

        let plane = match self.plane.clone() {
            Some(p) => p,
            None => {
                self.polygons.extend(polygons);
                return;
            }
        };

        let mut front = Vec::new();
        let mut back = Vec::new();
        let coplanar_polys = &mut self.polygons;

        for poly in polygons {
            let mut cf = Vec::new();
            let mut cb = Vec::new();
            let mut f = Vec::new();
            let mut b = Vec::new();
            plane.split_polygon(&poly, &mut cf, &mut cb, &mut f, &mut b);
            coplanar_polys.extend(cf);
            coplanar_polys.extend(cb);
            front.extend(f);
            back.extend(b);
        }

        if !front.is_empty() {
            if self.front.is_none() {
                self.front = Some(Box::new(BspNode {
                    plane: None,
                    front: None,
                    back: None,
                    polygons: Vec::new(),
                }));
            }
            self.front.as_mut().unwrap().build(front);
        }

        if !back.is_empty() {
            if self.back.is_none() {
                self.back = Some(Box::new(BspNode {
                    plane: None,
                    front: None,
                    back: None,
                    polygons: Vec::new(),
                }));
            }
            self.back.as_mut().unwrap().build(back);
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
