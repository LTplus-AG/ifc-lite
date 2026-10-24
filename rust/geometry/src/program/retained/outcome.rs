// SPDX-License-Identifier: MPL-2.0
//! One write-once numerical classification per logical definition.
use std::sync::{Arc, OnceLock};
pub(super) fn new() -> crate::Result<Arc<OnceLock<bool>>> {
    crate::resource::charge(crate::resource::Cost {
        live_bytes: (std::mem::size_of::<OnceLock<bool>>() + 2 * std::mem::size_of::<usize>()) as u64,
        ..Default::default()
    })?.retain();
    Ok(Arc::new(OnceLock::new()))
}
