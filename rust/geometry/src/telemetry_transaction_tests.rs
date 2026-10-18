// SPDX-License-Identifier: MPL-2.0
//! Detached route facts publish only through accepted parent transactions.
use super::{capture, record, EffectSet, Event};

#[test]
fn typed_telemetry_preserves_nested_acceptance_discard_and_unwind() {
    const CHILD: &str = "IFC_LITE_TYPED_TELEMETRY_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "telemetry_transaction::tests::typed_telemetry_preserves_nested_acceptance_discard_and_unwind", "--nocapture"])
            .env(CHILD, "1").output().unwrap();
        assert!(output.status.success(), "{}\n{}",
            String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
        return;
    }
    fn send_sync<T: Send + Sync>() {}
    send_sync::<EffectSet>();
    crate::rect_fast::take_param_fires();
    crate::router::voids::take_bool2d_stats();
    crate::router::voids::prism_cut::take_prism_stats();
    crate::router::voids::prism_cut::take_prism_defers();

    let (_, parent) = capture(|| {
        crate::rect_fast::param_record_fire();
        let (_, accepted) = capture(|| {
            crate::rect_fast::param_record_fire();
            record(Event::PlanarCut { footprints: 3 });
        });
        accepted.commit();
        let transferred = std::thread::spawn(|| {
            let (_, events) = capture(crate::rect_fast::param_record_fire);
            events
        }).join().unwrap();
        transferred.commit();
        #[cfg(any(feature = "observability", feature = "csg_capture", feature = "debug_geometry"))]
        {
            record(Event::PrismDefer { reason: 2 });
            record(Event::PrismCut { committed: 2, residual: 4 });
        }
        let (_, rejected) = capture(|| {
            crate::rect_fast::param_record_fire();
            record(Event::PlanarCut { footprints: 99 });
        });
        drop(rejected);
        let panic = match std::panic::catch_unwind(|| capture(|| {
            crate::rect_fast::param_record_fire();
            record(Event::PlanarCut { footprints: 88 });
            std::panic::panic_any(173_u32);
        })) {
            Err(panic) => panic,
            Ok(_) => panic!("the original panic must propagate"),
        };
        assert_eq!(panic.downcast_ref::<u32>(), Some(&173));
        assert_eq!(crate::rect_fast::take_param_fires(), 0);
        assert_eq!(crate::router::voids::take_bool2d_stats(), (0, 0));
    });
    assert_eq!(crate::rect_fast::take_param_fires(), 0);
    parent.commit();
    assert_eq!(crate::rect_fast::take_param_fires(), 3);
    assert_eq!(crate::router::voids::take_bool2d_stats(), (1, 3));
    #[cfg(any(feature = "observability", feature = "csg_capture", feature = "debug_geometry"))]
    {
        assert_eq!(crate::router::voids::prism_cut::take_prism_stats(), (1, 2, 4));
        let defers = crate::router::voids::prism_cut::take_prism_defers();
        assert_eq!(defers[2].1, 1);
        assert_eq!(defers.iter().map(|(_, count)| count).sum::<u64>(), 1);
    }

    // Accepted inner effects still disappear when their enclosing attempt drops.
    let (_, rejected_parent) = capture(|| {
        let (_, child) = capture(crate::rect_fast::param_record_fire);
        child.commit();
    });
    drop(rejected_parent);
    assert_eq!(crate::rect_fast::take_param_fires(), 0);
    crate::rect_fast::param_record_fire();
    assert_eq!(crate::rect_fast::take_param_fires(), 1,
        "unwinding restored the immediate-publication scope");
}
