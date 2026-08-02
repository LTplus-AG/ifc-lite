// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Profile helpers generic over the scalar (B4.4).
//!
//! `Profile2D::triangulate` and `create_rectangle` are the `f64`
//! instantiations of the functions here. Split out of `profile.rs` to keep it
//! inside the module-size ratchet.

use crate::error::{Error, Result};
use crate::scalar::GeomScalar;
use nalgebra::Point2;

/// The body of [`Profile2D::triangulate`], generic over the scalar (B4.4).
///
/// Ear clipping is a **discrete** map: its output is a list of integer indices,
/// constant on an open neighbourhood of almost every input. It is therefore run
/// on the primal values, and the returned `points` are the ring vertices
/// verbatim (`safe_earcut` adds no Steiner points, it only reorders and remaps
/// indices). The derivative that flows on from here is the derivative of the
/// branch the real ear clipper selected, which is the only thing a derivative
/// of a piecewise-smooth map can mean.
pub(crate) fn triangulate_rings<S: GeomScalar>(
    outer: &[Point2<S>],
    holes: &[Vec<Point2<S>>],
) -> Result<TriangulationOf<S>> {
    if outer.len() < 3 {
        return Err(Error::InvalidProfile(
            "Profile must have at least 3 vertices".to_string(),
        ));
    }

    // Flatten vertices for earcutr
    let mut vertices =
        Vec::with_capacity((outer.len() + holes.iter().map(|h| h.len()).sum::<usize>()) * 2);
    let mut points: Vec<Point2<S>> = Vec::with_capacity(vertices.capacity() / 2);

    // Add outer boundary
    for p in outer {
        vertices.push(p.x.value());
        vertices.push(p.y.value());
        points.push(*p);
    }

    // Add holes
    let mut hole_indices = Vec::with_capacity(holes.len());
    for hole in holes {
        hole_indices.push(vertices.len() / 2);
        for p in hole {
            vertices.push(p.x.value());
            vertices.push(p.y.value());
            points.push(*p);
        }
    }

    // Triangulate (guarded — see `triangulation::safe_earcut`)
    let indices = if hole_indices.is_empty() {
        crate::triangulation::safe_earcut(&vertices, &[], 2).map_err(Error::TriangulationError)?
    } else {
        crate::triangulation::safe_earcut(&vertices, &hole_indices, 2)
            .map_err(Error::TriangulationError)?
    };

    Ok(TriangulationOf { points, indices })
}

/// Rectangle ring builder shared by [`create_rectangle`] and the
/// `IfcRectangleProfileDef` processor, generic over the scalar (B4.4).
#[inline]
pub(crate) fn rectangle_ring<S: GeomScalar>(width: S, height: S) -> Vec<Point2<S>> {
    let two = S::from_f64(2.0);
    let half_w = width / two;
    let half_h = height / two;

    vec![
        Point2::new(-half_w, -half_h),
        Point2::new(half_w, -half_h),
        Point2::new(half_w, half_h),
        Point2::new(-half_w, half_h),
    ]
}

/// Triangulated profile result
#[derive(Debug, Clone)]
pub struct TriangulationOf<S: nalgebra::Scalar> {
    /// All vertices (outer + holes)
    pub points: Vec<Point2<S>>,
    /// Triangle indices
    pub indices: Vec<usize>,
}

/// Triangulated profile result over `f64` (the production instantiation).
pub type Triangulation = TriangulationOf<f64>;
