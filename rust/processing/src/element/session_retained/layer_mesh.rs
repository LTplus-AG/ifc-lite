// SPDX-License-Identifier: MPL-2.0
//! Coordinate-key topology shared by cap validation and rim conformity.
use super::{error::RetainedExecutionError, publication::ShapePart};
use std::collections::BTreeMap;
pub(super) type Point = [f64; 3];
pub(super) type Key = [u64; 3];
pub(super) fn key(p: Point) -> Key { p.map(|v| if v == 0. { 0 } else { v.to_bits() }) }
pub(super) fn point(mesh: &ShapePart, index: u32) -> Point {
    std::array::from_fn(|a| mesh.positions[index as usize * 3 + a])
}
pub(super) fn sub(a: Point, b: Point) -> Point { std::array::from_fn(|i| a[i] - b[i]) }
pub(super) fn dot(a: Point, b: Point) -> f64 { a.into_iter().zip(b).map(|(a, b)| a * b).sum() }
pub(super) fn cross(a: Point, b: Point) -> Point {
    [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]
}
pub(super) fn norm(a: Point) -> f64 { dot(a, a).sqrt() }
pub(super) fn fail(reason: &'static str) -> RetainedExecutionError { RetainedExecutionError::LayerCaps(reason) }
pub(super) fn edge_key(a: Point, b: Point) -> (Key, Key) {
    let (a, b) = (key(a), key(b)); if a < b { (a, b) } else { (b, a) }
}
pub(super) fn boundary(mesh: &ShapePart) -> Result<Vec<(u32, u32)>, RetainedExecutionError> {
    let mut edges = BTreeMap::<_, (usize, (u32, u32))>::new();
    for t in mesh.indices.chunks_exact(3) {
        work()?;
        for (a,b) in [(t[0],t[1]),(t[1],t[2]),(t[2],t[0])] {
            let entry = edges.entry(edge_key(point(mesh,a),point(mesh,b))).or_insert((0,(a,b)));
            entry.0 += 1;
        }
    }
    if edges.values().any(|e| e.0 > 2) { return Err(fail("nonmanifold_band")); }
    Ok(edges.into_values().filter(|e| e.0 == 1).map(|e| e.1).collect())
}
pub(super) fn volume(parts: &[ShapePart], origin: Point) -> f64 {
    parts.iter().flat_map(|mesh| mesh.indices.chunks_exact(3).map(move |t|
        dot(sub(point(mesh,t[0]),origin), cross(sub(point(mesh,t[1]),origin),sub(point(mesh,t[2]),origin))) / 6.)).sum()
}
pub(super) fn closed(parts: &[ShapePart]) -> Result<(), RetainedExecutionError> {
    let mut edges = BTreeMap::<_, (usize, i64)>::new();
    for mesh in parts {
        for t in mesh.indices.chunks_exact(3) {
            work()?;
            for (a,b) in [(t[0],t[1]),(t[1],t[2]),(t[2],t[0])] {
                let (a,b) = (point(mesh,a),point(mesh,b));
                let entry = edges.entry(edge_key(a,b)).or_default();
                entry.0 += 1; entry.1 += if key(a) < key(b) { 1 } else { -1 };
            }
        }
    }
    if edges.values().any(|&(n,d)| n != 2 || d != 0) { return Err(fail("assembly_closure")); }
    Ok(())
}

/// Each visited triangle/candidate consumes the same product work allowance.
pub(super) fn work() -> Result<(), RetainedExecutionError> {
    super::error::budget_checkpoint()?;
    ifc_lite_geometry::resource::charge(ifc_lite_geometry::resource::Cost { work:1,..Default::default() })
        .map_err(RetainedExecutionError::Stopped)?.retain();
    Ok(())
}
