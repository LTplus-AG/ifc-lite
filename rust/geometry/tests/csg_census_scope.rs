// SPDX-License-Identifier: MPL-2.0
//! Scoped measurements use real clipping and retain the global census contract.
use ifc_lite_geometry::csg::{
    reset_csg_census, take_csg_census, CsgCensus, CsgCensusContext, CsgOpRecord, Plane,
};
use ifc_lite_geometry::{ClippingProcessor, Mesh};
use nalgebra::{Point3, Vector3};
use std::{
    panic::{catch_unwind, AssertUnwindSafe},
    sync::Mutex,
};

// Every test in this integration binary that drains the global census holds
// this lock. Separate test binaries do not share the process-global census.
static GLOBAL: Mutex<()> = Mutex::new(());

fn clip(triangles: usize) {
    let mut mesh = Mesh::new();
    for i in 0..triangles {
        let y = i as f64 * 3.;
        let base = mesh.positions.len() as u32 / 3;
        for p in [
            Point3::new(0., y, 0.),
            Point3::new(2., y, 0.),
            Point3::new(0., y + 2., 0.),
        ] {
            mesh.add_vertex(p, Vector3::new(0., 0., 1.));
        }
        mesh.add_triangle(base, base + 1, base + 2);
    }
    let result = ClippingProcessor::new()
        .clip_mesh(
            &mesh,
            &Plane::new(Point3::new(1., 0., 0.), Vector3::new(1., 0., 0.)),
        )
        .unwrap();
    let area = result
        .indices
        .chunks_exact(3)
        .map(|t| {
            let p = |index: u32| {
                let k = index as usize * 3;
                Vector3::new(
                    result.positions[k] as f64,
                    result.positions[k + 1] as f64,
                    result.positions[k + 2] as f64,
                )
            };
            (p(t[1]) - p(t[0])).cross(&(p(t[2]) - p(t[0]))).norm() * 0.5
        })
        .sum::<f64>();
    assert!(
        (area - triangles as f64 * 0.5).abs() < 1e-8,
        "actual plane clipping preserves the independently calculated half-unit triangle area"
    );
}
fn counts(records: Vec<CsgOpRecord>) -> Vec<u32> {
    assert!(records.iter().all(|r| r.op == 3 && r.b_tris == 0));
    records.into_iter().map(|r| r.a_tris).collect()
}
fn sorted_counts(records: Vec<CsgOpRecord>) -> Vec<u32> {
    let mut counts = counts(records);
    counts.sort_unstable();
    counts
}

#[test]
fn nested_sinks_are_disjoint_and_global_census_still_includes_all_operations() {
    let _lock = GLOBAL.lock().unwrap();
    reset_csg_census();
    let outer = CsgCensus::new();
    let inner = CsgCensus::new();
    outer.with_scope(|| {
        clip(1);
        inner.with_scope(|| clip(2));
        clip(3);
    });
    clip(4);
    assert_eq!(counts(outer.take()), [1, 3]);
    assert_eq!(counts(inner.take()), [2]);
    assert_eq!(counts(take_csg_census()), [1, 2, 3, 4]);
    assert!(outer.take().is_empty());
    assert!(take_csg_census().is_empty());
}

#[test]
fn panic_and_error_return_restore_the_enclosing_sink_without_losing_recorded_work() {
    let _lock = GLOBAL.lock().unwrap();
    reset_csg_census();
    let outer = CsgCensus::new();
    let inner = CsgCensus::new();
    outer.with_scope(|| {
        clip(1);
        let panic = catch_unwind(AssertUnwindSafe(|| {
            inner.with_scope(|| {
                clip(2);
                panic!("measured work failed");
            })
        }));
        assert!(panic.is_err());
        clip(3);
        let error: Result<(), &str> = inner.with_scope(|| {
            clip(4);
            Err("failed work")
        });
        assert_eq!(error, Err("failed work"));
        clip(5);
    });
    assert_eq!(counts(outer.take()), [1, 3, 5]);
    assert_eq!(counts(inner.take()), [2, 4]);
    assert_eq!(counts(take_csg_census()), [1, 2, 3, 4, 5]);
}

#[test]
fn explicit_absent_context_prevents_unrelated_work_from_inheriting_a_callers_sink() {
    let _lock = GLOBAL.lock().unwrap();
    reset_csg_census();
    let unrelated = CsgCensusContext::capture();
    let sink = CsgCensus::new();
    sink.with_scope(|| {
        clip(1);
        unrelated.with_scope(|| clip(2));
        clip(3);
    });
    assert_eq!(counts(sink.take()), [1, 3]);
    assert_eq!(counts(take_csg_census()), [1, 2, 3]);
}

#[test]
fn captured_context_propagates_real_clipping_through_nested_rayon_work() {
    let _lock = GLOBAL.lock().unwrap();
    reset_csg_census();
    let first = CsgCensus::new();
    let second = CsgCensus::new();
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(2)
        .build()
        .unwrap();
    first.with_scope(|| {
        let context = CsgCensusContext::capture();
        pool.install(|| {
            rayon::join(
                || {
                    context.with_scope(|| {
                        clip(1);
                        let nested = CsgCensusContext::capture();
                        rayon::join(
                            || nested.with_scope(|| clip(2)),
                            || nested.with_scope(|| clip(3)),
                        );
                    })
                },
                || {
                    second.with_scope(|| clip(4));
                    context.with_scope(|| clip(5));
                },
            )
        });
    });
    assert_eq!(sorted_counts(first.take()), [1, 2, 3, 5]);
    assert_eq!(counts(second.take()), [4]);
    assert_eq!(sorted_counts(take_csg_census()), [1, 2, 3, 4, 5]);
}

#[test]
fn captured_context_moves_between_threads_and_global_reset_does_not_clear_its_sink() {
    let _lock = GLOBAL.lock().unwrap();
    reset_csg_census();
    let sink = CsgCensus::new();
    let context = sink.with_scope(|| {
        clip(1);
        CsgCensusContext::capture()
    });
    std::thread::spawn(move || context.with_scope(|| clip(2)))
        .join()
        .unwrap();
    reset_csg_census();
    assert!(take_csg_census().is_empty());
    assert_eq!(counts(sink.take()), [1, 2]);
}
