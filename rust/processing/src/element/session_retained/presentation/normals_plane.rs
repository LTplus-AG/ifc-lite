// SPDX-License-Identifier: MPL-2.0
//! One verified plane normal per revision-local kernel face (#7955 ruling C).
use super::{cross, dot, length, sub, unit, work, world_vector, Corner,
    OwnedResourceContext, RetainedExecutionError, ShapePart, Storage};

// Existing M11-F faceIncidence, in world metres; not an angular tolerance.
const FACE_INCIDENCE: f64 = 1e-6;

#[derive(Default)]
struct Sum { value: [f64;3], correction: [f64;3] }
impl Sum {
    fn add(&mut self, v: [f64;3]) {
        for (i, v) in v.into_iter().enumerate() {
            let y = v - self.correction[i];
            let t = self.value[i] + y;
            self.correction[i] = (t - self.value[i]) - y;
            self.value[i] = t;
        }
    }
}
fn point(part: &ShapePart, index: u32) -> [f64;3] {
    let i = index as usize * 3;
    [part.positions[i],part.positions[i+1],part.positions[i+2]]
}

pub(super) fn normals(part: &ShapePart, corners: &[Corner], resources: &OwnedResourceContext,
    scratch: &mut Storage) -> Result<Vec<Option<[f64;3]>>,RetainedExecutionError> {
    let count = part.revision_local_faces.len();
    let mut order = Vec::new();
    let mut result = Vec::new();
    scratch.reserve(resources,&mut order,count)?;
    scratch.reserve(resources,&mut result,count)?;
    order.extend((0..count).map(|i| (part.revision_local_faces[i],i)));
    result.resize(count,None);
    // Bounded ids need not be dense. Account for grouping as well as each scan.
    work(resources,count.saturating_mul(count.max(1).ilog2() as usize + 1))?;
    order.sort_unstable();
    let mut start = 0;
    while start < order.len() {
        let mut end = start + 1;
        while end < order.len() && order[end].0 == order[start].0 {end += 1;}
        let face = &order[start..end];
        let normal = fit(part,corners,face,resources)?;
        for &(_,t) in face {result[t] = normal;}
        start = end;
    }
    Ok(result)
}

fn fit(part: &ShapePart, corners: &[Corner], face: &[(u32,usize)], resources: &OwnedResourceContext)
    -> Result<Option<[f64;3]>,RetainedExecutionError> {
    let origin = point(part,part.indices[face[0].1*3]);
    let mut area = Sum::default();
    let mut centroid = Sum::default();
    for &(_,t) in face {
        work(resources,1)?;
        let p: [[f64;3];3] = std::array::from_fn(|c| world_vector(&part.world_from_object,
            sub(point(part,part.indices[t*3+c]),origin)));
        // Summing oriented triangle area vectors is Newell's boundary sum:
        // internal edges cancel, so a tiny facet never dominates the normal.
        area.add(cross(sub(p[1],p[0]),sub(p[2],p[0])));
        for v in p {centroid.add(v);}
    }
    let norm = length(area.value);
    if !norm.is_finite() || norm == 0. {return Ok(None);}
    let mut normal = unit(area.value)?;
    let center = centroid.value.map(|v| v/(face.len() as f64*3.));
    let mut majority = 0_i64;
    for &(_,t) in face {
        work(resources,1)?;
        majority += if dot(corners[t*3].normal,normal) >= 0. {1} else {-1};
        for &v in &part.indices[t*3..t*3+3] {
            let p = world_vector(&part.world_from_object,sub(point(part,v),origin));
            let distance = dot(sub(p,center),normal).abs();
            if !distance.is_finite() || distance > FACE_INCIDENCE {return Ok(None);}
        }
    }
    if majority == 0 {return Ok(None);}
    if majority < 0 {normal = normal.map(|v| -v);}
    Ok(Some(normal))
}
