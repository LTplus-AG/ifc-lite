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

/// RAII permit pair; drops release the slots.
#[derive(Debug)]
pub struct AdmissionGuard {
    _cpu: OwnedSemaphorePermit,
    _mem: Option<OwnedSemaphorePermit>,
    admission: Arc<Admission>,
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
    /// Multipart rarely declares a length up front, so callers reserve the
    /// configured max file size — a conservative reservation that guarantees
    /// the byte bound holds (tighter packing is a follow-up once the actual
    /// size is known post-extract).
    pub async fn acquire(
        self: &Arc<Self>,
        reserve_bytes: u64,
    ) -> Result<AdmissionGuard, ApiError> {
        // 1. RSS circuit breaker: shed before the kernel OOM-killer does.
        if self.cfg.mem_budget_bytes > 0 && self.cfg.shed_pct > 0 {
            let rss = self.resident_bytes.load(Ordering::Relaxed);
            let watermark = self.cfg.mem_budget_bytes / 100 * self.cfg.shed_pct as u64;
            if rss > 0 && rss >= watermark {
                self.rejected_shed.fetch_add(1, Ordering::Relaxed);
                return Err(ApiError::Overloaded {
                    retry_after_secs: self.cfg.queue_timeout.as_secs().max(1) * 2,
                });
            }
        }

        struct QueuedCount<'a>(&'a AtomicUsize);
        impl Drop for QueuedCount<'_> {
            fn drop(&mut self) {
                self.0.fetch_sub(1, Ordering::Relaxed);
            }
        }

        // 2. CPU slot: non-blocking first - a free slot admits regardless of
        // queue configuration. Only WAITERS are subject to the bounded queue:
        // reject outright when enough requests are already waiting, otherwise
        // wait for a slot up to the queue timeout.
        let cpu = match Arc::clone(&self.cpu).try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                // Reserve the queue slot atomically (CAS): a load-then-add
                // would let concurrent waiters race past the depth check.
                let mut cur = self.queued.load(Ordering::Relaxed);
                loop {
                    if cur >= self.cfg.queue_depth {
                        self.rejected_queue_full.fetch_add(1, Ordering::Relaxed);
                        return Err(ApiError::Overloaded {
                            retry_after_secs: self.cfg.queue_timeout.as_secs().max(1),
                        });
                    }
                    match self.queued.compare_exchange_weak(
                        cur,
                        cur + 1,
                        Ordering::Relaxed,
                        Ordering::Relaxed,
                    ) {
                        Ok(_) => break,
                        Err(actual) => cur = actual,
                    }
                }
                let _queued = QueuedCount(&self.queued);
                match tokio::time::timeout(
                    self.cfg.queue_timeout,
                    Arc::clone(&self.cpu).acquire_owned(),
                )
                .await
                {
                    Ok(Ok(permit)) => permit,
                    _ => {
                        self.rejected_overload.fetch_add(1, Ordering::Relaxed);
                        return Err(ApiError::Overloaded {
                            retry_after_secs: self.cfg.queue_timeout.as_secs().max(1),
                        });
                    }
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
            let budget_permits = (self.cfg.mem_budget_bytes / BYTES_PER_PERMIT).max(1);
            let want = reserve_bytes.div_ceil(BYTES_PER_PERMIT).max(1).min(budget_permits) as u32;
            match tokio::time::timeout(
                self.cfg.queue_timeout,
                Arc::clone(mem).acquire_many_owned(want),
            )
            .await
            {
                Ok(Ok(permit)) => Some(permit),
                _ => {
                    self.rejected_overload.fetch_add(1, Ordering::Relaxed);
                    return Err(ApiError::Overloaded {
                        retry_after_secs: self.cfg.queue_timeout.as_secs().max(1),
                    });
                }
            }
        } else {
            None
        };

        self.in_flight.fetch_add(1, Ordering::Relaxed);
        Ok(AdmissionGuard { _cpu: cpu, _mem: mem, admission: Arc::clone(self) })
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

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(max_parses: usize, budget_mb: u64, queue_depth: usize) -> AdmissionCfg {
        AdmissionCfg {
            max_concurrent_parses: max_parses,
            mem_budget_bytes: budget_mb * 1024 * 1024,
            queue_depth,
            queue_timeout: std::time::Duration::from_millis(50),
            shed_pct: 85,
        }
    }

    #[tokio::test]
    async fn admits_within_limits_and_releases_on_drop() {
        let a = Arc::new(Admission::new(cfg(1, 100, 2)));
        let g = a.acquire(10 * 1024 * 1024).await.expect("first admit");
        drop(g);
        let _g2 = a.acquire(10 * 1024 * 1024).await.expect("slot released");
    }

    #[tokio::test]
    async fn rejects_with_overloaded_when_cpu_saturated() {
        let a = Arc::new(Admission::new(cfg(1, 0, 4)));
        let _held = a.acquire(1).await.expect("first admit");
        let err = a.acquire(1).await.expect_err("second must time out");
        assert!(matches!(err, ApiError::Overloaded { .. }));
    }

    #[tokio::test]
    async fn byte_budget_bounds_total_admitted_bytes() {
        // 100 MB budget: two 40 MB jobs fit, the third must be rejected.
        let a = Arc::new(Admission::new(cfg(8, 100, 4)));
        let _g1 = a.acquire(40 * 1024 * 1024).await.expect("40MB #1");
        let _g2 = a.acquire(40 * 1024 * 1024).await.expect("40MB #2");
        let err = a.acquire(40 * 1024 * 1024).await.expect_err("over budget");
        assert!(matches!(err, ApiError::Overloaded { .. }));
    }

    #[tokio::test]
    async fn oversized_request_is_clamped_to_run_alone() {
        let a = Arc::new(Admission::new(cfg(8, 100, 4)));
        let g = a.acquire(500 * 1024 * 1024).await.expect("clamped to budget");
        // While the clamped job holds the whole budget, nothing else fits.
        let err = a.acquire(1024 * 1024).await.expect_err("budget exhausted");
        assert!(matches!(err, ApiError::Overloaded { .. }));
        drop(g);
        let _g2 = a.acquire(1024 * 1024).await.expect("budget released");
    }

    #[tokio::test]
    async fn queue_depth_rejects_immediately_when_full() {
        let a = Arc::new(Admission::new(cfg(1, 0, 0)));
        let _held = a.acquire(1).await.expect("first admit");
        // queue_depth 0: the next request is rejected without waiting.
        let start = std::time::Instant::now();
        let err = a.acquire(1).await.expect_err("queue full");
        assert!(matches!(err, ApiError::Overloaded { .. }));
        assert!(start.elapsed() < std::time::Duration::from_millis(40), "no wait");
    }

    #[tokio::test]
    async fn rss_breaker_sheds_above_watermark() {
        let a = Arc::new(Admission::new(cfg(4, 100, 4)));
        a.set_resident_bytes(90 * 1024 * 1024); // above 85% of 100 MB
        let err = a.acquire(1).await.expect_err("shed");
        assert!(matches!(err, ApiError::Overloaded { .. }));
        assert!(a.is_shedding());
        a.set_resident_bytes(10 * 1024 * 1024);
        assert!(!a.is_shedding());
        let _g = a.acquire(1).await.expect("admits again below watermark");
    }

    #[tokio::test]
    async fn metrics_text_exposes_gauges_and_counters() {
        let a = Arc::new(Admission::new(cfg(2, 100, 2)));
        a.set_resident_bytes(1234);
        let _g = a.acquire(1).await.unwrap();
        let text = a.metrics_text();
        assert!(text.contains("ifc_server_resident_bytes 1234"));
        assert!(text.contains("ifc_server_admission_in_flight 1"));
        assert!(text.contains("reason=\"rss_shed\"} 0"));
    }
}
