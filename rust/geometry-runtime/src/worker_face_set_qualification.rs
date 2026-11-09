// SPDX-License-Identifier: MPL-2.0
//! Real closed-shell witness for the polyhedral face-set route (#8291).
use super::{SmlibWorker, WorkerError};
impl SmlibWorker {
    /// Explicitly qualify this incarnation's stitched face-set solids. A capability
    /// bit alone does not open the gate; an old worker refuses here.
    pub fn qualify_face_sets(&mut self) -> Result<f64, WorkerError> {
        self.face_sets_qualified = false;
        let incarnation = self.incarnation();
        if incarnation == 0 {
            return Err(WorkerError::WrongWorker);
        }
        let solid = self.create_sweep(&recipe(), 3, 1, 4)?;
        let result = (|| {
            let volume = self.volume(solid, 1e-8)?;
            if !self.is_manifold(solid)? || (volume - 1. / 6.).abs() > 1e-6 {
                return Err(WorkerError::Unqualified("face-set volume/manifold witness failed"));
            }
            Ok(volume)
        })();
        let cleanup = self.release(solid);
        let volume = match (result, cleanup) {
            (Ok(volume), Ok(())) => volume,
            (Err(error), _) | (_, Err(error)) => return Err(error),
        };
        if self.incarnation() != incarnation {
            return Err(WorkerError::WrongWorker);
        }
        self.face_sets_qualified = true;
        Ok(volume)
    }
}
/// A unit corner tetrahedron, volume 1/6, wound outward (wire format 3).
fn recipe() -> Vec<u8> {
    let mut bytes = Vec::new();
    for value in [3u32, 4, 4, 4] { bytes.extend(value.to_le_bytes()); }
    for value in [0f64, 0., 0., 1., 0., 0., 0., 1., 0., 0., 0., 1.] { bytes.extend(value.to_le_bytes()); }
    for value in [0u32, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3, 0, 1, 2, 3] { bytes.extend(value.to_le_bytes()); }
    bytes
}
