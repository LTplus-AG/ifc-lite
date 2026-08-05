// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Second test module for `admission`: the parts the in-file `tests` module
//! left vacuous.
//!
//! The in-file tests assert only `matches!(err, ApiError::Overloaded { .. })`,
//! so the `retry_after_secs` each rejection path advertises was unpinned; they
//! also never touch the exact RSS watermark, so `>=` could be relaxed to `>`
//! with the suite green; and they never read a rejection counter, so all three
//! reasons could be attributed to the same bucket.

use super::*;

fn cfg(max_parses: usize, budget_mb: u64, queue_depth: usize, shed_pct: u8) -> AdmissionCfg {
    AdmissionCfg {
        max_concurrent_parses: max_parses,
        mem_budget_bytes: budget_mb * 1024 * 1024,
        queue_depth,
        queue_timeout: std::time::Duration::from_millis(50),
        shed_pct,
    }
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

/// Every rejection is attributed to its OWN reason. Swapping any two of these
/// increments left the whole suite green, and an operator debugging a 503 storm
/// reads exactly these three counters to tell "the box is out of memory" from
/// "the box is out of CPU" from "the queue is saturated" — three different
/// remediations.
#[tokio::test]
async fn each_rejection_reason_increments_its_own_counter() {
    // rss_shed: breaker open, nothing else touched.
    let shed = Arc::new(Admission::new(cfg(4, 100, 4, 85)));
    shed.set_resident_bytes(90 * 1024 * 1024);
    shed.acquire(1).await.expect_err("breaker sheds");
    assert_eq!(rejected(&shed, "rss_shed"), 1);
    assert_eq!(rejected(&shed, "queue_full"), 0);
    assert_eq!(rejected(&shed, "overloaded"), 0);

    // queue_full: CPU busy and no queue slot ⇒ immediate reject.
    let full = Arc::new(Admission::new(cfg(1, 0, 0, 0)));
    let _held = full.acquire(1).await.expect("takes the only slot");
    full.acquire(1).await.expect_err("queue full");
    assert_eq!(rejected(&full, "queue_full"), 1);
    assert_eq!(rejected(&full, "rss_shed"), 0);
    assert_eq!(rejected(&full, "overloaded"), 0);

    // overloaded: a queue slot exists, so the request WAITS and then times out.
    let slow = Arc::new(Admission::new(cfg(1, 0, 4, 0)));
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
    let a = Arc::new(Admission::new(cfg(8, 100, 4, 0)));
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
    let queue_full = Arc::new(Admission::new(cfg(1, 0, 0, 0)));
    let _held = queue_full.acquire(1).await.expect("takes the slot");
    let ApiError::Overloaded { retry_after_secs: queue_secs } =
        queue_full.acquire(1).await.expect_err("queue full")
    else {
        panic!("expected Overloaded");
    };
    assert_eq!(queue_secs, 1, "queue rejection advertises the bare timeout");

    let shedding = Arc::new(Admission::new(cfg(4, 100, 4, 85)));
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
    let mut c = cfg(1, 0, 0, 0);
    c.queue_timeout = std::time::Duration::from_secs(7);
    let a = Arc::new(Admission::new(c));
    let _held = a.acquire(1).await.expect("takes the slot");
    let ApiError::Overloaded { retry_after_secs } = a.acquire(1).await.expect_err("queue full")
    else {
        panic!("expected Overloaded");
    };
    assert_eq!(retry_after_secs, 7);

    let mut z = cfg(1, 0, 0, 0);
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

    let a = Arc::new(Admission::new(cfg(4, 100, 4, 85)));

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
    let unsampled = Arc::new(Admission::new(cfg(4, 100, 4, 85)));
    assert_eq!(unsampled.resident_bytes(), 0);
    assert!(!unsampled.is_shedding());
    unsampled.acquire(1).await.expect("an unsampled RSS must not shed");

    // Memory gate disabled entirely.
    let no_budget = Arc::new(Admission::new(cfg(4, 0, 4, 85)));
    no_budget.set_resident_bytes(u64::MAX);
    assert!(!no_budget.is_shedding());
    no_budget.acquire(1).await.expect("no budget ⇒ no breaker");

    // Breaker explicitly disabled.
    let no_pct = Arc::new(Admission::new(cfg(4, 100, 4, 0)));
    no_pct.set_resident_bytes(u64::MAX);
    assert!(!no_pct.is_shedding());
    no_pct.acquire(1).await.expect("shed_pct 0 ⇒ no breaker");
}

/// `set_resident_bytes` / `resident_bytes` round-trip, and the gauge is what
/// `metrics_text` publishes. Without this the sampler could write to a field
/// nothing reads.
#[tokio::test]
async fn resident_gauge_round_trips_into_the_metrics_body() {
    let a = Arc::new(Admission::new(cfg(2, 100, 2, 85)));
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
    let a = Arc::new(Admission::new(cfg(1, 0, 2, 0)));
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
    let a = Arc::new(Admission::new(cfg(8, 1, 4, 0)));
    let _g = a.acquire(0).await.expect("first zero-byte admit");
    a.acquire(0).await.expect_err("the single permit is taken");
}
