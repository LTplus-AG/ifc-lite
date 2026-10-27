// SPDX-License-Identifier: MPL-2.0
//! Backing charges follow their storage, including rejected packets and witnesses.
use super::*;
#[derive(Default)]
pub(super) struct Storage(Option<Box<Node>>);
struct Node { next: Option<Box<Node>>, _backing: Reservation, _node: Reservation }
impl Storage {
    pub(super) fn charge(&mut self, resources: &OwnedResourceContext, cost: resource::Cost)
        -> Result<(), RetainedExecutionError> {
        let backing = resources.with_scope(|| resource::charge(cost)).map_err(RetainedExecutionError::Stopped)?;
        self.hold(resources, backing)
    }
    pub(super) fn reserve<T>(&mut self, resources: &OwnedResourceContext, values: &mut Vec<T>, count: usize)
        -> Result<(), RetainedExecutionError> {
        let capacity = values.len().checked_add(count).ok_or_else(|| RetainedExecutionError::Stopped(resource::overflow()))?;
        if capacity <= values.capacity() { return Ok(()); }
        // Admit the bookkeeping before Vec growth; no uncharged failing tail.
        let node = Self::node_permit(resources)?;
        let backing = resources.reserve_headers(values, count).map_err(RetainedExecutionError::Stopped)?;
        self.0 = Some(Box::new(Node { next: self.0.take(), _backing: backing, _node: node }));
        Ok(())
    }
    fn node_permit(resources: &OwnedResourceContext) -> Result<Reservation, RetainedExecutionError> {
        resources.with_scope(|| resource::charge(resource::Cost {
            live_bytes: std::mem::size_of::<Node>() as u64, ..Default::default()
        })).map_err(RetainedExecutionError::Stopped)
    }
    fn hold(&mut self, resources: &OwnedResourceContext, backing: Reservation) -> Result<(), RetainedExecutionError> {
        let node = Self::node_permit(resources)?;
        self.0 = Some(Box::new(Node { next: self.0.take(), _backing: backing, _node: node }));
        Ok(())
    }
}
impl Drop for Storage {
    fn drop(&mut self) {
        while let Some(mut node) = self.0.take() { self.0 = node.next.take(); }
    }
}

impl std::fmt::Debug for Storage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Storage").finish_non_exhaustive()
    }
}
