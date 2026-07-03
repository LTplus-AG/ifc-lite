// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Memory-budget policy: the readers and the resolver that decide the
//! admission byte budget at startup.
//!
//! The byte-weighted admission semaphore (see [`crate::admission`]) is the
//! load-bearing bound against OOM from concurrent large uploads, but it only
//! engages when the budget is non-zero. Previously the budget was derived from
//! the cgroup limit alone, so a bare VM / non-containerized deployment (no
//! readable cgroup ceiling) resolved to `0` and silently degraded to a bare
//! CPU-concurrency count - the exact failure the admission work set out to
//! fix. This module adds a physical-RAM fallback so the memory gate stays
//! active without a cgroup, and keeps the three ceilings + the 70% math in one
//! place the resolver tests exercise.
//!
//! No `sysinfo`/libc dependency: the readers parse `/proc` directly, matching
//! [`crate::admission::resident_bytes_now`]; the release matrix includes a musl
//! target where a heavy cross-platform crate is a known build risk.

/// Fraction of the tightest readable memory ceiling to admit, leaving headroom
/// for the allocator, the OS page cache, and non-parse allocations.
const BUDGET_PCT_OF_CEILING: u64 = 70;

/// Container memory limit from cgroups (v2 then v1), if readable.
///
/// `None` when unlimited or unreadable (non-Linux, or a bare host outside a
/// cgroup). Moved here from `admission` so all memory-ceiling readers live
/// beside the resolver.
pub fn cgroup_memory_limit_bytes() -> Option<u64> {
    for path in [
        "/sys/fs/cgroup/memory.max",
        "/sys/fs/cgroup/memory/memory.limit_in_bytes",
    ] {
        if let Ok(raw) = std::fs::read_to_string(path) {
            let raw = raw.trim();
            if raw == "max" {
                return None;
            }
            if let Ok(v) = raw.parse::<u64>() {
                // cgroup v1 reports a huge sentinel when unlimited.
                if v > 0 && v < (1 << 60) {
                    return Some(v);
                }
            }
        }
    }
    None
}

/// Total physical RAM in bytes from `/proc/meminfo` `MemTotal`, if readable.
///
/// `None` on non-Linux and on any parse failure (never panics). This is the
/// fallback ceiling when no cgroup limit is set, so a bare Linux VM still gets
/// a bounded memory gate instead of an unbounded one.
pub fn total_physical_memory_bytes() -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        let meminfo = std::fs::read_to_string("/proc/meminfo").ok()?;
        // `MemTotal:      16305200 kB`
        let kb = meminfo
            .lines()
            .find_map(|line| line.strip_prefix("MemTotal:"))?
            .split_whitespace()
            .next()?
            .parse::<u64>()
            .ok()?;
        Some(kb * 1024)
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

/// Resolve the admission memory budget (MB) from the three inputs, in one place
/// the tests exercise so it can never silently regress to 0-when-a-ceiling-is-
/// readable.
///
/// Precedence:
/// 1. An explicit `IFC_MEM_BUDGET_MB` wins outright. `Some(0)` is honored as a
///    deliberate opt-out (memory gate off) - it is NOT treated as "unset".
/// 2. Otherwise, 70% of the tightest readable ceiling: `min(cgroup, physical)`.
///    Using the tighter of the two keeps a small cgroup from being overridden
///    by a large host, and lets physical RAM bound a bare VM with no cgroup.
/// 3. Otherwise `0` (gate off) - only when neither ceiling is readable
///    (non-Linux dev, or `/proc` unavailable), which the caller logs loudly.
pub fn resolve_mem_budget_mb(
    explicit_mb: Option<usize>,
    cgroup_bytes: Option<u64>,
    physical_bytes: Option<u64>,
) -> usize {
    if let Some(mb) = explicit_mb {
        return mb;
    }
    match [cgroup_bytes, physical_bytes].into_iter().flatten().min() {
        Some(ceiling) => (ceiling / (1024 * 1024) * BUDGET_PCT_OF_CEILING / 100) as usize,
        None => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GB: u64 = 1024 * 1024 * 1024;

    #[test]
    fn explicit_budget_wins_over_ceilings() {
        assert_eq!(
            resolve_mem_budget_mb(Some(4096), Some(10 * GB), Some(32 * GB)),
            4096
        );
    }

    #[test]
    fn explicit_zero_is_honored_as_opt_out() {
        // Some(0) is a deliberate "turn the gate off", not "unset" - it must
        // NOT fall through to a ceiling-derived budget.
        assert_eq!(resolve_mem_budget_mb(Some(0), Some(10 * GB), Some(32 * GB)), 0);
    }

    #[test]
    fn uses_tightest_readable_ceiling() {
        // 70% of the tighter (cgroup) ceiling, not the host.
        assert_eq!(
            resolve_mem_budget_mb(None, Some(10 * GB), Some(32 * GB)),
            10 * 1024 * 70 / 100,
        );
    }

    #[test]
    fn physical_ram_bounds_a_bare_vm_with_no_cgroup() {
        // The load-bearing fix: no cgroup, but readable physical RAM -> a
        // NON-ZERO budget, so the memory gate stays active on a bare VM.
        let mb = resolve_mem_budget_mb(None, None, Some(16 * GB));
        assert_eq!(mb, 16 * 1024 * 70 / 100);
        assert!(mb > 0);
    }

    #[test]
    fn no_readable_ceiling_disables_the_gate() {
        assert_eq!(resolve_mem_budget_mb(None, None, None), 0);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn physical_memory_is_readable_on_linux() {
        // On any Linux host (incl. CI) /proc/meminfo yields a positive total.
        let total = total_physical_memory_bytes();
        assert!(total.is_some_and(|b| b > 0));
    }
}
