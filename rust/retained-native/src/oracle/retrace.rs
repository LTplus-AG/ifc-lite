// SPDX-License-Identifier: MPL-2.0
//! #3641 source oracle: area-matched convex hull, independent of spur cancellation.
use super::{convex::Convex, math::*};
use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::placement::Axis2Placement;
use ifc_lite_processing::AnalyticQuantitySources;
type Point = [f64; 3];
fn turn(a: Point, b: Point, c: Point) -> f64 {
    (b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0])
}
pub fn area(points: &[Point]) -> f64 {
    (0..points.len()).map(|i| {
        let a = points[i]; let b = points[(i+1)%points.len()];
        a[0]*b[1]-a[1]*b[0]
    }).sum::<f64>() / 2.
}
fn hull(points: &[Point]) -> Vec<Point> {
    let mut sorted = points.to_vec();
    sorted.sort_by(|a,b| a[0].total_cmp(&b[0]).then(a[1].total_cmp(&b[1])));
    sorted.dedup();
    let mut result = Vec::new();
    for iter in [sorted.iter().copied().collect::<Vec<_>>(), sorted.iter().rev().copied().collect()] {
        let mut chain = Vec::new();
        for p in iter {
            while chain.len() >= 2 && turn(chain[chain.len()-2], chain[chain.len()-1], p) <= 0. { chain.pop(); }
            chain.push(p);
        }
        chain.pop(); result.extend(chain);
    }
    result
}
/// This fixture has one extraneous vertex. The full hull includes its spur;
/// test each single-vertex omission and require a unique area-matched hull.
/// No exact predicate, cyclic reversal test or repair implementation is used.
pub fn region(points: &[Point], relative: f64) -> Result<Vec<Point>, &'static str> {
    const REFUSAL: &str = "oracle cannot model this profile";
    if points.len() != 5 || points.iter().flatten().any(|v| !v.is_finite()) || !relative.is_finite() || relative < 0. { return Err(REFUSAL); }
    let authored = area(points).abs();
    if !authored.is_finite() || authored == 0. { return Err(REFUSAL); }
    let mut matches = Vec::new();
    for omit in 0..points.len() {
        let remaining: Vec<_> = points.iter().enumerate().filter(|(i,_)| *i != omit).map(|(_,p)| *p).collect();
        let candidate = hull(&remaining);
        let contains = candidate.len() >= 3 && (0..candidate.len()).all(|i|
            remaining.iter().all(|p| turn(candidate[i], candidate[(i+1)%candidate.len()], *p) >= 0.));
        if (area(&candidate).abs()-authored).abs() <= relative*authored && contains {
            matches.push(candidate);
        }
    }
    if matches.len() == 1 { Ok(matches.remove(0)) } else { Err(REFUSAL) }
}
pub fn authored_region(decoder: &mut EntityDecoder, relative: f64) -> Option<Vec<Point>> {
    let curve = decoder.decode_by_id(61273).ok()?;
    if curve.get_ref(0)? != 61274 { return None; }
    let list = decoder.decode_by_id(61274).ok()?;
    let points: Option<Vec<Point>> = list.get(0)?.as_list()?.iter().map(|v| {
        let xy = v.as_list()?;
        Some([xy.first()?.as_float()?, xy.get(1)?.as_float()?, 0.])
    }).collect();
    let points = points?;
    let segments = curve.get(1)?.as_list()?;
    if segments.len() != 1 { return None; }
    // Authenticate the authored selector rather than assuming point-list order.
    let ifc_lite_core::AttributeValue::Typed { name, value } = &segments[0] else { return None };
    if !name.eq_ignore_ascii_case("IFCLINEINDEX") { return None; }
    let indices = value.as_list()?;
    let order: Option<Vec<_>> = indices.iter().map(|v| v.as_int()).collect();
    if order? != [1,2,3,4,5,1] { return None; }
    region(&points, relative).ok()
}
/// Placement comes from the quantity-source view; extrusion leaves are decoded
/// directly because the ordinary extractor intentionally rejects this profile.
pub fn source(sources: &AnalyticQuantitySources, decoder: &mut EntityDecoder, origin: Point, relative: f64) -> Option<Convex> {
    let polygon = authored_region(decoder, relative)?;
    let instance = sources.extrusion_definitions.instances.get(&72245)?.first()?;
    let solid = decoder.decode_by_id(61271).ok()?;
    let placement = decoder.decode_by_id(solid.get_ref(1)?).ok()?;
    let local = Axis2Placement::read_3d(&placement, decoder).ok()?.matrix();
    let local: [f64;16] = std::array::from_fn(|i| local[(i%4,i/4)]);
    let mut frame = multiply(&instance.world_from_source?, &local);
    for k in 0..3 { frame[12+k] -= origin[k]; }
    let direction = unit(decoder.direction3(solid.get_ref(2)?).ok()?)?;
    let depth = solid.get_float(3)?;
    Convex::extrusion(&polygon.iter().map(|p| transform(&frame,*p)).collect::<Vec<_>>(), vector(&frame, direction.map(|v| v*depth)))
}
