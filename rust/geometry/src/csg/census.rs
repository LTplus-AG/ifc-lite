// SPDX-License-Identifier: MPL-2.0
//! Scoped operation measurement alongside the unchanged global census.
//! Context propagation is explicit: capture before spawning work, then install
//! that context inside every worker closure that can invoke CSG. Unrelated work
//! installs an absent context to avoid inheriting a suspended caller's sink.
use std::{
    cell::RefCell,
    marker::PhantomData,
    sync::{Arc, Mutex},
};

/// One recorded invocation of a CSG kernel op (perf-census diagnostics).
/// `op`: 0=subtract 1=union 2=intersection
/// 3=clip. `a_tris`/`b_tris` are the operand triangle counts — the arrangement
/// cost driver — so the census measures the *real* heavy-path workload reaching
/// the kernel (analytic AABB box clips never get here).
#[derive(Clone, Copy, Debug)]
pub struct CsgOpRecord {
    pub op: u8,
    pub a_tris: u32,
    pub b_tris: u32,
}

// Global (Mutex) so it captures ops on rayon worker threads, not just the caller.
static CSG_CENSUS: std::sync::Mutex<Vec<CsgOpRecord>> = std::sync::Mutex::new(Vec::new());

/// Clear the CSG op census (call before a measured run).
pub fn reset_csg_census() {
    if let Ok(mut g) = CSG_CENSUS.lock() {
        g.clear();
    }
}

/// Drain the CSG op census (call after a measured run).
pub fn take_csg_census() -> Vec<CsgOpRecord> {
    CSG_CENSUS
        .lock()
        .map(|mut g| std::mem::take(&mut *g))
        .unwrap_or_default()
}

#[inline]
pub(super) fn record_csg_op(op: u8, a_tris: usize, b_tris: usize) {
    #[cfg(feature = "opening-perf-trace")]
    crate::opening_perf_trace::record(|c| {
        let index = usize::from(op).min(3);
        c.csg_operations[index] = c.csg_operations[index].saturating_add(1);
        c.csg_operand_triangles[index] = c.csg_operand_triangles[index]
            .saturating_add(a_tris as u64)
            .saturating_add(b_tris as u64);
    });
    let record = CsgOpRecord {
        op,
        a_tris: a_tris as u32,
        b_tris: b_tris as u32,
    };
    if let Ok(mut g) = CSG_CENSUS.lock() {
        g.push(record);
    }
    ACTIVE.with(|current| {
        // Do not hold a TLS borrow while taking the sink lock: a scope can be
        // nested on the same thread without borrowing a caller's accumulator.
        let sink = current.borrow().clone();
        if let Some(sink) = sink {
            sink.records
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .push(record);
        }
    });
}

thread_local! {
    static ACTIVE: RefCell<Option<CsgCensus>> = const { RefCell::new(None) };
}

/// An owned measurement sink. Clones share records across explicitly scoped
/// worker calls. Global reset/drain operations do not clear these records.
/// No sink lock is held while the measured operation executes.
#[derive(Clone, Default)]
pub struct CsgCensus {
    records: Arc<Mutex<Vec<CsgOpRecord>>>,
}
impl CsgCensus {
    pub fn new() -> Self {
        Self::default()
    }

    /// Drain this sink's records. Join all contributing work first when a
    /// complete measurement is required; this method does not wait for workers.
    pub fn take(&self) -> Vec<CsgOpRecord> {
        std::mem::take(
            &mut *self
                .records
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
        )
    }

    /// Install this sink for synchronous work; nested sinks restore their caller
    /// on normal return, an error value, or panic. Spawned work must explicitly
    /// install [`CsgCensusContext::capture`] on its executing thread.
    pub fn with_scope<T>(&self, work: impl FnOnce() -> T) -> T {
        CsgCensusContext {
            sink: Some(self.clone()),
        }
        .with_scope(work)
    }
}

/// The measurement context at a work boundary, including explicit absence.
/// This value is Send; its installed scope stays on the executing thread.
/// Capturing a context does not install it on newly spawned workers.
#[derive(Clone, Default)]
pub struct CsgCensusContext {
    sink: Option<CsgCensus>,
}
impl CsgCensusContext {
    pub fn capture() -> Self {
        Self {
            sink: ACTIVE.with(|current| current.borrow().clone()),
        }
    }

    /// Install the captured sink (or absence) for one synchronous worker call,
    /// then restore the previous context even if work unwinds.
    pub fn with_scope<T>(&self, work: impl FnOnce() -> T) -> T {
        let previous = ACTIVE.with(|current| current.replace(self.sink.clone()));
        let _scope = Scope {
            previous,
            _thread_bound: PhantomData,
        };
        work()
    }
}

struct Scope {
    previous: Option<CsgCensus>,
    _thread_bound: PhantomData<*const ()>,
}
impl Drop for Scope {
    fn drop(&mut self) {
        ACTIVE.with(|current| {
            current.replace(self.previous.take());
        });
    }
}
