// SPDX-License-Identifier: MPL-2.0
//! Per-host preservation of the pre-#11321 cut until #11604.

#[path = "cases.rs"]
mod cases;

use super::{fixture_host, mesh_volume, Degenerate, EdgeLedger, Mesh, VertexKey};
use std::collections::BTreeMap;
use std::process::Command;

#[derive(Debug)]
struct Cut {
    error_litres: f64,
    // Exact unmatched, exact overused, millimetre unmatched, millimetre overused.
    edges: [usize; 4],
}

impl Cut {
    fn measure(mesh: &Mesh, expected: f64) -> Self {
        let exact = EdgeLedger::build(mesh, VertexKey::BitsZeroFolded, Degenerate::SkipTriangle);
        let mm = EdgeLedger::build(mesh, VertexKey::GridMul(1.0e3), Degenerate::SkipTriangle);
        Self {
            error_litres: (mesh_volume(mesh) - expected) * 1000.0,
            edges: [
                exact.unbalanced().count(),
                exact.multiplicity_defects().over_used,
                mm.unbalanced().count(),
                mm.multiplicity_defects().over_used,
            ],
        }
    }
}

impl Cut {
    fn baseline(fields: &[&str]) -> Self {
        assert_eq!(fields.len(), 5);
        Self {
            error_litres: fields[0].parse().unwrap(),
            edges: std::array::from_fn(|i| fields[i + 1].parse().unwrap()),
        }
    }

    fn preserves(&self, base: &Self) -> bool {
        // One microlitre of slack for floating-point volume summation.
        self.error_litres.abs() <= base.error_litres.abs() + 1e-6
            && self
                .edges
                .iter()
                .zip(base.edges)
                .all(|(now, old)| *now <= old)
    }
}

fn merge_base(route: &str) -> BTreeMap<&'static str, Cut> {
    let mut baselines = BTreeMap::new();
    for line in include_str!("merge_base.tsv")
        .lines()
        .filter(|line| !line.starts_with('#'))
    {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields[0] != route {
            continue;
        }
        assert!(matches!(fields.len(), 7 | 12));
        let start = if fields.len() == 12 && cfg!(feature = "csg_manifold_gate") {
            7
        } else {
            2
        };
        assert!(baselines
            .insert(fields[1], Cut::baseline(&fields[start..start + 5]))
            .is_none());
    }
    baselines
}

// The production switches are cached on first use. Run each route in a fresh
// process so another test, or the caller's environment, cannot select it.
fn both_routes(test: &str, check: impl FnOnce(&str)) {
    const ROUTE: &str = "IFC_LITE_TEST_TILTED_ROUTE_11423";
    if let Ok(route) = std::env::var(ROUTE) {
        assert!(matches!(route.as_str(), "default" | "exact"));
        check(&route);
        return;
    }

    let mut failures = Vec::new();
    for route in ["default", "exact"] {
        let mut cmd = Command::new(std::env::current_exe().unwrap());
        cmd.args(["--exact", test, "--include-ignored", "--nocapture"])
            .env(ROUTE, route);
        for switch in [
            "IFC_LITE_PRISM_CUT",
            "IFC_LITE_VOID_2D",
            "IFC_LITE_RECT_FAST",
        ] {
            if route == "exact" {
                cmd.env(switch, "0");
            } else {
                cmd.env_remove(switch);
            }
        }
        let output = cmd.output().unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        if !output.status.success() || !stdout.contains("1 passed; 0 failed") {
            failures.push(format!(
                "{route}\n{stdout}\n{}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn each_host_preserves_merge_base() {
    both_routes("tilted::each_host_preserves_merge_base", |route| {
        let mut base = merge_base(route);
        let mut failures = Vec::new();
        cases::each(|id, content, expected, limit, aligned| {
            let prior = base
                .remove(id.as_str())
                .expect("missing merge-base measurement");
            let (mesh, _) = fixture_host(&content, false);
            let now = Cut::measure(&mesh, expected);
            if !now.preserves(&prior)
                || (aligned
                    && (now.error_litres.abs() > limit || now.edges[0] != 0 || now.edges[2] != 0))
            {
                failures.push(format!("{id}: {now:?}, merge base {prior:?}"));
            }
        });
        assert!(
            base.is_empty(),
            "unused merge-base cases: {:?}",
            base.keys()
        );
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    });
}

/// Desired result for independently tilted cutters. Run the command in README.md
/// to see every open host or out-of-tolerance volume, including the review witness.
#[test]
#[ignore = "Independent cutter tilt is tracked by #11604"]
fn independently_tilted_authored_cut_11604() {
    both_routes("tilted::independently_tilted_authored_cut_11604", |route| {
        let mut failures = Vec::new();
        cases::each(|id, content, expected, limit, aligned| {
            if aligned {
                return;
            }
            let (mesh, _) = fixture_host(&content, false);
            let now = Cut::measure(&mesh, expected);
            if !(now.error_litres.abs() <= limit) || now.edges[0] != 0 || now.edges[2] != 0 {
                failures.push(format!(
                    "{route} {id}: {:+.6} L (allowed ±{limit}), unmatched {} exact / {} at 1 mm",
                    now.error_litres, now.edges[0], now.edges[2]
                ));
            }
        });
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    });
}
