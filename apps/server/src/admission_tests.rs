// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for `admission.rs`, split into this ratchet-exempt sibling
//! file to keep the production module under the module-size budget. As a
//! child `#[cfg(test)] mod tests` it retains `use super::*` access to the
//! parent module's private items, so the tests moved here verbatim.
//!
//! This file is the union of two independent test sweeps. The first moved
//! the original in-file tests here and added the RSS-watermark boundary
//! cases; the second pinned what those left vacuous — the `retry_after_secs`
//! each rejection path advertises, the exact watermark comparison, and the
//! per-reason rejection counters (all three reasons could previously have
//! been attributed to the same bucket with the suite still green).

use super::*;

/// Full knob set. `shed_pct` is explicit because several tests need the RSS
/// breaker disabled (`0`) to isolate the CPU/memory paths.
fn cfg_shed(max_parses: usize, budget_mb: u64, queue_depth: usize, shed_pct: u8) -> AdmissionCfg {
    AdmissionCfg {
        max_concurrent_parses: max_parses,
        mem_budget_bytes: budget_mb * 1024 * 1024,
        queue_depth,
        queue_timeout: std::time::Duration::from_millis(50),
        shed_pct,
    }
}

/// The common case: the production default `shed_pct` of 85.
fn cfg(max_parses: usize, budget_mb: u64, queue_depth: usize) -> AdmissionCfg {
    cfg_shed(max_parses, budget_mb, queue_depth, 85)
}

/// Pull one `ifc_server_admission_rejected_total{reason="…"}` sample out of the
/// Prometheus text body.
fn rejected(a: &Admission, reason: &str) -> u64 {
    let needle = format!("ifc_server_admission_rejected_total{{reason=\"{reason}\"}} ");
    let text = a.metrics_text();
    let line = text
        .lines()
        .find(|l| l.starts_with(&needle))
        .unwrap_or_else(|| panic!("no sample for reason={reason:?} in:\n{text}"));
    line[needle.len()..].trim().parse().expect("counter value")
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

/// Boundary case for the RSS breaker: the watermark check is `>=`, so
/// RSS sitting exactly ON the watermark (85% of a 100 MB budget = 85 MB)
/// must already shed, and one byte under must not. A test that only
/// probes far above/below the threshold (as `rss_breaker_sheds_above_watermark`
/// does) cannot distinguish `>=` from `>`.
#[tokio::test]
async fn rss_breaker_sheds_exactly_at_the_watermark_but_not_one_byte_under() {
    let a = Arc::new(Admission::new(cfg(4, 100, 4)));
    let watermark = 100 * 1024 * 1024 / 100 * 85; // 85 MiB, exact integer arithmetic used by admission.rs

    a.set_resident_bytes(watermark - 1);
    assert!(!a.is_shedding(), "one byte under the watermark must not shed");
    let _g = a.acquire(1).await.expect("admits one byte under the watermark");
    drop(_g);

    a.set_resident_bytes(watermark);
    assert!(a.is_shedding(), "exactly at the watermark must shed");
    let err = a.acquire(1).await.expect_err("must shed exactly at the watermark");
    assert!(matches!(err, ApiError::Overloaded { .. }));
}

/// The breaker is documented as "inert when ... the sampled RSS is 0"
/// (unsampled, e.g. before the first 500ms tick or on a non-Linux dev
/// box). Pick a budget small enough that the watermark itself computes
/// to 0 (`mem_budget_bytes / 100 * shed_pct` truncates to 0 for any
/// budget under 100 bytes) — the sharpest case, since `0 >= 0` would
/// wrongly shed every request forever if the `rss > 0` guard were
/// dropped.
#[tokio::test]
async fn rss_breaker_stays_inert_while_rss_is_unsampled_even_if_watermark_is_zero() {
    let a = Arc::new(Admission::new(AdmissionCfg {
        max_concurrent_parses: 4,
        mem_budget_bytes: 50, // watermark = 50/100*85 = 0
        queue_depth: 4,
        queue_timeout: std::time::Duration::from_millis(50),
        shed_pct: 85,
    }));
    // resident_bytes defaults to 0 (never sampled yet).
    assert!(!a.is_shedding(), "unsampled RSS (0) must never shed");
    let _g = a.acquire(1).await.expect("admits while RSS is unsampled");
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

/// Every rejection is attributed to its OWN reason. Swapping any two of these
/// increments left the whole suite green, and an operator debugging a 503 storm
/// reads exactly these three counters to tell "the box is out of memory" from
/// "the box is out of CPU" from "the queue is saturated" — three different
/// remediations.
#[tokio::test]
async fn each_rejection_reason_increments_its_own_counter() {
    // rss_shed: breaker open, nothing else touched.
    let shed = Arc::new(Admission::new(cfg_shed(4, 100, 4, 85)));
    shed.set_resident_bytes(90 * 1024 * 1024);
    shed.acquire(1).await.expect_err("breaker sheds");
    assert_eq!(rejected(&shed, "rss_shed"), 1);
    assert_eq!(rejected(&shed, "queue_full"), 0);
    assert_eq!(rejected(&shed, "overloaded"), 0);

    // queue_full: CPU busy and no queue slot ⇒ immediate reject.
    let full = Arc::new(Admission::new(cfg_shed(1, 0, 0, 0)));
    let _held = full.acquire(1).await.expect("takes the only slot");
    full.acquire(1).await.expect_err("queue full");
    assert_eq!(rejected(&full, "queue_full"), 1);
    assert_eq!(rejected(&full, "rss_shed"), 0);
    assert_eq!(rejected(&full, "overloaded"), 0);

    // overloaded: a queue slot exists, so the request WAITS and then times out.
    let slow = Arc::new(Admission::new(cfg_shed(1, 0, 4, 0)));
    let _held = slow.acquire(1).await.expect("takes the only slot");
    slow.acquire(1).await.expect_err("waits then times out");
    assert_eq!(rejected(&slow, "overloaded"), 1);
    assert_eq!(rejected(&slow, "rss_shed"), 0);
    assert_eq!(rejected(&slow, "queue_full"), 0);
}

/// The memory-budget timeout is its own path (CPU permit acquired, memory
/// permits unavailable) and must be counted as `overloaded`.
#[tokio::test]
async fn memory_budget_timeout_counts_as_overloaded() {
    let a = Arc::new(Admission::new(cfg_shed(8, 100, 4, 0)));
    let _g1 = a.acquire(40 * 1024 * 1024).await.expect("40MB #1");
    let _g2 = a.acquire(40 * 1024 * 1024).await.expect("40MB #2");
    a.acquire(40 * 1024 * 1024).await.expect_err("over budget");
    assert_eq!(rejected(&a, "overloaded"), 1);
    assert_eq!(rejected(&a, "queue_full"), 0);
    assert_eq!(rejected(&a, "rss_shed"), 0);
}

/// `Retry-After` is DOUBLED on the RSS-breaker path and single on every other
/// path. That is the whole point of the breaker: RSS does not fall the instant
/// a slot frees, so a client that retries after the plain queue timeout just
/// bounces off a still-open breaker. Halving the shed value survived the suite
/// because no test read the number.
#[tokio::test]
async fn shed_advertises_double_the_retry_after_of_the_other_paths() {
    // queue_timeout 50 ms ⇒ `.as_secs()` is 0 ⇒ `.max(1)` ⇒ 1 s baseline.
    let queue_full = Arc::new(Admission::new(cfg_shed(1, 0, 0, 0)));
    let _held = queue_full.acquire(1).await.expect("takes the slot");
    let ApiError::Overloaded { retry_after_secs: queue_secs } =
        queue_full.acquire(1).await.expect_err("queue full")
    else {
        panic!("expected Overloaded");
    };
    assert_eq!(queue_secs, 1, "queue rejection advertises the bare timeout");

    let shedding = Arc::new(Admission::new(cfg_shed(4, 100, 4, 85)));
    shedding.set_resident_bytes(90 * 1024 * 1024);
    let ApiError::Overloaded { retry_after_secs: shed_secs } =
        shedding.acquire(1).await.expect_err("breaker sheds")
    else {
        panic!("expected Overloaded");
    };
    assert_eq!(shed_secs, 2, "the RSS breaker backs clients off twice as long");
    assert_eq!(shed_secs, queue_secs * 2);
}

/// The retry hint scales with the configured timeout rather than being a
/// hard-coded constant, and never advertises `0` (a client would hot-loop).
#[tokio::test]
async fn retry_after_tracks_the_configured_timeout_and_is_never_zero() {
    let mut c = cfg_shed(1, 0, 0, 0);
    c.queue_timeout = std::time::Duration::from_secs(7);
    let a = Arc::new(Admission::new(c));
    let _held = a.acquire(1).await.expect("takes the slot");
    let ApiError::Overloaded { retry_after_secs } = a.acquire(1).await.expect_err("queue full")
    else {
        panic!("expected Overloaded");
    };
    assert_eq!(retry_after_secs, 7);

    let mut z = cfg_shed(1, 0, 0, 0);
    z.queue_timeout = std::time::Duration::ZERO;
    let a = Arc::new(Admission::new(z));
    let _held = a.acquire(1).await.expect("takes the slot");
    let ApiError::Overloaded { retry_after_secs } = a.acquire(1).await.expect_err("queue full")
    else {
        panic!("expected Overloaded");
    };
    assert_eq!(retry_after_secs, 1, "a sub-second timeout still backs the client off 1s");
}

/// The RSS watermark comparison is `>=`, and it is exercised AT the exact
/// boundary in both directions — the existing test sits 5 MB clear of it, so
/// relaxing `>=` to `>` changed nothing observable.
///
/// `watermark = mem_budget_bytes / 100 * shed_pct`; with a 100 MiB budget and
/// 85% that is exactly `1_048_576 * 85 = 89_128_960` bytes (the integer
/// division is exact here, so the boundary is not an artifact of rounding).
#[tokio::test]
async fn rss_breaker_fires_exactly_at_the_watermark() {
    const BUDGET: u64 = 100 * 1024 * 1024;
    let watermark = BUDGET / 100 * 85;
    assert_eq!(watermark, 89_128_960, "boundary arithmetic is exact");

    let a = Arc::new(Admission::new(cfg_shed(4, 100, 4, 85)));

    // One byte below: admits, and readiness says not shedding.
    a.set_resident_bytes(watermark - 1);
    assert!(!a.is_shedding(), "below the watermark the instance stays ready");
    let g = a.acquire(1).await.expect("admits one byte below the watermark");
    drop(g);

    // Exactly at the watermark: sheds. This is the case `>` would miss.
    a.set_resident_bytes(watermark);
    assert!(a.is_shedding(), "AT the watermark the breaker is open");
    a.acquire(1).await.expect_err("sheds at exactly the watermark");
    assert_eq!(rejected(&a, "rss_shed"), 1);

    // One byte above: still sheds.
    a.set_resident_bytes(watermark + 1);
    assert!(a.is_shedding());
    a.acquire(1).await.expect_err("sheds above the watermark");
}

/// The breaker is inert when either input is 0 — an unsampled RSS (`0`, e.g.
/// every non-Linux target), a disabled memory budget, or `shed_pct = 0`. Any of
/// those turning the breaker ON would make the readiness probe report 503
/// forever on a dev machine and drain a healthy instance in production.
#[tokio::test]
async fn breaker_is_inert_when_rss_budget_or_pct_is_zero() {
    // RSS never sampled.
    let unsampled = Arc::new(Admission::new(cfg_shed(4, 100, 4, 85)));
    assert_eq!(unsampled.resident_bytes(), 0);
    assert!(!unsampled.is_shedding());
    unsampled.acquire(1).await.expect("an unsampled RSS must not shed");

    // Memory gate disabled entirely.
    let no_budget = Arc::new(Admission::new(cfg_shed(4, 0, 4, 85)));
    no_budget.set_resident_bytes(u64::MAX);
    assert!(!no_budget.is_shedding());
    no_budget.acquire(1).await.expect("no budget ⇒ no breaker");

    // Breaker explicitly disabled.
    let no_pct = Arc::new(Admission::new(cfg_shed(4, 100, 4, 0)));
    no_pct.set_resident_bytes(u64::MAX);
    assert!(!no_pct.is_shedding());
    no_pct.acquire(1).await.expect("shed_pct 0 ⇒ no breaker");
}

/// `set_resident_bytes` / `resident_bytes` round-trip, and the gauge is what
/// `metrics_text` publishes. Without this the sampler could write to a field
/// nothing reads.
#[tokio::test]
async fn resident_gauge_round_trips_into_the_metrics_body() {
    let a = Arc::new(Admission::new(cfg_shed(2, 100, 2, 85)));
    a.set_resident_bytes(4_096);
    assert_eq!(a.resident_bytes(), 4_096);
    assert!(a.metrics_text().contains("ifc_server_resident_bytes 4096"));
    // The budget gauge reports bytes, not MB.
    assert!(a
        .metrics_text()
        .contains(&format!("ifc_server_mem_budget_bytes {}", 100 * 1024 * 1024)));
}

/// `in_flight` rises on admit and falls on drop (the `AdmissionGuard::drop`
/// impl), and `queued` is back to 0 once a rejected waiter has given up — a
/// leaked queue slot would permanently shrink the effective queue depth.
#[tokio::test]
async fn in_flight_and_queued_gauges_return_to_zero() {
    let a = Arc::new(Admission::new(cfg_shed(1, 0, 2, 0)));
    let g = a.acquire(1).await.expect("admit");
    assert!(a.metrics_text().contains("ifc_server_admission_in_flight 1"));
    // A second request queues, times out, and must not leak its queue slot.
    a.acquire(1).await.expect_err("times out waiting");
    assert!(a.metrics_text().contains("ifc_server_admission_queued 0"));
    drop(g);
    assert!(a.metrics_text().contains("ifc_server_admission_in_flight 0"));
}

/// A `0`-byte reservation still consumes a permit (`.max(1)`), so a flood of
/// zero-length uploads cannot slip past the byte budget unbounded.
#[tokio::test]
async fn a_zero_byte_reservation_still_costs_one_permit() {
    // 1 MB budget ⇒ exactly one permit.
    let a = Arc::new(Admission::new(cfg_shed(8, 1, 4, 0)));
    let _g = a.acquire(0).await.expect("first zero-byte admit");
    a.acquire(0).await.expect_err("the single permit is taken");
}
