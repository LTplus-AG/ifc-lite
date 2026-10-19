// SPDX-License-Identifier: MPL-2.0
//! Explicit same-incarnation numerical witnesses, never a capability-bit bypass.
use super::{MeshLimits, SmlibWorker, WorkerError};
use std::f64::consts::{PI, TAU};

/// Observed runtime witness only. This does not certify source interpretation,
/// appearance, face provenance, retained USD, or another native/browser target.
#[derive(Debug)]
pub struct RegionQualificationReport {
    pub worker_incarnation: u64,
    pub cases: usize,
    pub volumes: Vec<f64>,
}
#[derive(Clone)]
struct Curve { kind: u32, values: [f64; 12] }
fn line(a: [f64; 2], b: [f64; 2]) -> Curve {
    Curve { kind: 1, values: [a[0], a[1], 0., b[0], b[1], 0., 0., 0., 0., 0., 0., 0.] }
}
fn arc(radius: f64, sweep: f64) -> Curve {
    Curve { kind: if sweep.abs() == TAU { 2 } else { 3 },
        values: [0., 0., 0., 0., 0., 1., 1., 0., 0., radius, 0., sweep] }
}
fn square(half: f64, inner: bool) -> Vec<Curve> {
    let mut points = [[-half, -half], [half, -half], [half, half], [-half, half]];
    if inner { points.reverse(); }
    (0..4).map(|i| line(points[i], points[(i+1)%4])).collect()
}
fn recipe(loops: &[Vec<Curve>], oblique: bool) -> (Vec<u8>, u32) {
    let count = loops.iter().map(Vec::len).sum::<usize>() as u32;
    let mut bytes = Vec::new();
    for value in [1, loops.len() as u32, count, 0] { bytes.extend(value.to_le_bytes()); }
    for value in [if oblique { 0.6f64 } else { 0. }, 0., if oblique { 0.8 } else { 1. }, 3.] {
        bytes.extend(value.to_le_bytes());
    }
    for (i, boundary) in loops.iter().enumerate() {
        bytes.extend(u32::from(i != 0).to_le_bytes());
        bytes.extend((boundary.len() as u32).to_le_bytes());
        for curve in boundary {
            bytes.extend(curve.kind.to_le_bytes()); bytes.extend(0u32.to_le_bytes());
            for value in curve.values { bytes.extend(value.to_le_bytes()); }
        }
    }
    (bytes, count)
}
impl SmlibWorker {
    /// Run real SDK uploads, positive volumes, manifold, independent cap bounds
    /// and boundary mesh invariants on THIS actual process. No fixture
    /// or protocol peer can manufacture the private qualified state. Failure
    /// leaves the gate closed. A new process must qualify independently.
    pub fn qualify_ordered_regions(&mut self) -> Result<RegionQualificationReport, WorkerError> {
        self.regions_qualified = false;
        let incarnation = self.incarnation();
        if incarnation == 0 { return Err(WorkerError::WrongWorker); }
        let cases = vec![
            (vec![vec![arc(2., TAU)]], 4.*PI, false, 2., false),
            (vec![vec![arc(2., -TAU)]], 4.*PI, false, 2., false),
            (vec![vec![arc(2., TAU)], vec![arc(1., -TAU)]], 3.*PI, false, 2., false),
            (vec![square(3., false), square(1., true)], 32., false, 3., false),
            (vec![vec![arc(2., PI), line([-2.,0.], [2.,0.])]], 2.*PI, false, 2., true),
            (vec![vec![arc(2., TAU)], vec![arc(1., -TAU)]], 3.*PI, true, 2., false),
        ];
        let mut volumes = Vec::new();
        for (loops, area, oblique, half, half_disk) in &cases {
            let (bytes, segments) = recipe(loops, *oblique);
            let solid = self.create_sweep(&bytes, 1, loops.len() as u32, segments)?;
            let result = (|| {
                let volume = self.volume(solid, 1e-8)?;
                let height = if *oblique { 2.4 } else { 3. };
                if !self.is_manifold(solid)? || (volume-area*height).abs() > area*height*1e-5 {
                    return Err(WorkerError::Authored("ordered-region volume/manifold witness failed".into()));
                }
                let mesh = self.tessellate(solid, 0.0001, 5., MeshLimits { max_bytes: 16*1024*1024 })?;
                let mut min = [f64::INFINITY; 3]; let mut max = [f64::NEG_INFINITY; 3];
                for point in mesh.positions.chunks_exact(3) { for axis in 0..3 {
                    min[axis] = min[axis].min(point[axis]); max[axis] = max[axis].max(point[axis]);
                }}
                let expected_min = [-half, if *half_disk { 0. } else { -half }, 0.];
                let expected_max = [half + if *oblique { 1.8 } else { 0. }, *half, height];
                if (0..3).any(|i| (min[i]-expected_min[i]).abs()>0.002 || (max[i]-expected_max[i]).abs()>0.002) {
                    return Err(WorkerError::Authored("ordered-region cap bounds witness failed".into()));
                }
                // Circular annular caps cannot include a vertex inside the hole.
                if loops.len() == 2 && loops[0].len() == 1 {
                    for p in mesh.positions.chunks_exact(3) {
                        let x = p[0] - if *oblique { p[2]*0.75 } else { 0. };
                        let r = x.hypot(p[1]);
                        if !(0.999..=2.001).contains(&r) {
                            return Err(WorkerError::Authored("annular boundary witness failed".into()));
                        }
                    }
                }
                Ok(volume)
            })();
            let cleanup = self.release(solid);
            let volume = match (result, cleanup) { (Ok(v), Ok(())) => v, (Err(e), _) | (_, Err(e)) => return Err(e) };
            volumes.push(volume);
        }
        if self.incarnation() != incarnation { return Err(WorkerError::WrongWorker); }
        self.regions_qualified = true;
        Ok(RegionQualificationReport { worker_incarnation: incarnation, cases: cases.len(), volumes })
    }
}
