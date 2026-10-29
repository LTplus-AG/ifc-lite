// SPDX-License-Identifier: MPL-2.0
//! M10 decoder-only affine oracle. No retained program, receipt or bake helpers.
use super::math::*;
use ifc_lite_core::{slot, EntityDecoder, IfcType, SourceBundle};
type Frame = [f64;16];
#[derive(Debug, Clone)]
pub struct AffineExpectation {
    pub volume: f64,
    pub centroid: [f64;3],
    pub bbox: Option<[f64;6]>,
    /// Source support points give a lower bound on the true maximum bbox extent.
    /// Using this for curved centroid tolerances can only tighten the gate.
    pub extent: f64,
    pub radius: f64,
    pub matrix: Frame,
    pub sigma_max: f64,
    pub kappa: f64,
    pub affine_final: bool,
}
impl AffineExpectation {
    /// The preregistered fallback after the real SDK sagitta witness failed.
    pub fn chord_admitted(&self) -> bool {
        self.radius == 0. || self.sigma_max <= 1.
    }
}
fn direction(d:&mut EntityDecoder<'_>, id:Option<u32>, default:[f64;3]) -> Option<[f64;3]> {
    id.map_or(Some(default), |id| unit(d.direction3(id).ok()?))
}
fn columns(x:[f64;3], y:[f64;3], z:[f64;3], p:[f64;3]) -> Frame {
    [x[0],x[1],x[2],0., y[0],y[1],y[2],0., z[0],z[1],z[2],0., p[0],p[1],p[2],1.]
}
fn axes(d:&mut EntityDecoder<'_>, id:Option<u32>) -> Option<Frame> {
    let Some(id)=id else {return Some(IDENTITY)};
    let e=d.decode_by_id(id).ok()?;
    let p=d.point3(e.ref_at(slot::IfcPlacement::LOCATION)?).ok()?;
    let (z,x)=if e.ifc_type==IfcType::IfcAxis2Placement2D {
        ([0.,0.,1.],direction(d,e.ref_at(slot::IfcAxis2Placement2D::REF_DIRECTION),[1.,0.,0.])?)
    } else if e.ifc_type==IfcType::IfcAxis2Placement3D {
        (direction(d,e.ref_at(slot::IfcAxis2Placement3D::AXIS),[0.,0.,1.])?,direction(d,e.ref_at(slot::IfcAxis2Placement3D::REF_DIRECTION),[1.,0.,0.])?)
    } else {return None};
    let y=unit(cross(z,x))?;
    Some(columns(cross(y,z),y,z,p))
}
fn inverse_rigid(m:&Frame) -> Frame {
    let mut inv=IDENTITY;
    for i in 0..3 {for j in 0..3 {inv[i+4*j]=m[j+4*i];}}
    let p=vector(&inv,[-m[12],-m[13],-m[14]]);inv[12..15].copy_from_slice(&p);inv
}
fn placement(d:&mut EntityDecoder<'_>,mut id:Option<u32>) -> Option<Frame> {
    let mut m=IDENTITY;let mut seen=std::collections::BTreeSet::new();
    while let Some(next)=id {
        if !seen.insert(next)||seen.len()>128 {return None}
        let e=d.decode_by_id(next).ok()?;
        m=multiply(&axes(d,e.ref_at(slot::IfcLocalPlacement::RELATIVE_PLACEMENT))?,&m);
        id=e.ref_at(slot::IfcLocalPlacement::PLACEMENT_REL_TO);
    }
    Some(m)
}
/// IfcBaseAxis: project Axis1 against D3 and Axis2 against both, preserving its sign.
fn mapping(d:&mut EntityDecoder<'_>, source:u32,target:u32) -> Option<(Frame,Vec<u32>)> {
    let map=d.decode_by_id(source).ok()?;
    let origin=axes(d,map.ref_at(slot::IfcRepresentationMap::MAPPING_ORIGIN))?;
    let rep=d.decode_by_id(map.ref_at(slot::IfcRepresentationMap::MAPPED_REPRESENTATION)?).ok()?;
    let items=rep.ref_list_at(slot::IfcRepresentation::ITEMS)?;
    let op=d.decode_by_id(target).ok()?;
    use slot::IfcCartesianTransformationOperator3D as O;
    let z=direction(d,op.ref_at(O::AXIS3),[0.,0.,1.])?;
    let default=if z[0].abs()>0.999999 {[0.,1.,0.]} else {[1.,0.,0.]};
    let x=direction(d,op.ref_at(O::AXIS1),default)?;
    let x=unit(sub(x,z.map(|v|v*dot(x,z))))?;
    let y=direction(d,op.ref_at(O::AXIS2),[0.,1.,0.])?;
    let y=unit(sub(sub(y,z.map(|v|v*dot(y,z))),x.map(|v|v*dot(y,x))))?;
    let s=op.real_at(O::SCALE).unwrap_or(1.);
    let (s2,s3)=if op.ifc_type==IfcType::IfcCartesianTransformationOperator3DnonUniform {
        (op.real_at(slot::IfcCartesianTransformationOperator3DnonUniform::SCALE2).unwrap_or(s),
         op.real_at(slot::IfcCartesianTransformationOperator3DnonUniform::SCALE3).unwrap_or(s))
    } else if op.ifc_type==IfcType::IfcCartesianTransformationOperator3D {(s,s)} else {return None};
    let matrix=columns(x.map(|v|v*s),y.map(|v|v*s2),z.map(|v|v*s3),d.point3(op.ref_at(O::LOCAL_ORIGIN)?).ok()?);
    Some((multiply(&matrix,&inverse_rigid(&origin)),items))
}
// Independent symmetric Jacobi eigensolve for singular values; no production SVD.
fn stretches(m:&Frame) -> Option<(f64,f64)> {
    let mut a=[[0.;3];3];
    for i in 0..3 {for j in 0..3 {a[i][j]=(0..3).map(|k|m[4*i+k]*m[4*j+k]).sum();}}
    for _ in 0..32 {
        let (p,q)=[(0,1),(0,2),(1,2)].into_iter().max_by(|&(p,q),&(r,s)|a[p][q].abs().total_cmp(&a[r][s].abs()))?;
        if a[p][q].abs()<=1e-15*a[p][p].abs().max(a[q][q].abs()) {break}
        let theta=0.5*(2.*a[p][q]).atan2(a[q][q]-a[p][p]);let (s,c)=theta.sin_cos();
        let (app,aqq,apq)=(a[p][p],a[q][q],a[p][q]);
        let k=3-p-q; // the third axis of this 3x3 Jacobi rotation
        let (kp,kq)=(a[k][p],a[k][q]);a[k][p]=c*kp-s*kq;a[p][k]=a[k][p];a[k][q]=s*kp+c*kq;a[q][k]=a[k][q];
        a[p][p]=c*c*app-2.*s*c*apq+s*s*aqq;a[q][q]=s*s*app+2.*s*c*apq+c*c*aqq;a[p][q]=0.;a[q][p]=0.;
    }
    let min=(0..3).map(|i|a[i][i]).fold(f64::INFINITY,f64::min).sqrt();
    let max=(0..3).map(|i|a[i][i]).fold(0.,f64::max).sqrt();
    (min>0.&&max.is_finite()).then_some((min,max))
}
struct Solid { volume:f64, centroid:[f64;3], points:Vec<[f64;3]>, radius:f64 }
type ProfileMoments = (f64, [f64;3], Vec<[f64;3]>, f64);
fn curve_profile(d:&mut EntityDecoder<'_>,root:u32) -> Option<ProfileMoments> {
    let mut stack=vec![(root,true,0)];let (mut area,mut mx,mut my,mut radius)=(0.,0.,0.,0f64);
    let mut points=Vec::new();let mut work=0;
    while let Some((id,sense,depth))=stack.pop() {
        work+=1;if work>4096||depth>128{return None}
        let e=d.decode_by_id(id).ok()?;
        match e.ifc_type {
            IfcType::IfcCompositeCurve=>{
                for id in e.ref_list_at(slot::IfcCompositeCurve::SEGMENTS)? {
                    let segment=d.decode_by_id(id).ok()?;
                    let same=segment.logical_at(slot::IfcCompositeCurveSegment::SAME_SENSE)?;
                    stack.push((segment.ref_at(slot::IfcCompositeCurveSegment::PARENT_CURVE)?,sense==same,depth+1));
                }
            }
            IfcType::IfcPolyline=>{
                let mut p:Vec<_>=e.ref_list_at(slot::IfcPolyline::POINTS)?.into_iter().map(|id|d.point3(id).ok()).collect::<Option<_>>()?;
                if !sense {p.reverse();}
                for pair in p.windows(2) {
                    let (a,b)=(pair[0],pair[1]);let (dx,dy)=(b[0]-a[0],b[1]-a[1]);
                    area+=(a[0]*b[1]-a[1]*b[0])/2.;
                    mx+=dy*(a[0]*a[0]+a[0]*b[0]+b[0]*b[0])/6.;
                    my-=dx*(a[1]*a[1]+a[1]*b[1]+b[1]*b[1])/6.;
                }
                points.extend(p);
            }
            IfcType::IfcTrimmedCurve=>{
                let circle=d.decode_by_id(e.ref_at(slot::IfcTrimmedCurve::BASIS_CURVE)?).ok()?;
                if circle.ifc_type!=IfcType::IfcCircle{return None}
                let frame=axes(d,circle.ref_at(slot::IfcConic::POSITION))?;
                if frame[2]!=0.||frame[6]!=0.||frame[10]!=1.{return None}
                let r=circle.real_at(slot::IfcCircle::RADIUS)?;radius=radius.max(r);
                let offset=frame[1].atan2(frame[0]);
                let mut a=e.list_at(slot::IfcTrimmedCurve::TRIM1)?.first()?.as_float()?+offset;
                let mut b=e.list_at(slot::IfcTrimmedCurve::TRIM2)?.first()?.as_float()?+offset;
                if !e.logical_at(slot::IfcTrimmedCurve::SENSE_AGREEMENT)? {std::mem::swap(&mut a,&mut b);}
                if !a.is_finite()||!b.is_finite(){return None}
                let sweep=(b-a).rem_euclid(std::f64::consts::TAU);if sweep==0.{return None} b=a+sweep;
                if b-a>std::f64::consts::TAU+1e-12{return None}
                if !sense {std::mem::swap(&mut a,&mut b);}
                let (x,y)=(frame[12],frame[13]);
                let integrals=|t:f64|{let (sn,cs)=t.sin_cos();[
                    (r*x*sn-r*y*cs+r*r*t)/2.,
                    r*(x*x*sn+2.*x*r*(t/2.+(2.*t).sin()/4.)+r*r*(sn-sn.powi(3)/3.))/2.,
                    r*(-y*y*cs+2.*y*r*(t/2.-(2.*t).sin()/4.)+r*r*(-cs+cs.powi(3)/3.))/2.]};
                for t in [a,b] {points.push([x+r*t.cos(),y+r*t.sin(),0.]);}
                let (lo,hi)=(integrals(a),integrals(b));area+=hi[0]-lo[0];mx+=hi[1]-lo[1];my+=hi[2]-lo[2];
            }
            _=>return None,
        }
    }
    if !area.is_finite()||area.abs()<1e-30{return None}
    Some((area.abs(),[mx/area,my/area,0.],points,radius))
}
fn solid(d:&mut EntityDecoder<'_>,mut id:u32, depth:usize, work:&mut usize) -> Option<Solid> {
    *work=work.checked_sub(1)?;if depth>32 {return None}
    let mut seen=std::collections::BTreeSet::new();
    loop {
        if !seen.insert(id)||seen.len()>128 {return None}
        let e=d.decode_by_id(id).ok()?;
        if e.ifc_type!=IfcType::IfcCsgSolid {break}
        id=e.ref_at(slot::IfcCsgSolid::TREE_ROOT_EXPRESSION)?;
    }
    let e=d.decode_by_id(id).ok()?;
    if matches!(e.ifc_type,IfcType::IfcBooleanResult|IfcType::IfcBooleanClippingResult) {
        if e.enum_at(slot::IfcBooleanResult::OPERATOR)!=Some("DIFFERENCE") {return None}
        let a=solid(d,e.ref_at(slot::IfcBooleanResult::FIRST_OPERAND)?,depth+1,work)?;
        let right=e.ref_at(slot::IfcBooleanResult::SECOND_OPERAND)?;
        let r=d.decode_by_id(right).ok()?;
        if r.ifc_type==IfcType::IfcHalfSpaceSolid {return clipped_box(d,a,&r)}
        let b=solid(d,right,depth+1,work)?;
        return difference_boxes(a,b);
    }
    if e.ifc_type!=IfcType::IfcExtrudedAreaSolid {return None}
    use slot::IfcExtrudedAreaSolid as E;
    let depth=e.real_at(E::DEPTH)?;let axis=unit(d.direction3(e.ref_at(E::EXTRUDED_DIRECTION)?).ok()?)?;
    let frame=axes(d,e.ref_at(E::POSITION))?;
    let p=d.decode_by_id(e.ref_at(E::SWEPT_AREA)?).ok()?;
    let mut profile_frame=IDENTITY;
    let (area,center,points,radius)=match p.ifc_type {
        IfcType::IfcArbitraryClosedProfileDef => {
            curve_profile(d,p.ref_at(slot::IfcArbitraryClosedProfileDef::OUTER_CURVE)?)?
        }
        IfcType::IfcRectangleProfileDef => {
            profile_frame=axes(d,p.ref_at(slot::IfcParameterizedProfileDef::POSITION))?;
            let x=p.real_at(slot::IfcRectangleProfileDef::X_DIM)?/2.;let y=p.real_at(slot::IfcRectangleProfileDef::Y_DIM)?/2.;
            (4.*x*y,[0.;3],vec![[-x,-y,0.],[x,-y,0.],[x,y,0.],[-x,y,0.]],0.)
        }
        IfcType::IfcCircleProfileDef => {
            profile_frame=axes(d,p.ref_at(slot::IfcParameterizedProfileDef::POSITION))?;
            let r=p.real_at(slot::IfcCircleProfileDef::RADIUS)?;(std::f64::consts::PI*r*r,[0.;3],vec![[r,0.,0.],[-r,0.,0.],[0.,r,0.],[0.,-r,0.]],r)
        }
        _=>return None,
    };
    let c=transform(&profile_frame,center);let centroid=transform(&frame,std::array::from_fn(|i|c[i]+axis[i]*depth/2.));
    let points=points.into_iter().flat_map(|p|{let p=transform(&profile_frame,p);[0.,depth].map(|h|transform(&frame,std::array::from_fn(|i|p[i]+axis[i]*h)))}).collect();
    Some(Solid{volume:area*depth*axis[2].abs(),centroid,points,radius})
}
fn box_bounds(s:&Solid) -> Option<[f64;6]> {
    if s.radius!=0.||s.points.is_empty(){return None}
    let mut b=[f64::INFINITY,f64::INFINITY,f64::INFINITY,f64::NEG_INFINITY,f64::NEG_INFINITY,f64::NEG_INFINITY];
    for &p in &s.points{extend_bbox(&mut b,p)}
    let v=(0..3).map(|i|b[i+3]-b[i]).product::<f64>();
    ((v-s.volume).abs()<=s.volume*1e-12).then_some(b)
}
fn difference_boxes(a:Solid,b:Solid) -> Option<Solid> {
    let (aa,bb)=(box_bounds(&a)?,box_bounds(&b)?);
    let low:[f64;3]=std::array::from_fn(|i|aa[i].max(bb[i]));
    let high:[f64;3]=std::array::from_fn(|i|aa[i+3].min(bb[i+3]));
    if (0..3).any(|i|high[i]<=low[i]) {return Some(a)}
    // Qualify an internal through-hole only; no fabricated bbox when an entire
    // exterior face can disappear. M7's B-H falls inside X and Y, through Z.
    if !(low[0]>aa[0]&&high[0]<aa[3]&&low[1]>aa[1]&&high[1]<aa[4]) {return None}
    let removed=(0..3).map(|i|high[i]-low[i]).product::<f64>();let volume=a.volume-removed;
    if volume<=0. {return None}
    let centroid=std::array::from_fn(|i|(a.volume*a.centroid[i]-removed*(low[i]+high[i])/2.)/volume);
    Some(Solid{volume,centroid,points:a.points,radius:0.})
}
fn clipped_box(d:&mut EntityDecoder<'_>,a:Solid,half:&ifc_lite_core::DecodedEntity) -> Option<Solid> {
    let bounds=box_bounds(&a)?;
    if half.logical_at(slot::IfcHalfSpaceSolid::AGREEMENT_FLAG)!=Some(true) {return None}
    let plane=d.decode_by_id(half.ref_at(slot::IfcHalfSpaceSolid::BASE_SURFACE)?).ok()?;
    if plane.ifc_type!=IfcType::IfcPlane{return None}
    let frame=axes(d,plane.ref_at(slot::IfcElementarySurface::POSITION))?;
    let n=[frame[8],frame[9],frame[10]];if n[2]<=0.{return None}
    let c=dot(n,[frame[12],frame[13],frame[14]]);
    let height=|x:f64,y:f64|(c-n[0]*x-n[1]*y)/n[2]-bounds[2];
    let mut points=Vec::new();
    for x in [bounds[0],bounds[3]] {for y in [bounds[1],bounds[4]] {
        let h=height(x,y);if h<=0.||h>=bounds[5]-bounds[2]{return None}
        points.push([x,y,bounds[5]]);points.push([x,y,bounds[2]+h]);
    }}
    let (x,y)=((bounds[0]+bounds[3])/2.,(bounds[1]+bounds[4])/2.);let h=height(x,y);
    let (vx,vy)=((bounds[3]-bounds[0]).powi(2)/12.,(bounds[4]-bounds[1]).powi(2)/12.);
    let (dx,dy)=(-n[0]/n[2],-n[1]/n[2]);
    let removed_center=[x+dx*vx/h,y+dy*vy/h,bounds[2]+(h*h+dx*dx*vx+dy*dy*vy)/(2.*h)];
    let removed=(bounds[3]-bounds[0])*(bounds[4]-bounds[1])*h;
    let volume=a.volume-removed;
    let centroid=std::array::from_fn(|i|(a.volume*a.centroid[i]-removed*removed_center[i])/volume);
    Some(Solid{volume,centroid,points,radius:0.})
}
fn length_unit(bytes:&[u8],d:&mut EntityDecoder<'_>) -> Option<f64> {
    let mut scanner=ifc_lite_core::EntityScanner::new(bytes);
    while let Some((id,name,_,_))=scanner.next_entity() {
        if !name.eq_ignore_ascii_case("IFCPROJECT") {continue}
        let project=d.decode_by_id(id).ok()?;
        let units=d.decode_by_id(project.ref_at(slot::IfcProject::UNITS_IN_CONTEXT)?).ok()?;
        for id in units.ref_list_at(slot::IfcUnitAssignment::UNITS)? {
            let u=d.decode_by_id(id).ok()?;
            if u.enum_at(slot::IfcNamedUnit::UNIT_TYPE)!=Some("LENGTHUNIT") {continue}
            if u.ifc_type!=IfcType::IfcSIUnit||u.enum_at(slot::IfcSIUnit::NAME)!=Some("METRE") {return None}
            return match u.enum_at(slot::IfcSIUnit::PREFIX) {
                None=>Some(1.),Some("MILLI")=>Some(0.001),Some("CENTI")=>Some(0.01),Some("DECI")=>Some(0.1),
                Some("MICRO")=>Some(1e-6),Some("KILO")=>Some(1000.),_=>None,
            };
        }
    }
    None
}
/// One result per authored final part. Unsupported oracle families return None,
/// never an invented geometric expectation or a measured-runtime baseline.
pub fn expected(bytes:&[u8],id:u32) -> Option<Vec<AffineExpectation>> {
    let source=SourceBundle::new(bytes.to_vec());let mut d=source.decoder();let units=length_unit(bytes,&mut d)?;let p=d.decode_by_id(id).ok()?;
    let world=placement(&mut d,p.ref_at(slot::IfcProduct::OBJECT_PLACEMENT))?;
    let reps=d.decode_by_id(p.ref_at(slot::IfcProduct::REPRESENTATION)?).ok()?.ref_list_at(slot::IfcProductRepresentation::REPRESENTATIONS)?;
    let mut stack=Vec::new();
    for id in reps {let rep=d.decode_by_id(id).ok()?;if rep.string_at(slot::IfcRepresentation::REPRESENTATION_IDENTIFIER)==Some("Body") {
        for id in rep.ref_list_at(slot::IfcRepresentation::ITEMS)?.into_iter().rev() {stack.push((id,world,IDENTITY,0));}
    }}
    let mut result=Vec::new();let mut work=0;
    while let Some((id,world,mapping_matrix,depth))=stack.pop() {
        work+=1;if work>8192||depth>128 {return None}
        let e=d.decode_by_id(id).ok()?;
        if e.ifc_type==IfcType::IfcMappedItem {
            let (map,items)=mapping(&mut d,e.ref_at(slot::IfcMappedItem::MAPPING_SOURCE)?,e.ref_at(slot::IfcMappedItem::MAPPING_TARGET)?)?;
            for item in items.into_iter().rev() {stack.push((item,world,multiply(&mapping_matrix,&map),depth+1));}
            continue;
        }
        let s=solid(&mut d,id,0,&mut 8192)?;let mut matrix=multiply(&world,&mapping_matrix);
        for col in 0..4 {for row in 0..3 {matrix[col*4+row]*=units;}}
        let det=dot([matrix[0],matrix[1],matrix[2]],cross([matrix[4],matrix[5],matrix[6]],[matrix[8],matrix[9],matrix[10]]));
        let support_bounds=if s.points.is_empty(){None}else{let mut b=[f64::INFINITY,f64::INFINITY,f64::INFINITY,f64::NEG_INFINITY,f64::NEG_INFINITY,f64::NEG_INFINITY];
            for p in s.points {extend_bbox(&mut b,transform(&matrix,p));}Some(b)};
        let extent=support_bounds.map(|b|(0..3).map(|i|b[i+3]-b[i]).fold(0.,f64::max))?;
        let bbox=if s.radius==0. {support_bounds} else {None};
        let (min,max)=stretches(&mapping_matrix)?;
        let m=&mapping_matrix;
        let reflected=dot([m[0],m[1],m[2]],cross([m[4],m[5],m[6]],[m[8],m[9],m[10]]))<0.;
        let affine_final=reflected||(min-1.).abs()>1e-12||(max-1.).abs()>1e-12;
        result.push(AffineExpectation{volume:s.volume*det.abs(),centroid:transform(&matrix,s.centroid),bbox,extent,radius:s.radius*units,matrix,sigma_max:max,kappa:max/min,affine_final});
    }
    (!result.is_empty()).then_some(result)
}
/// Translation-stable signed volume and centroid, in absolute IFC axes.
pub fn mesh_moments(p:&[f64],ids:&[u32],frame:&Frame) -> Option<(f64,[f64;3])> {
    let origin:[f64;3]=p.get(..3)?.try_into().ok()?;let mut v=0.;let mut c=[0.;3];
    for t in ids.chunks_exact(3) {
        let point=|id:u32| -> Option<[f64;3]> {let at=id as usize*3;let q:[f64;3]=p.get(at..at+3)?.try_into().ok()?;Some(sub(q,origin))};
        let (a,b,d)=(point(t[0])?,point(t[1])?,point(t[2])?);let dv=dot(a,cross(b,d))/6.;v+=dv;
        for k in 0..3 {c[k]+=(a[k]+b[k]+d[k])*dv/4.;}
    }
    if !v.is_finite()||v==0. {return None}
    Some((v,transform(frame,std::array::from_fn(|i|c[i]/v+origin[i]))))
}
