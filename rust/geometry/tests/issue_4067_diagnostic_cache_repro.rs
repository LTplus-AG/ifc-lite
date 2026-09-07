// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #4067 behavioral reproduction: CSG diagnostic counts depend on cache
//! execution order.
//!
//! `ItemDedupCache` (the "structural boolean cache" #4067 names) stores only
//! `(Mesh, Option<u128>)` — see `rust/geometry/src/router/mod.rs`'s
//! `ItemDedupCache` alias and `router/processing.rs`'s
//! `process_representation_item` — never the `BoolFailure` diagnostics the
//! uncached (MISS) build recorded via `record_topology_tear`
//! (`csg/topology_diagnostic.rs`). A cache HIT for the same structural item
//! therefore returns byte-identical geometry while silently omitting the
//! diagnostic the first build recorded.
//!
//! `WALL_WITH_OPEN_UNION` below is a real, parsed `IfcWall` whose Body item is
//! `IFCBOOLEANRESULT(.UNION., openFacetedBrep, extrudedBox)`, where
//! `openFacetedBrep` is a unit cube missing its top face (5 of 6 faces) — a
//! deliberately malformed but syntactically valid `IfcFacetedBrep`, the same
//! shape `csg/csg_tests.rs`'s in-code `open_box_mesh` fixture uses, expressed
//! as real IFC text so it goes through the router's actual
//! `process_representation_item` / `ItemDedupCache` path rather than calling
//! `ClippingProcessor::union_meshes` directly. Its union with the overlapping
//! box leaves the 4 edges bordering the missing face unmatched, so
//! `validate_mesh` (finite + in-bounds only — no closure check) accepts the
//! result and `record_topology_tear` records a `KernelError` for it.

use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::{BoolFailureReason, GeometryRouter, ItemDedupCache};
use std::sync::Barrier;

/// `IfcWall` #10, Body item #170 = `IFCBOOLEANRESULT(.UNION., #150, #164)`:
/// - `#150` = `IfcFacetedBrep` unit cube (0,0,0)-(1,1,1) missing its top
///   (z=1) face — 5 of the box's 6 quad faces.
/// - `#164` = `IfcExtrudedAreaSolid`, a 1x1 box extruded along Z from
///   (0.5,0.5,0.5), spanning roughly (0,0,0.5)-(1,1,1.5) — overlapping the
///   open box so the union is a single connected (but torn) solid rather than
///   two disjoint pieces.
const WALL_WITH_OPEN_UNION: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('4067 open-topology union'),'2;1');
FILE_NAME('g.ifc','2026-09-07T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6f',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCWALL('1OpenTopologyUnionWall1',$,'Wall',$,$,#11,#12,$,$);
#11=IFCLOCALPLACEMENT($,#5);
#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));
#13=IFCSHAPEREPRESENTATION(#2,'Body','CSG',(#170));
#100=IFCCARTESIANPOINT((0.,0.,0.));
#101=IFCCARTESIANPOINT((1.,0.,0.));
#102=IFCCARTESIANPOINT((1.,1.,0.));
#103=IFCCARTESIANPOINT((0.,1.,0.));
#104=IFCCARTESIANPOINT((0.,0.,1.));
#105=IFCCARTESIANPOINT((1.,0.,1.));
#106=IFCCARTESIANPOINT((1.,1.,1.));
#107=IFCCARTESIANPOINT((0.,1.,1.));
#110=IFCPOLYLOOP((#100,#103,#102,#101));
#111=IFCPOLYLOOP((#100,#101,#105,#104));
#112=IFCPOLYLOOP((#101,#102,#106,#105));
#113=IFCPOLYLOOP((#102,#103,#107,#106));
#114=IFCPOLYLOOP((#103,#100,#104,#107));
#120=IFCFACEOUTERBOUND(#110,.T.);
#121=IFCFACEOUTERBOUND(#111,.T.);
#122=IFCFACEOUTERBOUND(#112,.T.);
#123=IFCFACEOUTERBOUND(#113,.T.);
#124=IFCFACEOUTERBOUND(#114,.T.);
#130=IFCFACE((#120));
#131=IFCFACE((#121));
#132=IFCFACE((#122));
#133=IFCFACE((#123));
#134=IFCFACE((#124));
#140=IFCCLOSEDSHELL((#130,#131,#132,#133,#134));
#150=IFCFACETEDBREP(#140);
#161=IFCCARTESIANPOINT((0.5,0.5,0.5));
#160=IFCAXIS2PLACEMENT3D(#161,$,$);
#162=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,1.0,1.0);
#163=IFCDIRECTION((0.,0.,1.));
#164=IFCEXTRUDEDAREASOLID(#162,#160,#163,1.0);
#170=IFCBOOLEANRESULT(.UNION.,#150,#164);
ENDSEC;
END-ISO-10303-21;
"#;

fn wall_entity(decoder: &mut EntityDecoder) -> ifc_lite_core::DecodedEntity {
    decoder.decode_by_id(10).expect("decode #10 IfcWall")
}

fn fresh_decoder(content: &'static str) -> EntityDecoder<'static> {
    let index = ifc_lite_core::build_entity_index(content.as_bytes());
    EntityDecoder::with_index(content.as_bytes(), index)
}

/// Did this router record (and keep) its own open-topology-tear diagnostic —
/// as opposed to which of the three mutually-exclusive reasons
/// `union.rs::audit_and_gate_union` classified it as. `KernelError` is the
/// ungated #3440-step-1 record (recorded only when neither gate rejects);
/// `csg_manifold_gate` and `csg_topology_gate` each independently decide
/// whether to reject instead and, if so, record `NonManifoldRejected` /
/// `OpenTopologyRejected` in its place (`accept_gates_reject` in
/// `csg/topology_diagnostic.rs` uses `|`, not `||`, so a mesh that trips both
/// gates records both). WALL_WITH_OPEN_UNION's tear falls through to
/// `KernelError` under the default build and `csg_manifold_gate` alone, but
/// trips the stricter edge-multiplicity check under `csg_topology_gate` and
/// is recorded as `OpenTopologyRejected` instead — same tear, different
/// bucket depending on which gate feature is compiled in. A filter that only
/// recognised `KernelError` would read the topology-gate builds as "not
/// recorded" even though the diagnostic fired; see 25ae873fa's identical fix
/// to `issue_4083_diagnostic_dedup_test.rs::kernel_error_count` for the first
/// occurrence of this exact test defect. Returns `1` if at least one
/// qualifying record survived, else `0` (a raw count is not meaningful here:
/// under a combined-gate build one tear can legitimately record twice).
fn kernel_error_count(router: &GeometryRouter) -> usize {
    let recorded = router.take_csg_failures().values().flatten().any(|f| {
        matches!(
            f.reason,
            BoolFailureReason::KernelError(_)
                | BoolFailureReason::OpenTopologyRejected
                | BoolFailureReason::NonManifoldRejected { .. }
        )
    });
    usize::from(recorded)
}

fn mesh_signature(mesh: &ifc_lite_geometry::Mesh) -> (usize, usize, u64) {
    let bits_sum: u64 = mesh
        .positions
        .iter()
        .map(|f| f.to_bits() as u64)
        .fold(0u64, |a, b| a.wrapping_add(b));
    (mesh.positions.len(), mesh.indices.len(), bits_sum)
}

/// Sanity control: with NO cache at all, the union really does record its
/// tear diagnostic — otherwise every assertion below would trivially pass for
/// the wrong reason (the geometry never tearing in the first place). Which of
/// the three reasons it lands in depends on the gate feature set (see
/// `kernel_error_count`'s doc); this only asserts that one of them fired.
#[test]
fn open_union_records_kernel_error_uncached() {
    let mut decoder = fresh_decoder(WALL_WITH_OPEN_UNION);
    let router = GeometryRouter::with_units(WALL_WITH_OPEN_UNION.as_bytes(), &mut decoder);
    let entity = wall_entity(&mut decoder);
    let mesh = router
        .process_element(&entity, &mut decoder)
        .expect("mesh the open-union wall");
    assert!(!mesh.positions.is_empty(), "union must produce geometry, not an empty mesh");
    let count = kernel_error_count(&router);
    assert_eq!(
        count, 1,
        "expected exactly one tear diagnostic (open-topology accept, under whichever reason \
         the active gate features classify it as) from the uncached union; if this is 0 the \
         fixture no longer tears and the repro below is vacuous"
    );
}

/// #4067's core mechanism: two structurally-identical builds of the SAME
/// item, one sharing `ItemDedupCache` with the other. The first (MISS)
/// records `KernelError`; the second (HIT) returns the byte-identical mesh
/// but the shared cache carries no diagnostic payload, so `take_csg_failures`
/// on the second router is empty. Independent (unshared) caches do NOT show
/// this: both builds MISS and BOTH record — proving the omission is caused
/// specifically by cache SHARING, not by processing the wall twice.
// #4083: this reproduces the STILL-OPEN determinism half of #4067 — it fails
// against current code by design (see the module doc above) and is not a
// regression this branch introduces or fixes. `#[ignore]`d so `cargo test
// --workspace` (the default CI "Rust tests" job) stays green; run it
// explicitly with `cargo test -p ifc-lite-geometry -- --ignored` to see the
// live reproduction. Remove the attribute once #4083 lands a real fix.
#[test]
#[ignore = "known-bug reproduction for #4083 (open determinism half of #4067); fails by design until #4083 is fixed"]
fn cache_hit_omits_the_kernel_error_the_cache_miss_recorded() {
    // Control: two INDEPENDENT (unshared) caches — both MISS, both record.
    {
        let mut decoder_a = fresh_decoder(WALL_WITH_OPEN_UNION);
        let router_a = GeometryRouter::with_units(WALL_WITH_OPEN_UNION.as_bytes(), &mut decoder_a);
        let entity_a = wall_entity(&mut decoder_a);
        let _ = router_a
            .process_element(&entity_a, &mut decoder_a)
            .expect("mesh independent build A");
        let count_a = kernel_error_count(&router_a);

        let mut decoder_b = fresh_decoder(WALL_WITH_OPEN_UNION);
        let router_b = GeometryRouter::with_units(WALL_WITH_OPEN_UNION.as_bytes(), &mut decoder_b);
        let entity_b = wall_entity(&mut decoder_b);
        let _ = router_b
            .process_element(&entity_b, &mut decoder_b)
            .expect("mesh independent build B");
        let count_b = kernel_error_count(&router_b);

        assert_eq!(
            (count_a, count_b),
            (1, 1),
            "control: two independently-cached builds of the same item must each record \
             their own KernelError (no sharing, no omission)"
        );
    }

    // WARM: a router with a SHARED cache, first to process the item -> MISS -> records.
    let shared: ItemDedupCache = GeometryRouter::new_dedup_cache();

    let mut warm_decoder = fresh_decoder(WALL_WITH_OPEN_UNION);
    let mut warm_router = GeometryRouter::with_units(WALL_WITH_OPEN_UNION.as_bytes(), &mut warm_decoder);
    warm_router.enable_content_dedup_shared(shared.clone());
    let warm_entity = wall_entity(&mut warm_decoder);
    let warm_mesh = warm_router
        .process_element(&warm_entity, &mut warm_decoder)
        .expect("mesh warm (cache-populating) build");
    let warm_count = kernel_error_count(&warm_router);
    assert_eq!(warm_count, 1, "warm (cache MISS) build must record the KernelError");

    // HIT: a second, fresh router sharing the SAME cache. Same structural
    // item -> same dedup key -> served from the WARM build's cache entry.
    let mut hit_decoder = fresh_decoder(WALL_WITH_OPEN_UNION);
    let mut hit_router = GeometryRouter::with_units(WALL_WITH_OPEN_UNION.as_bytes(), &mut hit_decoder);
    hit_router.enable_content_dedup_shared(shared.clone());
    let hit_entity = wall_entity(&mut hit_decoder);
    let hit_mesh = hit_router
        .process_element(&hit_entity, &mut hit_decoder)
        .expect("mesh hit (cache-served) build");
    let hit_count = kernel_error_count(&hit_router);

    assert_eq!(
        mesh_signature(&hit_mesh),
        mesh_signature(&warm_mesh),
        "the cache-served mesh must be byte-identical to the build that populated the cache \
         (a divergence here would be a correctness bug, not #4067)"
    );

    // THE BUG, asserted as the CORRECT invariant so this fails RED on today's
    // code: a diagnostic that describes a real, structurally-present
    // open-topology result must not depend on whether this particular caller
    // happened to hit or miss an unrelated mesh cache. `warm_count` (1) is
    // ground truth — the item genuinely tears — so `hit_count` must match it,
    // not silently report zero.
    assert_eq!(
        hit_count, warm_count,
        "#4067: a shared-cache HIT returned the byte-identical open-topology mesh the warm \
         build (count={warm_count}) flagged, but recorded {hit_count} KernelError diagnostics \
         — the cache omits the diagnostic payload on a hit"
    );
}

/// #4067's second mechanism: "concurrent misses may compute outside the
/// mutex and each record the same diagnostic." A `Barrier` forces both
/// threads to reach `process_element` at the same instant (no elapsed-time
/// assertion — the race is on ordering, not on wall-clock duration): with an
/// empty shared cache, both threads' cache lookups can miss before either has
/// inserted, so BOTH independently run the union and BOTH record
/// `KernelError` for what is, logically, one operation on one structural
/// item. Run several iterations and report the observed split honestly
/// (scheduling races are not guaranteed to reproduce on every run).
// #4083: see the #[ignore] note on `cache_hit_omits_the_kernel_error_the_cache_miss_recorded`
// above — same reproduction contract, same reason.
#[test]
#[ignore = "known-bug reproduction for #4083 (open determinism half of #4067); fails by design until #4083 is fixed"]
fn barrier_controlled_concurrent_miss_does_not_double_count() {
    const ITERATIONS: usize = 25;
    let mut double_counted = 0usize;
    let mut single_counted = 0usize;
    let mut other = 0usize;

    for _ in 0..ITERATIONS {
        let shared: ItemDedupCache = GeometryRouter::new_dedup_cache();
        let barrier = Barrier::new(2);
        let total = std::thread::scope(|scope| {
            let counts: Vec<usize> = [(); 2]
                .map(|_| {
                    let shared = shared.clone();
                    let barrier = &barrier;
                    scope.spawn(move || {
                        let mut decoder = fresh_decoder(WALL_WITH_OPEN_UNION);
                        let mut router =
                            GeometryRouter::with_units(WALL_WITH_OPEN_UNION.as_bytes(), &mut decoder);
                        router.enable_content_dedup_shared(shared);
                        let entity = wall_entity(&mut decoder);
                        barrier.wait();
                        let _ = router
                            .process_element(&entity, &mut decoder)
                            .expect("mesh concurrent build");
                        kernel_error_count(&router)
                    })
                })
                .into_iter()
                .map(|h| h.join().expect("thread panicked"))
                .collect();
            counts.iter().sum::<usize>()
        });
        match total {
            2 => double_counted += 1,
            1 => single_counted += 1,
            n => {
                other += 1;
                eprintln!("issue-4067 repro: unexpected total KernelError count {n} this iteration");
            }
        }
    }

    eprintln!(
        "issue-4067 concurrent-miss repro over {ITERATIONS} iterations: \
         double-counted={double_counted} single-counted={single_counted} other={other}"
    );
    // THE BUG, asserted as the CORRECT invariant so this fails RED on today's
    // code: one logical union of one structural item must be counted once,
    // regardless of how many threads raced to compute it. `single_counted`
    // must equal `ITERATIONS`.
    assert_eq!(
        single_counted, ITERATIONS,
        "#4067: {double_counted}/{ITERATIONS} barrier-synchronized concurrent-miss iterations \
         double-counted a single logical union (both racing threads missed the empty shared \
         cache and each independently recorded its own KernelError) — \
         single_counted={single_counted} other={other}"
    );
}
