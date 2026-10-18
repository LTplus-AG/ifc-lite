// SPDX-License-Identifier: MPL-2.0
use super::*;
use std::sync::{Arc, Mutex};
#[derive(Debug)]
struct Pool { limit: u64, used: Mutex<u64> }
/// Model resident admission is independent of deterministic per-request quotas.
/// Request quotas are reserved up front; no cache lock or partial request holds
/// a permit while waiting for another. Hosts retry WaitingForCapacity on release.
#[derive(Debug, Clone)]
pub struct ModelResourcePool(Arc<Pool>);
#[derive(Debug)]
pub enum RequestAdmission { Ready(ExecutionAccount), WaitingForCapacity }
#[derive(Debug)]
pub(super) struct PoolPermit { pool: Arc<Pool>, bytes: u64 }
impl ModelResourcePool {
    pub fn new(live_bytes: u64) -> Self { Self(Arc::new(Pool { limit: live_bytes, used: Mutex::new(0) })) }
    pub fn resident_bytes(&self) -> u64 { *self.0.used.lock().unwrap_or_else(|e| e.into_inner()) }
    /// A finite request live allowance is required for pooled execution. Opaque
    /// allocations remain excluded even after a resident permit is granted.
    pub fn admit(&self, limits: ResourceLimits) -> Result<RequestAdmission, ProgramStop> {
        let Some(bytes) = limits.live_bytes else {
            return Err(ProgramStop::ResourceRefused(ResourceFailure { dimension: Dimension::LiveBytes,
                requested: u64::MAX, remaining: self.0.limit, reason: RefusalReason::UnsupportedCoverage }));
        };
        if bytes > self.0.limit {
            return Err(ProgramStop::ResourceRefused(ResourceFailure { dimension: Dimension::LiveBytes,
                requested: bytes, remaining: self.0.limit, reason: RefusalReason::Limit }));
        }
        let mut used = self.0.used.lock().unwrap_or_else(|e| e.into_inner());
        if bytes > self.0.limit - *used { return Ok(RequestAdmission::WaitingForCapacity) }
        *used += bytes;
        drop(used);
        Ok(RequestAdmission::Ready(ExecutionAccount::bounded(limits,
            Some(PoolPermit { pool: Arc::clone(&self.0), bytes }))))
    }
}
impl Drop for PoolPermit {
    fn drop(&mut self) { *self.pool.used.lock().unwrap_or_else(|e| e.into_inner()) -= self.bytes; }
}
