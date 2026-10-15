// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Request admission control: bounded parse concurrency + a byte-weighted
//! memory budget + a coarse RSS circuit breaker.
//!
//! Every parse handler acquires an [`AdmissionGuard`] BEFORE buffering the
//! upload. Without this, N concurrent large uploads each buffer the full file
//! and spawn blocking decode/mesh work whose working set is a multiple of the
//! file size; nothing bounds N, so the container is OOM-killed (a full outage
//! on the single-replica deployment). The byte-weighted semaphore is the
//! load-bearing bound: total admitted upload bytes can never exceed the
//! configured budget. The CPU semaphore keeps the blocking pool from
//! thrashing, and the RSS breaker sheds load before the kernel does.
//!
//! Explicit semaphores were chosen over `tower::limit::GlobalConcurrencyLimit`:
//! the tower layer makes over-limit requests wait unboundedly with no 503/
//! `Retry-After`, wraps cheap GET routes too, and cannot express a byte budget.

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::error::ApiError;

/// Tuning knobs, derived from [`crate::config::Config`] at startup.
#[derive(Debug, Clone)]
pub struct AdmissionCfg {
    /// Parse jobs allowed to run at once (CPU gate).
    pub max_concurrent_parses: usize,
    /// Total upload bytes allowed to be admitted at once. `0` disables the
    /// memory gate (the CPU gate still applies).
    pub mem_budget_bytes: u64,
    /// Requests allowed to WAIT for a permit before immediate rejection.
    pub queue_depth: usize,
    /// Longest a queued request waits for a permit before rejection.
    pub queue_timeout: std::time::Duration,
    /// RSS high-water percentage of `mem_budget_bytes` above which new parse
    /// jobs are shed outright (the circuit breaker). Inert when the budget or
    /// the sampled RSS is 0.
    pub shed_pct: u8,
}

/// One memory-budget permit spans this many upload bytes, so the semaphore's
/// permit count stays far below `Semaphore::MAX_PERMITS` even for multi-GB
/// budgets.
const BYTES_PER_PERMIT: u64 = 1024 * 1024;

/// Shared admission state (one per process, in `AppState`).
pub struct Admission {
    cpu: Arc<Semaphore>,
    /// `None` when the memory gate is disabled (`mem_budget_bytes == 0`).
    mem: Option<Arc<Semaphore>>,
    queued: AtomicUsize,
    in_flight: AtomicUsize,
    rejected_overload: AtomicU64,
    rejected_queue_full: AtomicU64,
    rejected_shed: AtomicU64,
    /// Resident set size sampled by the background loop (bytes). Tests write
    /// this directly; production writes come from [`spawn_rss_sampler`].
    resident_bytes: AtomicU64,
    cfg: AdmissionCfg,
}

/// A place in the bounded wait queue, given back on drop.
struct QueuedCount<'a>(&'a AtomicUsize);

impl Drop for QueuedCount<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

/// RAII permit pair; drops release the slots.
#[derive(Debug)]
pub struct AdmissionGuard {
    _cpu: OwnedSemaphorePermit,
    /// `Option` twice over: `None` when the memory gate is disabled, and
    /// taken by [`Self::into_resident`].
    mem: Option<OwnedSemaphorePermit>,
    admission: Arc<Admission>,
}

/// The byte reservation of a finished job whose result is still in memory
/// (#7676, SERVER-7): a response body a client has not drained yet. Holds no
/// CPU slot, because draining computes nothing, but keeps the bytes charged
/// against the budget until the body is dropped, because a slow reader keeps
/// every one of them resident for up to the write-idle timeout.
#[derive(Debug)]
pub struct ResidentBytes {
    _mem: Option<OwnedSemaphorePermit>,
}

impl AdmissionGuard {
    /// Give back every reserved byte above `bytes`.
    ///
    /// Never grows the reservation, and never drops below one permit. Not
    /// used by the upload routes: a parse's measured peak is 20-33x its
    /// upload, so no fixed multiplier makes a smaller charge safe (#7676,
    /// SERVER-24, deferred to L-server). It is for a caller whose real size is
    /// known up front, such as a cache read.
    pub fn shrink_to(&mut self, bytes: u64) {
        if let Some(mem) = self.mem.as_mut() {
            let keep = bytes.div_ceil(BYTES_PER_PERMIT).max(1) as usize;
            let held = mem.num_permits();
            if held > keep {
                drop(mem.split(held - keep));
            }
        }
    }

    /// The bytes this guard currently reserves, in whole permits (0 with the
    /// byte gate disabled). Hand it back to [`Self::resize_to`] to restore it.
    pub fn reserved(&self) -> u64 {
        self.mem.as_ref().map_or(0, |mem| mem.num_permits() as u64 * BYTES_PER_PERMIT)
    }

    /// Charge this job `bytes` from now on, whether that is more or less than
    /// it holds; returns what it held before. A cache hit on an upload route
    /// is charged the stored entry's size this way, as the GET routes are,
    /// instead of the upload's (#7676, SERVER-24).
    ///
    /// Growing waits for the extra bytes like any waiter: bounded by
    /// `queue_timeout`, counted in the queue, answered `503` on timeout, with
    /// everything already held kept meanwhile. Never drops below one permit.
    pub async fn resize_to(&mut self, bytes: u64) -> Result<u64, ApiError> {
        let before = self.reserved();
        let Some(mem) = self.mem.as_mut() else {
            return Ok(before);
        };
        let want = self.admission.permits_for(bytes) as usize;
        let held = mem.num_permits();
        if held > want {
            drop(mem.split(held - want));
        } else if held < want {
            let extra = self.admission.acquire_more((want - held) as u32).await?;
            // Same semaphore, so the permits merge into one.
            if let (Some(mem), Some(extra)) = (self.mem.as_mut(), extra) {
                mem.merge(extra);
            }
        }
        Ok(before)
    }

    /// End the job: free its CPU slot now and keep only its bytes, for as
    /// long as the returned value lives. See [`ResidentBytes`].
    pub fn into_resident(mut self) -> ResidentBytes {
        ResidentBytes { _mem: self.mem.take() }
    }
}

impl std::fmt::Debug for Admission {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Admission")
            .field("cfg", &self.cfg)
            .field("in_flight", &self.in_flight.load(Ordering::Relaxed))
            .field("queued", &self.queued.load(Ordering::Relaxed))
            .finish()
    }
}

impl Drop for AdmissionGuard {
    fn drop(&mut self) {
        self.admission.in_flight.fetch_sub(1, Ordering::Relaxed);
    }
}

impl Admission {
    pub fn new(cfg: AdmissionCfg) -> Self {
        let mem = (cfg.mem_budget_bytes > 0).then(|| {
            let permits = (cfg.mem_budget_bytes / BYTES_PER_PERMIT).max(1) as usize;
            Arc::new(Semaphore::new(permits))
        });
        Self {
            cpu: Arc::new(Semaphore::new(cfg.max_concurrent_parses.max(1))),
            mem,
            queued: AtomicUsize::new(0),
            in_flight: AtomicUsize::new(0),
            rejected_overload: AtomicU64::new(0),
            rejected_queue_full: AtomicU64::new(0),
            rejected_shed: AtomicU64::new(0),
            resident_bytes: AtomicU64::new(0),
            cfg,
        }
    }

    /// Admit one parse job that will buffer up to `reserve_bytes` of upload.
    ///
    /// Multipart rarely declares a length up front, so upload routes reserve
    /// the configured max file size, a conservative reservation that
    /// guarantees the byte bound holds. A caller that learns the real size
    /// afterwards can give the excess back ([`AdmissionGuard::shrink_to`]);
    /// the upload routes do not (see there). Cache reads reserve the stored
    /// entry's size, which the index knows up front.
    pub async fn acquire(
        self: &Arc<Self>,
        reserve_bytes: u64,
    ) -> Result<AdmissionGuard, ApiError> {
        // 1. RSS circuit breaker: shed before the kernel OOM-killer does.
        self.check_shed()?;

        // 2. CPU slot: non-blocking first - a free slot admits regardless of
        // queue configuration. Only WAITERS are subject to the bounded queue:
        // reject outright when enough requests are already waiting, otherwise
        // wait for a slot up to the queue timeout.
        let cpu = match Arc::clone(&self.cpu).try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                let _queued = self.enter_queue()?;
                match tokio::time::timeout(
                    self.cfg.queue_timeout,
                    Arc::clone(&self.cpu).acquire_owned(),
                )
                .await
                {
                    Ok(Ok(permit)) => permit,
                    _ => return Err(self.overloaded()),
                }
            }
        };

        // 4. Byte-weighted memory permits (bounded wait). A request larger
        // than the whole budget is clamped to it, so the largest allowed
        // upload can always run - alone.
        //
        // Ordering is deliberate: CPU first, THEN memory. Memory-first would
        // let up to queue_depth waiters pin budget BYTES while queueing for a
        // CPU slot - the scarcer resource held longest. CPU-first bounds the
        // number of memory waiters to max_concurrent_parses, and a CPU permit
        // held briefly while memory times out costs only that waiter's slot.
        let mem = if let Some(mem) = &self.mem {
            match tokio::time::timeout(
                self.cfg.queue_timeout,
                Arc::clone(mem).acquire_many_owned(self.permits_for(reserve_bytes)),
            )
            .await
            {
                Ok(Ok(permit)) => Some(permit),
                _ => return Err(self.overloaded()),
            }
        } else {
            None
        };

        self.in_flight.fetch_add(1, Ordering::Relaxed);
        Ok(AdmissionGuard { _cpu: cpu, mem, admission: Arc::clone(self) })
    }

    /// Admit a job that computes nothing but holds `bytes` in memory until
    /// its response is drained (#7676, SERVER-6): a cache read handing a
    /// stored entry to a client.
    ///
    /// Charged against the byte budget only. A read must not queue behind a
    /// minutes-long parse for a CPU slot it never uses (on a one-slot host
    /// every data-model fetch after a parse would wait out the queue and
    /// 503), and the bytes are what it actually costs. A waiter counts
    /// against the same bounded queue a parse does, and the RSS breaker
    /// applies. With the byte gate disabled (`IFC_MEM_BUDGET_MB=0`) nothing
    /// bounds resident bytes, for reads as for every other route.
    pub async fn acquire_resident(self: &Arc<Self>, bytes: u64) -> Result<ResidentBytes, ApiError> {
        self.check_shed()?;
        let Some(mem) = &self.mem else {
            return Ok(ResidentBytes { _mem: None });
        };
        let want = self.permits_for(bytes);
        if let Ok(permit) = Arc::clone(mem).try_acquire_many_owned(want) {
            return Ok(ResidentBytes { _mem: Some(permit) });
        }
        let _queued = self.enter_queue()?;
        match tokio::time::timeout(self.cfg.queue_timeout, Arc::clone(mem).acquire_many_owned(want)).await {
            Ok(Ok(permit)) => Ok(ResidentBytes { _mem: Some(permit) }),
            _ => Err(self.overloaded()),
        }
    }

    /// `permits` more byte permits for a job that already holds some: a
    /// try first, then a bounded, queued wait. `None` with the gate disabled.
    async fn acquire_more(self: &Arc<Self>, permits: u32) -> Result<Option<OwnedSemaphorePermit>, ApiError> {
        let Some(mem) = &self.mem else {
            return Ok(None);
        };
        if let Ok(permit) = Arc::clone(mem).try_acquire_many_owned(permits) {
            return Ok(Some(permit));
        }
        let _queued = self.enter_queue()?;
        match tokio::time::timeout(self.cfg.queue_timeout, Arc::clone(mem).acquire_many_owned(permits)).await {
            Ok(Ok(permit)) => Ok(Some(permit)),
            _ => Err(self.overloaded()),
        }
    }

    /// The RSS circuit breaker: shed before the kernel OOM-killer does.
    fn check_shed(&self) -> Result<(), ApiError> {
        if self.is_shedding() {
            self.rejected_shed.fetch_add(1, Ordering::Relaxed);
            return Err(ApiError::Overloaded {
                retry_after_secs: self.cfg.queue_timeout.as_secs().max(1) * 2,
            });
        }
        Ok(())
    }

    /// Take a place in the bounded wait queue, or refuse when it is full.
    /// The place is given back when the returned value drops.
    fn enter_queue(&self) -> Result<QueuedCount<'_>, ApiError> {
        // Reserve the queue slot atomically (CAS): a load-then-add would let
        // concurrent waiters race past the depth check.
        let mut cur = self.queued.load(Ordering::Relaxed);
        loop {
            if cur >= self.cfg.queue_depth {
                self.rejected_queue_full.fetch_add(1, Ordering::Relaxed);
                return Err(ApiError::Overloaded {
                    retry_after_secs: self.cfg.queue_timeout.as_secs().max(1),
                });
            }
            match self.queued.compare_exchange_weak(cur, cur + 1, Ordering::Relaxed, Ordering::Relaxed) {
                Ok(_) => return Ok(QueuedCount(&self.queued)),
                Err(actual) => cur = actual,
            }
        }
    }

    /// A waiter that timed out.
    fn overloaded(&self) -> ApiError {
        self.rejected_overload.fetch_add(1, Ordering::Relaxed);
        ApiError::Overloaded {
            retry_after_secs: self.cfg.queue_timeout.as_secs().max(1),
        }
    }

    /// Memory permits for `bytes`, clamped to the whole budget so the
    /// largest allowed request can always run, alone.
    fn permits_for(&self, bytes: u64) -> u32 {
        let budget_permits = (self.cfg.mem_budget_bytes / BYTES_PER_PERMIT).max(1);
        bytes.div_ceil(BYTES_PER_PERMIT).max(1).min(budget_permits) as u32
    }

    /// Current sampled resident set size in bytes (0 = unknown/not sampled).
    pub fn resident_bytes(&self) -> u64 {
        self.resident_bytes.load(Ordering::Relaxed)
    }

    /// True when the RSS breaker would currently shed new work (readiness).
    pub fn is_shedding(&self) -> bool {
        if self.cfg.mem_budget_bytes == 0 || self.cfg.shed_pct == 0 {
            return false;
        }
        let rss = self.resident_bytes.load(Ordering::Relaxed);
        rss > 0 && rss >= self.cfg.mem_budget_bytes / 100 * self.cfg.shed_pct as u64
    }

    /// Prometheus text exposition of the admission gauges/counters.
    pub fn metrics_text(&self) -> String {
        format!(
            "# TYPE ifc_server_resident_bytes gauge\n\
             ifc_server_resident_bytes {}\n\
             # TYPE ifc_server_mem_budget_bytes gauge\n\
             ifc_server_mem_budget_bytes {}\n\
             # TYPE ifc_server_admission_in_flight gauge\n\
             ifc_server_admission_in_flight {}\n\
             # TYPE ifc_server_admission_queued gauge\n\
             ifc_server_admission_queued {}\n\
             # TYPE ifc_server_admission_rejected_total counter\n\
             ifc_server_admission_rejected_total{{reason=\"overloaded\"}} {}\n\
             ifc_server_admission_rejected_total{{reason=\"queue_full\"}} {}\n\
             ifc_server_admission_rejected_total{{reason=\"rss_shed\"}} {}\n",
            self.resident_bytes.load(Ordering::Relaxed),
            self.cfg.mem_budget_bytes,
            self.in_flight.load(Ordering::Relaxed),
            self.queued.load(Ordering::Relaxed),
            self.rejected_overload.load(Ordering::Relaxed),
            self.rejected_queue_full.load(Ordering::Relaxed),
            self.rejected_shed.load(Ordering::Relaxed),
        )
    }

    /// Test/simulation hook: set the sampled RSS directly.
    pub fn set_resident_bytes(&self, bytes: u64) {
        self.resident_bytes.store(bytes, Ordering::Relaxed);
    }
}

/// Resident set size of this process in bytes, or 0 when unknown.
///
/// Linux (`/proc/self/statm`) covers every production target (Docker,
/// Railway, the three release binaries). Other platforms return 0, which
/// leaves the RSS breaker inert on dev machines - the admission semaphores
/// still bound memory there. Kept behind this helper so the source can be
/// swapped (e.g. for jemalloc stats) without touching call sites; the
/// allocator swap itself was deliberately skipped because the release matrix
/// includes a musl target where jemalloc is a known build risk.
pub fn resident_bytes_now() -> u64 {
    #[cfg(target_os = "linux")]
    {
        if let Ok(statm) = std::fs::read_to_string("/proc/self/statm") {
            // Field 1 (0-based) is resident pages.
            if let Some(pages) = statm
                .split_whitespace()
                .nth(1)
                .and_then(|v| v.parse::<u64>().ok())
            {
                // Page size is 4096 on every target we ship; sysconf would need libc.
                return pages * 4096;
            }
        }
        0
    }
    #[cfg(not(target_os = "linux"))]
    {
        0
    }
}

/// Background sampler: refreshes the shared RSS gauge every 500 ms so the
/// admission breaker reads a cheap atomic, never the filesystem, per request.
pub fn spawn_rss_sampler(admission: Arc<Admission>) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_millis(500));
        loop {
            tick.tick().await;
            admission.set_resident_bytes(resident_bytes_now());
        }
    });
}

// The unit tests live in the ratchet-exempt sibling file `admission_tests.rs`
// (kept out of this module to stay under the module-size budget). `#[path]`
// points at the sibling while it remains a child module, so `use super::*`
// still reaches this file's private helpers.
#[cfg(test)]
#[path = "admission_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "admission_resize_tests.rs"]
mod resize_tests;
