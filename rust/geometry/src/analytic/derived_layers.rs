// SPDX-License-Identifier: MPL-2.0
//! Finite circular-wall regions. Generated edges have no authored face ancestry.
use super::{AnalyticCurveSegment as Segment, AnalyticExtrusion, AnalyticStatus};
use ifc_lite_core::{EntityDecoder, IfcType};
use crate::document::RetainedRefusal;

#[derive(Debug, Clone, PartialEq)]
pub struct DerivedLayerRegions {
    authored: AnalyticExtrusion,
    axis: Segment,
    radii: Vec<f64>,
    units: f64,
}
impl DerivedLayerRegions {
    /// Offsets are in metres and authored order. This constructor proves a
    /// complete partition, not just a collection of individually valid cutters.
    pub fn capture(solid_id: u32, axis_id: u32, offsets: &[f64], units: f64,
        decoder: &mut EntityDecoder) -> Result<Self, String> {
        if offsets.len() < 2 || offsets.len() > 8192 || !units.is_finite() || units <= 0. {
            return Err("J3 invalid bounded band count or units".into());
        }
        let solid = decoder.decode_by_id(solid_id).map_err(|e| e.to_string())?;
        let authored = super::with_source_capture(|| super::extract_analytic_extrusion(&solid, decoder));
        if authored.status != AnalyticStatus::Complete || authored.axis_unit_vector != Some([0.,0.,1.]) {
            return Err("J3 unproved extrusion".into());
        }
        // The admitted family has its source profile in product XY. Nontrivial
        // solid/profile transforms need an explicit axis/body coframe proof.
        let identity = crate::math::mat4::col_major_array(&nalgebra::Matrix4::identity());
        let profile = authored.profile.as_ref().ok_or("J3 missing profile")?;
        if authored.position_matrix.unwrap_or(identity) != identity
            || profile.profile_position.unwrap_or(identity) != identity || profile.loops.len() != 1 {
            return Err("J3 unproved body/axis coframe".into());
        }
        let curve = decoder.decode_by_id(axis_id).map_err(|e| e.to_string())?;
        if curve.ifc_type != IfcType::IfcTrimmedCurve { return Err("J3 unproved axis family".into()); }
        let segments = super::curve::CurveWalk::default().extract(&curve, decoder)
            .map_err(|e| e.to_string())?.ok_or("J3 unproved axis")?;
        let [axis @ Segment::Arc { radius, normal, x_axis, sweep_angle, .. }] = segments.as_slice()
            else { return Err("J3 requires one finite circular axis".into()); };
        if *normal != [0.,0.,1.] || *x_axis != [1.,0.,0.] || !(*sweep_angle > 0. && *sweep_angle < std::f64::consts::TAU) {
            return Err("J3 unproved circular orientation/trim".into());
        }
        let radii: Vec<_> = offsets.iter().map(|offset| radius - offset / units).collect();
        let increasing = radii[1] > radii[0];
        if radii.iter().any(|r| !r.is_finite() || *r <= 0.)
            || radii.windows(2).any(|r| if increasing { r[1] <= r[0] } else { r[1] >= r[0] }) {
            return Err("J3 collapsed or nonmonotone band".into());
        }
        let last = radii[radii.len()-1];
        let outer = radii[0].max(last);
        let inner = radii[0].min(last);
        let expected = sector(axis, inner, outer);
        let actual = &profile.loops[0].segments;
        // Exact parameters, with only the existing join epsilon on authored
        // line endpoints (exporters round trigonometric endpoint coordinates).
        if actual.len() != 4 || !actual.iter().zip(&expected).all(|(a,b)| same_segment(a,b,units)) {
            return Err("J3_COVERAGE: source body is not the complete layer sector".into());
        }
        // Exercise every existing numerical domain guard before deriving.
        let mut document = crate::document::GeometryDocument::new();
        document.add_retained_extrusion(crate::document::RetainedExtrusion {
            source: authored.clone(), length_unit_scale: units }).map_err(|e| e.to_string())?;
        Ok(Self { authored, axis: axis.clone(), radii, units })
    }
    pub fn len(&self) -> usize { self.radii.len()-1 }
    pub fn is_empty(&self) -> bool { self.len() == 0 }
    pub fn radii(&self, ordinal: usize) -> Option<(f64,f64)> {
        Some((*self.radii.get(ordinal)? * self.units, *self.radii.get(ordinal+1)? * self.units))
    }
    pub fn solid_id(&self) -> u32 { self.authored.solid_id }
    pub(crate) fn encoding(&self, ordinal: usize) -> Result<crate::document::RetainedExtrusion, RetainedRefusal> {
        let a = *self.radii.get(ordinal).ok_or(RetainedRefusal::InvalidSource("band ordinal"))?;
        let b = *self.radii.get(ordinal+1).ok_or(RetainedRefusal::InvalidSource("band ordinal"))?;
        let mut source = self.authored.clone();
        // This is an encoding view ONLY. Do not give generated boundaries the
        // original source graph, entity ids, or a persistent-face certificate.
        source.source = None;
        let profile = source.profile.as_mut().ok_or(RetainedRefusal::InvalidSource("profile"))?;
        let boundary = &mut profile.loops[0];
        boundary.source = None;
        boundary.segments = sector(&self.axis,a.min(b),a.max(b));
        let Segment::Arc { sweep_angle, .. } = self.axis else { unreachable!() };
        boundary.signed_area = (a.max(b).powi(2)-a.min(b).powi(2))*sweep_angle/2.;
        Ok(crate::document::RetainedExtrusion { source, length_unit_scale:self.units })
    }
}
fn sector(axis: &Segment, inner: f64, outer: f64) -> Vec<Segment> {
    let Segment::Arc { center, normal, x_axis, start_angle, sweep_angle, .. } = *axis else { unreachable!() };
    let arc = |radius, start_angle, sweep_angle| Segment::Arc { center,normal,x_axis,radius,start_angle,sweep_angle };
    let at = |radius: f64, angle: f64| [center[0]+radius*angle.cos(),center[1]+radius*angle.sin(),0.];
    let end = start_angle+sweep_angle;
    vec![arc(outer,start_angle,sweep_angle), Segment::Line { start:at(outer,end),end:at(inner,end) },
        arc(inner,end,-sweep_angle), Segment::Line { start:at(inner,start_angle),end:at(outer,start_angle) }]
}
fn same_segment(a: &Segment,b: &Segment,units: f64) -> bool {
    match (a,b) {
        (Segment::Line { start:a,end:b },Segment::Line { start:c,end:d }) =>
            a.iter().chain(b).zip(c.iter().chain(d)).all(|(x,y)|
                (x-y).abs()*units <= crate::math::tol::RETAINED_BOUNDARY_JOIN_EPS_M),
        _ => a == b,
    }
}
