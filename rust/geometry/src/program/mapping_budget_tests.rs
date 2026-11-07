// SPDX-License-Identifier: MPL-2.0
//! #7873 parsed source controls through the production request/reply protocol.
use super::*;
use rustc_hash::FxHashMap;

const SOURCE: &str = "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);\
    #3=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.)),$);\
    #4=IFCTRIANGULATEDFACESET(#3,$,.F.,((1,2,3)),$);\
    #5=IFCSHAPEREPRESENTATION($,'Body','Tessellation',(#4));#6=IFCREPRESENTATIONMAP(#2,#5);\
    #7=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1,1.,$);#8=IFCMAPPEDITEM(#6,#7);";

fn limited(mut program: GeometryProgram<'_>, limit: u32) -> GeometryProgram<'_> {
    let Control::Mapping(control) = &mut program.control else {
        panic!("mapping fixture")
    };
    control.set_logical_limit(limit);
    program
}

/// `program` as if this walk had already read `rep`'s Items (#9102: only repeats pay).
fn repeating(mut program: GeometryProgram<'_>, rep: u32) -> GeometryProgram<'_> {
    let Control::Mapping(control) = &mut program.control else {
        panic!("mapping fixture")
    };
    control.mark_seen(rep);
    program
}

// Share the existing budget setup with observability witnesses outside inner.
#[cfg(feature = "observability")]
impl<'a> GeometryProgram<'a> {
    pub(in crate::program) fn with_logical_limit(self, limit: u32) -> Self {
        limited(self, limit)
    }
}

fn run<'s>(
    mode: u8,
    source: &'s str,
    limit: u32,
    router: &GeometryRouter,
) -> (Result<usize>, EntityDecoder<'s>) {
    let mut decoder = EntityDecoder::new(source);
    let item = decoder.decode_by_id(8).unwrap();
    let rep = decoder.decode_by_id(5).unwrap();
    let map = decoder.decode_by_id(6).unwrap();
    let textures = FxHashMap::default();
    let result = match mode {
        0 => limited(GeometryProgram::mapped_item(&item), limit)
            .drain_parts(router, &mut decoder)
            .map(|parts| parts.iter().map(|mesh| mesh.indices.len()).sum()),
        1 => limited(
            GeometryProgram::styled_item(
                &item,
                crate::SubMeshCollection::new(),
                false,
                None,
                router.rtc_offset(),
            ),
            limit,
        )
        .drain_styled(router, &mut decoder)
        .map(|parts| {
            parts
                .sub_meshes
                .iter()
                .map(|part| part.mesh.indices.len())
                .sum()
        }),
        2 => limited(GeometryProgram::type_map(&map, &textures), limit)
            .drain_type_parts(router, &mut decoder)
            .map(|parts| parts.iter().map(|part| part.0.indices.len()).sum()),
        _ => limited(GeometryProgram::shared_mapped_source(&rep, 6), limit)
            .drain_parts(router, &mut decoder)
            .map(|_| router.mapped_shared_unique_count()),
    };
    (result, decoder)
}

#[test]
fn issue_9102_all_four_source_boundaries_admit_a_first_list_wider_than_the_default_cap() {
    // The issue's shape: one source list one member over the default cap.
    // Its first read is the file's own size, so every boundary admits it, and
    // a dangling member is a content failure rather than a budget refusal.
    let cap = crate::representation::MAX_WALK_LEVELS;
    let items = format!("#4,{}", vec!["$"; cap as usize].join(","));
    let source = SOURCE.replace("(#4)", &format!("({items})"));
    for mode in 0..4 {
        let mut router = GeometryRouter::new();
        router.enable_shared_mapped_item_cache(GeometryRouter::new_mapped_item_cache());
        let (result, _) = run(mode, &source, cap, &router);
        assert_eq!(result.unwrap(), if mode == 3 { 1 } else { 3 }, "boundary {mode}");
        assert!(router.take_unsupported_items().is_empty());
        assert_eq!(router.unsupported_scope_depth(), 0);
    }
    let source = source.replace("(#4,", "(#999999,");
    for mode in 0..3 {
        let router = GeometryRouter::new();
        let (result, _) = run(mode, &source, cap, &router);
        assert!(
            !result.unwrap_err().to_string().contains("work budget"),
            "boundary {mode}"
        );
    }
}

/// #9102 review: at every source boundary a first read is free only for items
/// the controller has not reached. Six references to one face set are one
/// fresh item and five repeats.
#[test]
fn issue_9102_every_boundary_charges_repeated_references_in_a_first_read() {
    let source = SOURCE.replace("(#4)", "(#4,#4,#4,#4,#4,#4)");
    for mode in 0..4 {
        for (limit, admitted) in [(4, false), (5, true)] {
            let mut router = GeometryRouter::new();
            router.enable_shared_mapped_item_cache(GeometryRouter::new_mapped_item_cache());
            let (result, decoder) = run(mode, &source, limit, &router);
            if admitted {
                assert_eq!(result.unwrap(), if mode == 3 { 1 } else { 18 }, "boundary {mode}");
            } else {
                assert!(result.unwrap_err().to_string().contains("work budget"), "boundary {mode}");
                assert!(decoder.get_cached(4).is_none(), "refused before resolving, boundary {mode}");
            }
        }
    }
}

#[test]
fn issue_7873_each_list_boundary_has_exact_small_threshold_and_ignored_members_pay() {
    // #9102: a first read is free at every boundary, ignored members included.
    // Mapped entries (modes 0 and 1) still pay their one attempt.
    let source = SOURCE.replace("(#4)", "(#4,$,17)");
    for mode in 0..4 {
        let mut router = GeometryRouter::new();
        router.enable_shared_mapped_item_cache(GeometryRouter::new_mapped_item_cache());
        let (result, _) = run(mode, &source, 1, &router);
        assert_eq!(result.unwrap(), if mode == 3 { 1 } else { 3 }, "boundary {mode}");
    }
    // A repeated read pays every slot, `$` and `17` too. The styled walk never
    // caches a source, so its second #8 re-reads #5's five members; the root
    // list's repeated #8 pays one more. Three attempts fit both limits; the
    // six members fit only the second.
    let source = nested("#8,#8").replace("(#4)", "(#4,$,17,$,$)");
    for (limit, indices, dropped) in [(5, 3, Some(&1)), (6, 6, None)] {
        let router = GeometryRouter::new();
        let mut decoder = EntityDecoder::new(&source);
        let item = decoder.decode_by_id(18).unwrap();
        let parts = limited(
            GeometryProgram::styled_item(
                &item,
                crate::SubMeshCollection::new(),
                false,
                None,
                router.rtc_offset(),
            ),
            limit,
        )
        .drain_styled(&router, &mut decoder)
        .unwrap();
        assert_eq!(
            parts
                .sub_meshes
                .iter()
                .map(|part| part.mesh.indices.len())
                .sum::<usize>(),
            indices
        );
        assert_eq!(router.take_unsupported_items().get("IfcMappedItem"), dropped);
    }
}

fn nested(items: &str) -> String {
    format!(
        "{}#15=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',({items}));\
        #16=IFCREPRESENTATIONMAP(#2,#15);#18=IFCMAPPEDITEM(#16,#7);",
        SOURCE
    )
}

#[test]
fn issue_7873_repeated_dag_occurrences_pay_and_prefix_never_publishes() {
    let source = nested("#8,#8,#8");
    for shared in [false, true] {
        for styled in [false, true] {
            let mut router = GeometryRouter::new();
            let cache = GeometryRouter::new_mapped_item_cache();
            if shared {
                router.enable_shared_mapped_item_cache(cache.clone());
            }
            let mut decoder = EntityDecoder::new(&source);
            let item = decoder.decode_by_id(18).unwrap();
            // Every occurrence pays an attempt, cached or not: the root and
            // three #8s are four, so a limit of 3 refuses the third #8. The
            // first source read is free (#9102); the styled repeat pays one.
            let indices = if styled {
                limited(
                    GeometryProgram::styled_item(
                        &item,
                        crate::SubMeshCollection::new(),
                        false,
                        None,
                        router.rtc_offset(),
                    ),
                    3,
                )
                .drain_styled(&router, &mut decoder)
                .unwrap()
                .sub_meshes
                .iter()
                .map(|part| part.mesh.indices.len())
                .sum::<usize>()
            } else {
                limited(GeometryProgram::mapped_item(&item), 3)
                    .drain_parts(&router, &mut decoder)
                    .unwrap()
                    .iter()
                    .map(|part| part.indices.len())
                    .sum()
            };
            // Both keep the two completed occurrences and stop the rest.
            assert_eq!(indices, 6);
            assert_eq!(
                router.take_unsupported_items().get("IfcMappedItem"),
                Some(&1)
            );
            assert!(!cache.lock().unwrap().contains_key(&16));
            // Same router, same source: a fresh invocation has fresh counters,
            // and cannot hit a previously published partial local/shared root.
            let parts = GeometryProgram::mapped_item(&item)
                .drain_parts(&router, &mut decoder)
                .unwrap();
            assert_eq!(
                parts.iter().map(|mesh| mesh.indices.len()).sum::<usize>(),
                9
            );
        }
    }
}

#[test]
fn issue_7873_attempt_meter_counts_warm_cache_hits_independently_of_members() {
    let source = nested("#8,#8,#8");
    for shared in [false, true] {
        let mut router = GeometryRouter::new();
        if shared {
            router.enable_shared_mapped_item_cache(GeometryRouter::new_mapped_item_cache());
        }
        let mut decoder = EntityDecoder::new(&source);
        let child = decoder.decode_by_id(8).unwrap();
        GeometryProgram::mapped_item(&child)
            .drain_parts(&router, &mut decoder)
            .unwrap();
        let item = decoder.decode_by_id(18).unwrap();
        // Hits read no Items, and the root's first list read is free (#9102):
        // only attempts count. Root plus the third cached child is attempt 4.
        let parts = limited(GeometryProgram::mapped_item(&item), 3)
            .drain_parts(&router, &mut decoder)
            .unwrap();
        assert_eq!(
            parts.iter().map(|mesh| mesh.indices.len()).sum::<usize>(),
            6
        );
        assert_eq!(
            router.take_unsupported_items().get("IfcMappedItem"),
            Some(&1)
        );
        let parts = limited(GeometryProgram::mapped_item(&item), 4)
            .drain_parts(&router, &mut decoder)
            .unwrap();
        assert_eq!(
            parts.iter().map(|mesh| mesh.indices.len()).sum::<usize>(),
            9
        );
        assert!(router.take_unsupported_items().is_empty());
    }
}

/// #9102 review: distinct mapped items over ONE shared source are each a full
/// expansion of it from a small record, so they must not ride the free first
/// read the wide-list fix gave Items lists. A type map listing N distinct
/// occurrences of a cached source pays N attempts.
#[test]
fn issue_9102_distinct_mapped_items_over_one_source_each_pay_an_attempt() {
    let occurrences: String = (40..46).map(|id| format!("#{id}=IFCMAPPEDITEM(#6,#7);")).collect();
    let refs = (40..46).map(|id| format!("#{id}")).collect::<Vec<_>>().join(",");
    let source = format!(
        "{SOURCE}{occurrences}#50=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',({refs}));\
        #51=IFCREPRESENTATIONMAP(#2,#50);"
    );
    let textures = FxHashMap::default();
    for (limit, indices, dropped) in [(5, 15, Some(&1)), (6, 18, None)] {
        let mut router = GeometryRouter::new();
        router.enable_shared_mapped_item_cache(GeometryRouter::new_mapped_item_cache());
        let mut decoder = EntityDecoder::new(&source);
        let map = decoder.decode_by_id(51).unwrap();
        let parts = limited(GeometryProgram::type_map(&map, &textures), limit)
            .drain_type_parts(&router, &mut decoder)
            .unwrap();
        assert_eq!(parts.iter().map(|part| part.0.indices.len()).sum::<usize>(), indices, "limit {limit}");
        assert_eq!(router.take_unsupported_items().get("IfcMappedItem"), dropped, "limit {limit}");
    }
}

#[test]
fn issue_7873_logical_zero_work_is_observable_even_with_warm_cache() {
    for mode in 0..4 {
        let mut router = GeometryRouter::new();
        router.enable_shared_mapped_item_cache(GeometryRouter::new_mapped_item_cache());
        // A mapped entry (modes 0 and 1) pays its attempt even on a warm hit,
        // so zero refuses it. Type maps and shared sources make no attempt,
        // and their first Items read is the file's own size (#9102).
        run(0, SOURCE, 1, &router).0.unwrap();
        let result = run(mode, SOURCE, 0, &router).0;
        if mode < 2 {
            assert!(result.unwrap_err().to_string().contains("work budget"), "mode {mode}");
        } else {
            assert_eq!(result.unwrap(), if mode == 3 { 1 } else { 3 }, "mode {mode}");
        }
        assert!(router.take_unsupported_items().is_empty());
    }
}

#[test]
fn issue_7873_rejected_reply_and_replayed_request_cannot_spend_an_attempt() {
    let source = nested("#8");
    let mut decoder = EntityDecoder::new(&source);
    let router = GeometryRouter::new();
    let foreign = GeometryRouter::new();
    let item = decoder.decode_by_id(18).unwrap();
    let mut program = limited(GeometryProgram::mapped_item(&item), 2);
    let request = program.request().unwrap().unwrap();
    let reply = program.execute(request, &router, &mut decoder).unwrap();
    assert!(matches!(
        program.execute(request, &router, &mut decoder),
        Err(ProgramError::AlreadyExecuted)
    ));
    let rejected = program.accept(reply, &foreign).expect_err("foreign owner");
    assert_eq!(rejected.error, ProgramError::WrongOwner);
    program
        .accept(rejected.reply, &router)
        .unwrap_or_else(|_| panic!("owner accepts"));
    let parts = program.drain_parts(&router, &mut decoder).unwrap();
    assert_eq!(
        parts.iter().map(|mesh| mesh.indices.len()).sum::<usize>(),
        3
    );
    assert!(router.take_unsupported_items().is_empty());
}

#[test]
fn issue_7873_default_nested_budget_keeps_prefix_and_stops_siblings_in_both_render_modes() {
    // #9102: the first #28 reads #25's wide list for free; the second repeats
    // it, one member over the default cap, and stops the trailing #4.
    let cap = crate::representation::MAX_WALK_LEVELS;
    let items = format!("#4,{}", vec!["$"; cap as usize].join(","));
    let source = format!(
        "{}#25=IFCSHAPEREPRESENTATION($,'Body','Tessellation',({items}));\
        #26=IFCREPRESENTATIONMAP(#2,#25);#28=IFCMAPPEDITEM(#26,#7);",
        nested("#4,#28,#28,#4")
    );
    for styled in [false, true] {
        let router = GeometryRouter::new();
        let mut decoder = EntityDecoder::new(&source);
        let root = decoder.decode_by_id(18).unwrap();
        let indices = if styled {
            GeometryProgram::styled_item(
                &root,
                crate::SubMeshCollection::new(),
                false,
                None,
                router.rtc_offset(),
            )
            .drain_styled(&router, &mut decoder)
            .unwrap()
            .sub_meshes
            .iter()
            .map(|part| part.mesh.indices.len())
            .sum::<usize>()
        } else {
            GeometryProgram::mapped_item(&root)
                .drain_parts(&router, &mut decoder)
                .unwrap()
                .iter()
                .map(|part| part.indices.len())
                .sum()
        };
        // The merged walk serves the second #28 from its source cache, which
        // reads no Items; the styled walk re-reads them and is refused.
        assert_eq!(indices, if styled { 6 } else { 12 });
        assert_eq!(
            router.take_unsupported_items().get("IfcMappedItem"),
            styled.then_some(&1)
        );
        assert_eq!(router.unsupported_scope_depth(), 0);
    }
}

#[test]
fn issue_7873_nested_content_failure_recovers_later_siblings_unlike_budget_stop() {
    let source = format!(
        "{}#25=IFCSHAPEREPRESENTATION($,'Body','Tessellation',(#999999));\
        #26=IFCREPRESENTATIONMAP(#2,#25);#28=IFCMAPPEDITEM(#26,#7);",
        nested("#4,#28,#4")
    );
    let router = GeometryRouter::new();
    let mut decoder = EntityDecoder::new(&source);
    let root = decoder.decode_by_id(18).unwrap();
    let parts = GeometryProgram::styled_item(
        &root,
        crate::SubMeshCollection::new(),
        false,
        None,
        router.rtc_offset(),
    )
    .drain_styled(&router, &mut decoder)
    .unwrap();
    assert_eq!(
        parts
            .sub_meshes
            .iter()
            .map(|part| part.mesh.indices.len())
            .sum::<usize>(),
        6
    );
    assert_eq!(
        router.take_unsupported_items().get("IfcMappedItem"),
        Some(&1)
    );
    assert_eq!(router.unsupported_scope_depth(), 0);
}

#[test]
fn issue_7873_plain_item_occurrence_recovery_counts_content_but_not_resource_stops() {
    let source = format!(
        "{SOURCE}#40=IFCEXTRUDEDAREASOLID($,$,$,0.);\
        #45=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#40,#4));\
        #46=IFCREPRESENTATIONMAP(#2,#45);#48=IFCMAPPEDITEM(#46,#7);"
    );
    let mut decoder = EntityDecoder::new(&source);
    let router = GeometryRouter::new();
    let root = decoder.decode_by_id(48).unwrap();
    let parts = GeometryProgram::styled_item(
        &root,
        crate::SubMeshCollection::new(),
        false,
        None,
        router.rtc_offset(),
    )
    .drain_styled(&router, &mut decoder)
    .unwrap();
    assert_eq!(
        parts
            .sub_meshes
            .iter()
            .map(|part| part.mesh.indices.len())
            .sum::<usize>(),
        3
    );
    assert_eq!(
        router.take_unsupported_items().get("IfcExtrudedAreaSolid"),
        Some(&1)
    );
    // Root plain content failures keep the same count-and-continue policy.
    let plain = decoder.decode_by_id(40).unwrap();
    let parts = GeometryProgram::styled_item(
        &plain,
        crate::SubMeshCollection::new(),
        false,
        None,
        router.rtc_offset(),
    )
    .drain_styled(&router, &mut decoder)
    .unwrap();
    assert!(parts.is_empty());
    assert_eq!(
        router.take_unsupported_items().get("IfcExtrudedAreaSolid"),
        Some(&1)
    );
    assert_eq!(router.unsupported_scope_depth(), 0);
    // Actual zero-work resource stops in this same mode are covered by
    // issue_7873_canonical_source_controllers_preserve_zero_work_refusal.
}

#[test]
fn issue_7873_cycle_precedes_attempt_budget_and_keeps_cached_sibling() {
    let source = nested("#18,#8");
    let router = GeometryRouter::new();
    let mut decoder = EntityDecoder::new(&source);
    let child = decoder.decode_by_id(8).unwrap();
    GeometryProgram::mapped_item(&child)
        .drain_parts(&router, &mut decoder)
        .unwrap();
    let root = decoder.decode_by_id(18).unwrap();
    let parts = limited(GeometryProgram::mapped_item(&root), 2)
        .drain_parts(&router, &mut decoder)
        .unwrap();
    assert_eq!(
        parts.iter().map(|mesh| mesh.indices.len()).sum::<usize>(),
        3
    );
    assert_eq!(
        router.take_unsupported_items().get("IfcMappedItem"),
        Some(&1)
    );
}

#[test]
fn issue_7873_source_modes_preserve_missing_and_non_list_items_policy() {
    for malformed in ["'Tessellation'", "'Tessellation',17"] {
        let source = SOURCE.replace("'Tessellation',(#4)", malformed);
        for mode in 0..4 {
            let router = GeometryRouter::new();
            let (result, _) = run(mode, &source, 1, &router);
            let empty = mode == 3 || (mode == 1 && malformed == "'Tessellation'");
            if empty {
                assert_eq!(result.unwrap(), 0);
            } else {
                assert!(!result.unwrap_err().to_string().contains("work budget"));
            }
        }
    }
}

#[test]
fn issue_7873_refused_template_rolls_back_and_placeholder_skip_avoids_child_charge() {
    use crate::resource::{ExecutionAccount, ExecutionPolicy, ResourceLimits};
    use std::sync::Arc;
    let source = format!("{SOURCE}#9=IFCMAPPEDITEM(#6,#7);");
    for accounted in [false, true] {
        let mut router = GeometryRouter::new();
        router.enable_shared_mapped_item_cache(GeometryRouter::new_mapped_item_cache());
        router.enable_output_instancing(Arc::new([(6, (2, 8))].into_iter().collect()));
        router.set_instancing_batch_local(true);
        let mut decoder = EntityDecoder::new(&source);
        let first = decoder.decode_by_id(8).unwrap();
        let next = decoder.decode_by_id(9).unwrap();
        let mut attempt = || {
            let mut program = GeometryProgram::styled_item(
                &first,
                crate::SubMeshCollection::new(),
                true,
                None,
                router.rtc_offset(),
            );
            let request = program.request().unwrap().unwrap();
            let reply = program.execute(request, &router, &mut decoder).unwrap();
            program
                .accept(reply, &router)
                .unwrap_or_else(|_| panic!("owner accepts"));
            // #7873 exact-single eligibility has claimed the template. Force
            // the later Items refusal to exercise rollback, without relying on
            // malformed (#4,$), which now intentionally materializes flat.
            // A first read is free (#9102), so the list is marked as a repeat.
            repeating(limited(program, 0), 5).drain_styled(&router, &mut decoder)
        };
        let result = if accounted {
            ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()))
                .scope(attempt)
        } else {
            attempt()
        };
        assert!(result.unwrap_err().to_string().contains("work budget"));
        // A refused first template must not turn the next into a placeholder.
        let parts = limited(
            GeometryProgram::styled_item(
                &next,
                crate::SubMeshCollection::new(),
                true,
                None,
                router.rtc_offset(),
            ),
            2,
        )
        .drain_styled(&router, &mut decoder)
        .unwrap();
        assert_eq!(
            parts
                .sub_meshes
                .iter()
                .map(|part| part.mesh.indices.len())
                .sum::<usize>(),
            3
        );
        // Populate the shared registry, then the placeholder need not read its
        // single-member child list. It still pays its one mapped attempt.
        GeometryProgram::mapped_item(&first)
            .drain_parts(&router, &mut decoder)
            .unwrap();
        let parts = limited(
            GeometryProgram::styled_item(
                &first,
                crate::SubMeshCollection::new(),
                true,
                None,
                router.rtc_offset(),
            ),
            1,
        )
        .drain_styled(&router, &mut decoder)
        .unwrap();
        assert_eq!(parts.len(), 1);
        assert!(parts.sub_meshes[0].mesh.positions.is_empty());
        assert!(parts.sub_meshes[0].mesh.instance_meta.is_some());
        assert!(router.take_unsupported_items().is_empty());
    }
}

#[test]
fn issue_7873_sticky_cancellation_outranks_logical_refusal_without_content_drop() {
    use crate::resource::{ExecutionAccount, ExecutionPolicy, ProgramStop, ResourceLimits};
    let router = GeometryRouter::new();
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    let result = account.scope(|| {
        crate::resource::stop(ProgramStop::Cancelled);
        run(1, SOURCE, 0, &router).0
    });
    assert!(matches!(
        result,
        Err(Error::ProgramStopped(ProgramStop::Cancelled))
    ));
    assert!(router.take_unsupported_items().is_empty());
    assert_eq!(router.unsupported_scope_depth(), 0);
}

#[path = "mapping_eligibility_tests.rs"]
mod eligibility_tests;

/// #7781 C2-3: logical exhaustion reports the failed nested item under its
/// parent policy, retains the completed prefix, and never publishes it.
#[test]
fn issue_7781_logical_drop_keeps_parent_attribution_and_prefix_without_cache_publication() {
    for body in [false, true] {
        let mut source = nested("#8,#8,#8");
        if !body {
            source = source.replace(
                "#15=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation'",
                "#15=IFCSHAPEREPRESENTATION($,'FootPrint',''",
            );
        }
        let mut decoder = EntityDecoder::new(&source);
        let item = decoder.decode_by_id(18).unwrap();
        let mut router = GeometryRouter::new();
        let cache = GeometryRouter::new_mapped_item_cache();
        router.enable_shared_mapped_item_cache(cache.clone());
        // Root and first #8 are the two attempts a limit of 2 admits; the
        // second #8 is refused, so only the first child survives.
        let meshes = limited(
            GeometryProgram::styled_item(
                &item,
                crate::SubMeshCollection::new(),
                false,
                None,
                (0., 0., 0.),
            ),
            2,
        )
        .drain_styled(&router, &mut decoder)
        .unwrap();
        assert_eq!(
            meshes.sub_meshes.len(),
            1,
            "only the completed first child survives"
        );
        assert_eq!(meshes.sub_meshes[0].mesh.indices.len(), 3);
        assert!(cache.lock().unwrap().is_empty());
        let drops = router.take_unsupported_items();
        assert_eq!(
            drops.get("IfcMappedItem").copied().unwrap_or(0),
            u64::from(body)
        );
        assert_eq!(drops.len(), usize::from(body));
        assert_eq!(router.unsupported_scope_depth(), 0);
    }
}

