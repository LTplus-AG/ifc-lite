// SPDX-License-Identifier: MPL-2.0
//! Physical tessellation witness only. This does NOT qualify exact BRep sections.
use super::analytic::Oracle;
impl Oracle {
    pub(in super::super) fn assert_stage(&self, cut: usize, actual: f64) {
        let expected=self.stages[(cut-1)%self.stages.len()];
        assert!((actual-expected).abs()<1e-6,
            "cut {cut}: analytic source volume {expected:.17}, actual {actual:.17}");
    }
    pub(in super::super) fn assert_mesh(&self, positions: &[f64], indices: &[u32], frame: &[f64;16]) {
        assert!(frame.iter().all(|v|v.is_finite()));
        assert_eq!([frame[3],frame[7],frame[11],frame[15]],[0.,0.,0.,1.]);
        let points:Vec<[f64;3]>=positions.chunks_exact(3).map(|p|std::array::from_fn(|i|
            frame[i]*p[0]+frame[4+i]*p[1]+frame[8+i]*p[2]+frame[12+i])).collect();
        assert!(!points.is_empty());
        for axis in 0..3 {
            let lo=points.iter().map(|p|p[axis]).fold(f64::INFINITY,f64::min);
            let hi=points.iter().map(|p|p[axis]).fold(f64::NEG_INFINITY,f64::max);
            assert!((lo-self.bounds[axis]).abs()<1e-6 && (hi-self.bounds[axis+3]).abs()<1e-6,
                "source-derived physical bounds axis {axis}: {lo}..{hi}");
        }
        for (z,expected) in &self.sections {
            let mut hits=Vec::new();
            for t in indices.chunks_exact(3) {
                let [a,b,c]=[points[t[0] as usize],points[t[1] as usize],points[t[2] as usize]];
                let [u,v]=[sub(b,a),sub(c,a)];
                let normal_x=u[1]*v[2]-u[2]*v[1];
                if normal_x==0. {continue;}
                let dy=self.y-a[1];let dz=z-a[2];
                let s=(dy*v[2]-dz*v[1])/normal_x;
                let r=(u[1]*dz-u[2]*dy)/normal_x;
                // Only de-duplicate triangle-edge hits; endpoint comparison remains 1e-6.
                if s>=-1e-12 && r>=-1e-12 && s+r<=1.+1e-12 {
                    hits.push((a[0]+s*u[0]+r*v[0],if normal_x<0. {-1i8} else {1i8}));
                }
            }
            hits.sort_by(|a,b|a.0.total_cmp(&b.0));
            hits.dedup_by(|a,b|a.1==b.1 && (a.0-b.0).abs()<1e-10);
            assert_eq!(hits.len(),expected.len(),"physical signed section y={}, z={z}: {hits:?} vs {expected:?}",self.y);
            for (a,e) in hits.iter().zip(expected) {
                assert_eq!(a.1,e.1,"signed material boundary z={z}");
                assert!((a.0-e.0).abs()<1e-6,"physical section z={z}: {a:?} vs source {e:?}");
            }
        }
    }
}
fn sub(a:[f64;3],b:[f64;3])->[f64;3] {std::array::from_fn(|i|a[i]-b[i])}
