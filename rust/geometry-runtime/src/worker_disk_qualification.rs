// SPDX-License-Identifier: MPL-2.0
//! Real pipe witnesses for the separate exact-coefficient numerical route.
use super::{MeshLimits, SmlibWorker, WorkerError};
use std::f64::consts::PI;
impl SmlibWorker {
    /// Explicitly qualify this incarnation's supported open rational pipe route.
    /// Source interpretation, closed/hollow paths and rational regions remain
    /// outside this witness. Feature negotiation alone does not open the gate.
    pub fn qualify_rational_disks(&mut self) -> Result<Vec<f64>, WorkerError> {
        self.disks_qualified=false;
        let incarnation=self.incarnation();
        if incarnation==0 { return Err(WorkerError::WrongWorker); }
        let mut volumes=Vec::new();
        for curved in [false,true] {
            let bytes=recipe(curved);
            let solid=self.create_sweep(&bytes,2,1,1)?;
            let result=(|| {
                let volume=self.volume(solid,1e-8)?;
                let expected=PI*0.25*0.25*if curved {2.*PI} else {5.};
                if !self.is_manifold(solid)? || (volume-expected).abs()>expected*1e-4 {
                    return Err(WorkerError::Authored("rational pipe volume/manifold witness failed".into()));
                }
                let mesh=self.tessellate(solid,0.0001,5.,MeshLimits {max_bytes:16*1024*1024})?;
                if !curved {
                    let mut min=[f64::INFINITY;3];let mut max=[f64::NEG_INFINITY;3];
                    for p in mesh.positions.chunks_exact(3) {for i in 0..3 {min[i]=min[i].min(p[i]);max[i]=max[i].max(p[i]);}}
                    for i in 0..3 {
                        let lo=[-0.25,-0.25,0.][i];let hi=[0.25,0.25,5.][i];
                        if (min[i]-lo).abs()>0.002 || (max[i]-hi).abs()>0.002 {
                            return Err(WorkerError::Authored("rational pipe bounds witness failed".into()));
                        }
                    }
                }
                Ok(volume)
            })();
            let cleanup=self.release(solid);
            match (result,cleanup) { (Ok(v),Ok(()))=>volumes.push(v),(Err(e),_)|(_,Err(e))=>return Err(e) }
        }
        if self.incarnation()!=incarnation {return Err(WorkerError::WrongWorker);}
        self.disks_qualified=true;
        Ok(volumes)
    }
}
fn recipe(curved:bool)->Vec<u8> {
    let mut b=Vec::new();
    for v in [2u32,1,1,0] {b.extend(v.to_le_bytes());}
    for v in [0.25f64,0.] {b.extend(v.to_le_bytes());}
    for v in [4u32,0,if curved {2} else {1},if curved {3} else {2},2,0] {b.extend(v.to_le_bytes());}
    for v in [0f64,1.] {b.extend(v.to_le_bytes());}
    let controls=if curved {vec![4.,0.,0.,1.,4.,4.,0.,0.5f64.sqrt(),0.,4.,0.,1.]} else {vec![0.,0.,0.,2.,0.,0.,5.,3.]};
    for v in controls {b.extend(v.to_le_bytes());}
    for knot in [0f64,1.] {b.extend(knot.to_le_bytes());b.extend((if curved {3u32} else {2u32}).to_le_bytes());b.extend(0u32.to_le_bytes());}
    b
}
