// SPDX-License-Identifier: MPL-2.0
//! Only reached, complete logical sources enter this cache; exact meshes cannot.
use super::{copy_values, LogicalRetainedValue};
use ifc_lite_core::execution_owner::ExecutionIdentity;
use rustc_hash::FxHashMap;
use std::sync::{Arc, Mutex};
#[derive(Default)]
pub(super) struct RetainedCache {
    owner: Arc<Mutex<Option<(ExecutionIdentity, ExecutionIdentity)>>>,
    values: Mutex<FxHashMap<u32, Vec<LogicalRetainedValue>>>,
}
impl RetainedCache {
    // Each root has fixed presentation inputs. Do not reuse cached bindings
    // across plain/styled roots or different borrowed texture indexes.
    pub(super) fn for_root(&self) -> Self {
        Self { owner: self.owner.clone(), values: Mutex::default() }
    }
    pub(super) fn validate_owner(&self, decoder: ExecutionIdentity, router: ExecutionIdentity) -> crate::Result<()> {
        let mut owner_state = self.owner.lock().unwrap_or_else(|e| e.into_inner());
        match *owner_state {
            Some(owner) if owner != (decoder, router) => return Err(crate::Error::geometry(
                "stale retained cache source/configuration provenance")),
            None => *owner_state = Some((decoder, router)),
            _ => {}
        }
        Ok(())
    }
    pub(super) fn admit(&self, decoder: ExecutionIdentity, router: ExecutionIdentity,
        source: u32, walk: &super::walk::RetainedWalk) -> crate::Result<Option<Vec<LogicalRetainedValue>>> {
        self.validate_owner(decoder,router)?;
        let state = self.values.lock().unwrap_or_else(|e| e.into_inner());
        state.get(&source).map(|values| {
            walk.charge(values.len() as u64)?;
            copy_values(values)
        }).transpose()
    }
    pub(super) fn publish(&self, source: u32, values: &[LogicalRetainedValue],
        walk: &super::walk::RetainedWalk) -> crate::Result<()> {
        // Copy and admit storage before publication; refusal never installs a
        // partial cache entry. Earlier completed sources remain available.
        walk.charge(values.len() as u64)?;
        let copied = copy_values(values)?;
        let mut state = self.values.lock().unwrap_or_else(|e| e.into_inner());
        crate::resource::charge(crate::resource::Cost {
            live_bytes: std::mem::size_of::<(u32, Vec<LogicalRetainedValue>)>() as u64,
            ..Default::default()
        })?.retain();
        state.try_reserve(1).map_err(|_| crate::resource::allocation_failure())?;
        state.insert(source, copied);
        Ok(())
    }
}
