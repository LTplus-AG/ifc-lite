// SPDX-License-Identifier: MPL-2.0
//! #3641 retained-only nonzero-winding material region. An exactly retraced
//! axis-aligned spur contributes zero winding off its supporting segment.
//! A separating coordinate plane proves that spur has no other intersections.
//! The remaining Jordan boundary must pass the unchanged topology validator.
//! No snapping, near-collinearity inference, or arbitrary vertex deletion.
use super::*;
use crate::math::tol::{RETAINED_REGION_CLEARANCE_FLOOR, RETAINED_REGION_JOIN_CEILING};
use ifc_lite_core::{IfcType, slot};

const MAX_EDGES: usize = 128;
const MAX_WORK: usize = 16_384;

/// Directed interval of an original edge, in raw profile coordinates. Endpoints
/// are original authored vertices, not rounded interpolation parameters.
#[derive(Debug, Clone, PartialEq)]
pub struct RegionEdgeSource {
    pub authored_edge: usize,
    pub start: [f64; 3],
    pub end: [f64; 3],
}
#[derive(Debug, Clone, PartialEq)]
pub struct CancelledRetrace {
    pub authored_edges: [usize; 2],
    pub from: [f64; 3],
    pub to: [f64; 3],
}

/// Sealed proof, distinct from an original analytic profile. Original source
/// records and *all* original segments survive. It establishes a material
/// boundary only, not SDK face IDs, UVs, Boolean lineage or final publication.
#[derive(Debug, Clone, PartialEq)]
pub struct RetainedProfileRegion {
    authored: AnalyticExtrusion,
    boundary: AnalyticProfileLoop,
    edges: Vec<RegionEdgeSource>,
    cancelled: CancelledRetrace,
    raw_precision: Option<(f64, f64)>,
    decimal_authority: retained_region_decimal::DecimalAuthority,
}
impl RetainedProfileRegion {
    /// Bounded supported family: one arbitrary closed line loop and one
    /// isolated axis-aligned spur whose shorter edge is wholly retraced.
    /// Call inside with_source_capture. Unsupported is terminal, never empty.
    pub fn capture(solid: &DecodedEntity, decoder: &mut EntityDecoder) -> std::result::Result<Self, String> {
        preflight(solid, decoder)?;
        let raw_precision = decoder.geometric_context_precision_range().map_err(|e| e.to_string())?;
        let mut authored = extrusion::extract_with_profile(solid, decoder, profile::extract_authored_walk);
        if let AnalyticStatus::Unsupported(reason) = &authored.status { return Err(reason.clone()); }
        retained_region_decimal::capture_profile(&mut authored, decoder)?;
        let profile = authored.profile.as_ref().ok_or("missing authored profile")?;
        if profile.ifc_type_name != IfcType::IfcArbitraryClosedProfileDef.name() || profile.loops.len() != 1 {
            return Err("retained region requires one arbitrary closed boundary".into());
        }
        let original = &profile.loops[0];
        let captured = original.source.as_ref().ok_or("retained region requires source capture")?;
        if captured.capture_status != AnalyticStatus::Complete {
            return Err("incomplete original boundary capture".into());
        }
        let decimal_authority = retained_region_decimal::prove(captured, original, decoder)?;
        let clearance = raw_precision.map_or(RETAINED_REGION_CLEARANCE_FLOOR, |(_, max)| max.max(RETAINED_REGION_CLEARANCE_FLOOR));
        let join = raw_precision.map_or(RETAINED_REGION_JOIN_CEILING, |(min, _)| min.min(RETAINED_REGION_JOIN_CEILING));
        let (boundary, edges, cancelled) = regularize(original, clearance, join, MAX_WORK)?;
        // Never label the original non-simple walk as a complete analytic region.
        authored.status = AnalyticStatus::Unsupported("authored non-simple walk; see retained region proof".into());
        authored.profile.as_mut().unwrap().status = authored.status.clone();
        Ok(Self { authored, boundary, edges, cancelled, raw_precision, decimal_authority })
    }
    pub fn authored(&self) -> &AnalyticExtrusion { &self.authored }
    pub fn boundary(&self) -> &AnalyticProfileLoop { &self.boundary }
    pub fn edges(&self) -> &[RegionEdgeSource] { &self.edges }
    pub fn cancelled(&self) -> &CancelledRetrace { &self.cancelled }
    /// Original coordinate-record bytes used by the authored-decimal proof.
    pub fn coordinate_source_bytes(&self, entity_id: u32) -> Option<&[u8]> {
        self.decimal_authority.record(entity_id)
    }
    pub fn raw_precision(&self) -> Option<(f64, f64)> { self.raw_precision }
    pub fn fill_policy(&self) -> &'static str { "nonzero-winding; isolated exact retrace cancellation v1" }

    // Ephemeral encoding view, never exposed as original analytic source.
    pub(crate) fn encoding_view(&self) -> std::result::Result<AnalyticExtrusion, String> {
        retained_region_account::copy(self.authored.source.as_ref(), 1)?;
        retained_region_account::copy(self.boundary.source.as_ref(), 2)?;
        let mut view = self.authored.clone();
        view.status = AnalyticStatus::Complete;
        let profile = view.profile.as_mut().unwrap();
        profile.status = AnalyticStatus::Complete;
        profile.loops = vec![self.boundary.clone()];
        Ok(view)
    }
}

// Bound the additional retained parser's input before allocating an interpreted
// walk. No composite graph or index fan-out is admitted by this proof family.
fn preflight(solid: &DecodedEntity, decoder: &mut EntityDecoder) -> std::result::Result<(), String> {
    if solid.ifc_type != IfcType::IfcExtrudedAreaSolid { return Err("region requires extrusion".into()); }
    let profile = decoder.decode_by_id(solid.get_ref(slot::IfcExtrudedAreaSolid::SWEPT_AREA.index()).ok_or("missing SweptArea")?).map_err(|e| e.to_string())?;
    if profile.ifc_type != IfcType::IfcArbitraryClosedProfileDef { return Err("region requires arbitrary closed profile".into()); }
    let curve = decoder.decode_by_id(profile.get_ref(slot::IfcArbitraryClosedProfileDef::OUTER_CURVE.index()).ok_or("missing OuterCurve")?).map_err(|e| e.to_string())?;
    match curve.ifc_type {
        IfcType::IfcPolyline => {
            let points = curve.get_list(slot::IfcPolyline::POINTS.index()).ok_or("missing Points")?;
            if points.len() > MAX_EDGES+1 { return Err("retained region edge budget exceeded".into()); }
            charge_preflight(points.len())?;
        }
        IfcType::IfcIndexedPolyCurve => {
            let list = decoder.decode_by_id(curve.get_ref(slot::IfcIndexedPolyCurve::POINTS.index()).ok_or("missing Points")?).map_err(|e| e.to_string())?;
            if list.ifc_type != IfcType::IfcCartesianPointList2D { return Err("region requires XY point list".into()); }
            if list.get_list(slot::IfcCartesianPointList2D::COORD_LIST.index()).ok_or("missing CoordList")?.len() > MAX_EDGES+1 {
                return Err("retained region edge budget exceeded".into());
            }
            let items = curve.get_list(slot::IfcIndexedPolyCurve::SEGMENTS.index()).ok_or("region requires explicit line indices")?;
            if items.len() > MAX_EDGES { return Err("retained region item budget exceeded".into()); }
            charge_preflight(items.len())?;
            let mut count = 0usize;
            for item in items {
                let (name,value) = item.as_typed().ok_or("invalid line index")?;
                if !name.eq_ignore_ascii_case("IFCLINEINDEX") { return Err("region requires line indices".into()); }
                let indices = value.as_list().ok_or("invalid line indices")?;
                if indices.len() < 2 { return Err("retained region invalid line index cardinality".into()); }
                count = count.checked_add(indices.len()).ok_or("index overflow")?;
                if count > MAX_EDGES+1 { return Err("retained region edge budget exceeded".into()); }
                charge_preflight(indices.len())?;
            }
        }
        _ => return Err("unsupported retained region curve family".into()),
    }
    Ok(())
}

fn charge_preflight(work: usize) -> std::result::Result<(), String> {
    crate::resource::charge(crate::resource::Cost { work: work as u64, ..Default::default() })
        .map_err(|e| e.to_string())?.retain();
    Ok(())
}

type Proof = (AnalyticProfileLoop, Vec<RegionEdgeSource>, CancelledRetrace);
fn regularize(original: &AnalyticProfileLoop, clearance: f64, join: f64, mut work: usize) -> std::result::Result<Proof, String> {
    let n = original.segments.len();
    if n < 4 || n > MAX_EDGES { return Err("retained region edge budget exceeded".into()); }
    // Reserve audited scratch/proof headers before allocating. Retention is
    // conservative for this source transaction, matching retained capture.
    crate::resource::charge(crate::resource::Cost {
        work: (1_000_000 + n * n) as u64, live_bytes: (n * 1024) as u64,
        copy_bytes: (n * 1024) as u64, ..Default::default()
    }).map_err(|e| e.to_string())?.retain();
    let mut points = Vec::with_capacity(n);
    for (i, segment) in original.segments.iter().enumerate() {
        let AnalyticCurveSegment::Line { start, end } = segment else {
            return Err("retained retrace proof supports lines only".into());
        };
        let AnalyticCurveSegment::Line { start: next, .. } = &original.segments[(i+1)%n] else {
            return Err("retained retrace proof supports lines only".into());
        };
        if start.iter().chain(end).any(|v| !v.is_finite()) || start[2] != 0. || end[2] != 0.
            || start == end || end != next {
            return Err("retained retrace proof requires finite exactly joined XY edges".into());
        }
        points.push(*start);
    }
    for i in 0..n {
        spend(&mut work)?;
        let (a,b,c) = (points[i], points[(i+1)%n], points[(i+2)%n]);
        for axis in 0..2 {
            let other = 1-axis;
            if a[other] != b[other] || b[other] != c[other] { continue; }
            // Strict order proves anti-parallel overlap without cross products,
            // floating arithmetic or guessed collinearity. Equal lengths are
            // deliberately unsupported by this bounded family.
            let between = |x: f64, p: f64, q: f64| (p < x && x < q) || (q < x && x < p);
            let (tip, attach, shortened) = if between(a[axis], b[axis], c[axis]) {
                (b, a, (i+1)%n)
            } else if between(c[axis], a[axis], b[axis]) {
                (b, c, i)
            } else { continue; };
            let positive = tip[axis] < attach[axis];
            // Every other vertex strictly lies on the material side, except
            // the attachment itself. A line is convex, so the whole surviving
            // boundary avoids the cancelled interval (not just its vertices).
            let mut separated = true;
            for (j, point) in points.iter().enumerate() {
                spend(&mut work)?;
                if j == (i+1)%n || *point == attach { continue; }
                if if positive { point[axis] <= attach[axis] } else { point[axis] >= attach[axis] } {
                    separated = false;
                }
            }
            if !separated { continue; }
            let mut edges = Vec::with_capacity(n-1);
            // Start immediately after the pair, then retain the shortened edge
            // last. This preserves orientation and source ordinal, including
            // a retrace across the authored closing seam.
            for k in 0..n-2 {
                let j = (i+2+k)%n;
                edges.push(RegionEdgeSource { authored_edge: j, start: points[j], end: points[(j+1)%n] });
            }
            edges.push(RegionEdgeSource { authored_edge: shortened, start: a, end: c });
            let segments = edges.iter().map(|e| AnalyticCurveSegment::Line { start: e.start, end: e.end }).collect();
            let mut boundary = profile::loop_from_segments(ProfileLoopKind::Outer, segments)?;
            profile_topology::validate(std::slice::from_ref(&boundary), clearance, join)?;
            retained_region_account::copy(original.source.as_ref(), 1)?;
            boundary.source = original.source.clone();
            return Ok((boundary, edges, CancelledRetrace { authored_edges: [i,(i+1)%n], from: tip, to: attach }));
        }
    }
    Err("unsupported or uncertain retained retrace topology".into())
}
fn spend(work: &mut usize) -> std::result::Result<(), String> {
    *work = work.checked_sub(1).ok_or("retained region work budget exceeded")?;
    Ok(())
}

#[cfg(test)]
#[path = "retained_region_tests.rs"]
mod tests;
