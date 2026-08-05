// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for `admission.rs`, split into this ratchet-exempt sibling
//! file to keep the production module under the module-size budget. As a
//! child `#[cfg(test)] mod tests` it retains `use super::*` access to the
//! parent module's private items, so the tests moved here verbatim.

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
