// SPDX-License-Identifier: MPL-2.0
//! Terminal-aware final drain without replaying processor callbacks.
use crate::{BoolFailure, GeometryRouter, resource::{self, ProgramStop}};
use rustc_hash::FxHashMap;

impl GeometryRouter {
    /// Drain diagnostics once, retaining their original buckets if a reached
    /// processor hook stops execution. The ordinary drain remains unchanged.
    /// A stopped drain restores evidence for an explicit diagnostic caller;
    /// it never attributes those records to a subsequent product.
    pub fn take_csg_failures_checked(&self) -> Result<FxHashMap<u32, Vec<BoolFailure>>, ProgramStop> {
        resource::check_current()?;
        let failures = self.take_csg_failures();
        match resource::check_current() {
            Ok(()) => Ok(failures),
            Err(stop) => {
                let mut retained = self.csg_failures.borrow_mut();
                for (id, mut records) in failures {
                    let later = retained.entry(id).or_default();
                    records.append(later);
                    *later = records;
                }
                Err(stop)
            }
        }
    }
}
