// SPDX-License-Identifier: MPL-2.0
//! Terminal-aware final diagnostic drain without replaying processor callbacks.
use super::GeometryRouter;
use crate::BoolFailure;
use rustc_hash::FxHashMap;

impl GeometryRouter {
    /// [`Self::take_csg_failures`] for a terminal-aware final drain. If a
    /// processor's drain hook stops execution, the drained records go back
    /// into their original buckets, ahead of any later ones, for an explicit
    /// diagnostic caller; they are never attributed to a subsequent product.
    pub fn take_csg_failures_checked(
        &self,
    ) -> Result<FxHashMap<u32, Vec<BoolFailure>>, crate::resource::ProgramStop> {
        crate::resource::check_current()?;
        let failures = self.take_csg_failures();
        match crate::resource::check_current() {
            Ok(()) => Ok(failures),
            Err(stop) => {
                restore_csg_failures(&mut self.csg_failures.borrow_mut(), failures);
                Err(stop)
            }
        }
    }
}

#[cold]
#[inline(never)]
fn restore_csg_failures(
    retained: &mut FxHashMap<u32, Vec<BoolFailure>>,
    failures: FxHashMap<u32, Vec<BoolFailure>>,
) {
    for (id, mut records) in failures {
        let later = retained.entry(id).or_default();
        records.append(later);
        *later = records;
    }
}
