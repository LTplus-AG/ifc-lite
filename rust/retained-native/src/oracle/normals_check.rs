// SPDX-License-Identifier: MPL-2.0
//! Independent source-surface normal checks shared by native and browser tests.
use super::math::*;
use ifc_lite_geometry::analytic::AnalyticCurveSegment;
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub enum Surface {
    Plane { origin: [f64; 3], normal: [f64; 3] },
    /// Unit circle in the u/v basis, swept along d; supports oblique prisms.
    ArcWall { center: [f64; 3], u: [f64; 3], v: [f64; 3], d: [f64; 3], sign: f64 },
    Disk { directrix: AnalyticCurveSegment, radius: f64, sign: f64 },
}
impl Surface {
    /// Signed source direction and distance to its analytic supporting surface.
    pub fn sample(&self, p: [f64; 3]) -> Option<([f64; 3], f64)> {
        match self {
            Self::Plane { origin, normal } => Some((*normal, dot(sub(p,*origin),*normal).abs())),
            Self::ArcWall { center,u,v,d,sign } => {
                let q = sub(p,*center);
                let det = dot(*u,cross(*v,*d));
                let x = dot(q,cross(*v,*d))/det;
                let y = dot(q,cross(*d,*u))/det;
                let radius = x.hypot(y);
                let radial = add(scale(*u,x),scale(*v,y));
                let normal = unit(cross(add(scale(*u,-y),scale(*v,x)),*d))?;
                Some((scale(normal,*sign), (radius-1.).abs()*norm(radial)/radius))
            }
            Self::Disk { directrix,radius,sign } => {
                let center = match *directrix {
                    AnalyticCurveSegment::Line { start,end } => {
                        let d = unit(sub(end,start))?;
                        add(start,scale(d,dot(sub(p,start),d)))
                    }
                    AnalyticCurveSegment::Arc { center,normal,radius,.. } => {
                        let q = sub(p,center);
                        let radial = unit(sub(q,scale(normal,dot(q,normal))))?;
                        add(center,scale(radial,radius))
                    }
                };
                let radial = sub(p,center);
                Some((scale(unit(radial)?,*sign), (norm(radial)-radius).abs()))
            }
        }
    }
    pub fn curved(&self) -> bool { !matches!(self, Self::Plane { .. }) }
    #[allow(dead_code)] // Source assembly is native-only; browser reads its source-only reference.
    pub(super) fn reversed(mut self, sign: f64) -> Self {
        match &mut self {
            Self::Plane { normal,.. } => *normal = scale(*normal,sign),
            Self::ArcWall { sign:s,.. } | Self::Disk { sign:s,.. } => *s *= sign,
        }
        self
    }
}
fn norm(v: [f64; 3]) -> f64 { dot(v,v).sqrt() }
fn scale(v: [f64; 3], s: f64) -> [f64; 3] { v.map(|x| x*s) }
fn add(a: [f64; 3], b: [f64; 3]) -> [f64; 3] { std::array::from_fn(|i| a[i]+b[i]) }
pub fn angle(a: [f64; 3], b: [f64; 3]) -> f64 { norm(cross(a,b)).atan2(dot(a,b)) }

#[derive(Default, serde::Serialize)]
pub struct Check {
    pub surface_indices: Vec<Option<usize>>,
    pub corners: usize,
    pub planar: usize,
    pub curved: usize,
    pub smoothed_curved: usize,
    pub flat: usize,
    pub unattributed: usize,
    pub planar_radians: f64,
    pub curved_radians: f64,
    pub unit_error: f64,
}
impl std::fmt::Debug for Check {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Check").field("corners",&self.corners)
            .field("planar",&self.planar).field("curved",&self.curved)
            .field("smoothed_curved",&self.smoothed_curved).field("flat",&self.flat)
            .field("unattributed",&self.unattributed).field("planar_radians",&self.planar_radians)
            .field("curved_radians",&self.curved_radians).field("unit_error",&self.unit_error).finish()
    }
}
fn facet(local: [[f64;3];3], frame: &[f64;16]) -> Option<[f64;3]> {
    // Translation cancels analytically. Subtracting absolute world points
    // loses small edges on georeferenced models and corrupts oracle incidence.
    unit(cross(vector(frame,sub(local[1],local[0])), vector(frame,sub(local[2],local[0]))))
}
/// Surface selection uses source incidence and facet orientation, never output
/// normals. A noisy sliver's facet is not the normal oracle for a planar face.
pub fn check_mesh(positions: &[f64], indices: &[u32], frame: &[f64;16], normals: &[f64],
    source: &[Surface]) -> Result<Check,String> {
    if !positions.len().is_multiple_of(3) || !indices.len().is_multiple_of(3)
        || normals.len() != indices.len()*3 || frame.iter().any(|v| !v.is_finite()) {
        return Err("normal mesh cardinality or frame".into());
    }
    let mut result = Check::default();
    for (t,triangle) in indices.chunks_exact(3).enumerate() {
        let mut local = [[0.;3];3];
        for (corner,&v) in triangle.iter().enumerate() {
            let p = positions.get(v as usize*3..v as usize*3+3).ok_or("invalid index")?;
            if p.iter().any(|v| !v.is_finite()) {return Err("nonfinite position".into());}
            local[corner].copy_from_slice(p);
        }
        let points = local.map(|p| transform(frame,p));
        let facet = facet(local,frame).ok_or("degenerate triangle")?;
        let centroid = add(points[0],scale(add(sub(points[1],points[0]),sub(points[2],points[0])),1./3.));
        let surface_index = source.iter().position(|s| {
            let incidence = if s.curved() {0.001001} else {1e-6};
            points.iter().chain([&centroid]).all(|&p| s.sample(p).is_some_and(|(_,d)| d.is_finite() && d <= incidence))
                && s.sample(centroid).is_some_and(|(n,_)|
                    if s.curved() {angle(n,facet) <= 0.0873} else {dot(n,facet) > 0.})
        });
        result.surface_indices.push(surface_index);
        let surface = surface_index.map(|i| &source[i]);
        if surface.is_none() && !source.is_empty() { result.unattributed += 3; }
        for (c,&point) in points.iter().enumerate() {
            let offset = (t*3+c)*3;
            let normal = [normals[offset],normals[offset+1],normals[offset+2]];
            if normal.iter().any(|v| !v.is_finite()) { return Err("nonfinite normal".into()); }
            result.unit_error = result.unit_error.max((norm(normal)-1.).abs());
            result.corners += 1;
            let expected = surface.and_then(|s| s.sample(point)).map_or(facet,|(n,_)| n);
            let error = angle(expected,normal);
            if surface.is_some_and(Surface::curved) {
                result.smoothed_curved += usize::from(angle(facet,normal) > 1e-9);
                result.curved += 1; result.curved_radians = result.curved_radians.max(error);
            } else {
                if source.is_empty() {result.flat += 1;} else {result.planar += 1;}
                result.planar_radians = result.planar_radians.max(error);
            }
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn m11_n_7955_source_facet_direction_is_translation_invariant() {
        let triangle = [[0.,0.,0.],[0.02,0.,2.41],[0.,0.,2.41]];
        let mut frame = [0.8,0.6,0.,0., -0.6,0.8,0.,0., 0.,0.,1.,0., 0.,0.,0.,1.];
        for translation in [0.,5_000_000.,1e20] {
            frame[12] = translation; frame[13] = -translation; frame[14] = translation;
            assert!(angle(facet(triangle,&frame).unwrap(),[0.6,-0.8,0.]) < 1e-15);
        }
    }
}
