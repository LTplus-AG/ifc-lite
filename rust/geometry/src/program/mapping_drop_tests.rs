// SPDX-License-Identifier: MPL-2.0
//! #7781 C2-3: real controller failures retain attribution, order and stops.
use crate::program::GeometryProgram;
use crate::{Error, GeometryProcessor, GeometryRouter, Mesh, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use std::{cell::Cell, rc::Rc};

const SOURCE: &str = "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);\
    #3=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1,1.,$);\
    #10=IFCBLOCK(#2,1.,2.,3.);#11=IFCBLOCK(#2,4.,5.,6.);\
    #20=IFCMAPPEDITEM($,#3);\
    #30=IFCSHAPEREPRESENTATION($,'Body','CSG',(#10,#1,#20,#11));\
    #31=IFCREPRESENTATIONMAP(#2,#30);#32=IFCMAPPEDITEM(#31,#3);";

#[test]
fn issue_7781_drop_trace_preserves_siblings_parent_truncation_and_policy() {
    for styled in [false, true] {
        for body in [true, false] {
            let source = SOURCE.replace("'CSG'", if body { "'CSG'" } else { "'FootPrint'" });
            let mut decoder = EntityDecoder::new(&source);
            let item = decoder.decode_by_id(32).unwrap();
            let mut router = GeometryRouter::new();
            let cache = GeometryRouter::new_mapped_item_cache();
            router.enable_shared_mapped_item_cache(cache.clone());
            let indices = if styled {
                GeometryProgram::styled_item(
                    &item,
                    crate::SubMeshCollection::new(),
                    false,
                    None,
                    (0., 0., 0.),
                )
                .drain_styled(&router, &mut decoder)
                .unwrap()
                .sub_meshes
                .iter()
                .map(|part| part.mesh.indices.len())
                .sum::<usize>()
            } else {
                GeometryProgram::mapped_item(&item)
                    .drain_parts(&router, &mut decoder)
                    .unwrap()
                    .iter()
                    .map(|part| part.indices.len())
                    .sum::<usize>()
            };
            assert_eq!(indices, 72, "both real block siblings survive");
            assert!(
                cache.lock().unwrap().is_empty(),
                "a parent missing its nested map is never shared"
            );
            let drops = router.take_unsupported_items();
            if body {
                assert_eq!(drops.len(), 2);
                assert_eq!(drops.get("IfcCartesianPoint"), Some(&1));
                assert_eq!(drops.get("IfcMappedItem"), Some(&1));
            } else {
                assert!(drops.is_empty());
            }
            assert_eq!(router.unsupported_scope_depth(), 0);
        }
    }
}

#[cfg(not(feature = "observability"))]
#[test]
fn issue_7781_drop_diagnostics_keep_item_before_nested_failure_even_when_suppressed() {
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "program::mapping::drop::tests::issue_7781_drop_trace_preserves_siblings_parent_truncation_and_policy", "--nocapture"])
        .output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let stderr = String::from_utf8(output.stderr).unwrap();
    let lines: Vec<_> = stderr
        .lines()
        .filter(|line| line.starts_with("[ifc-lite] Skipping"))
        .collect();
    assert_eq!(
        lines.len(),
        if cfg!(debug_assertions) { 8 } else { 0 },
        "{stderr}"
    );
    for (index, pair) in lines.chunks_exact(2).enumerate() {
        let walk = if index < 2 {
            "mapped-source"
        } else {
            "styled-source"
        };
        let reason = if index < 2 {
            "no processor"
        } else {
            "Unsupported representation type: IfcCartesianPoint"
        };
        assert_eq!(pair[0], format!("[ifc-lite] Skipping unsupported {walk} item #1 (IfcCartesianPoint): Geometry processing error: {reason}"));
        assert_eq!(pair[1], "[ifc-lite] Skipping nested IfcMappedItem #20: Geometry processing error: Failed to resolve MappingSource");
    }
}

struct StopBlock(Rc<Cell<usize>>);
impl GeometryProcessor for StopBlock {
    fn process(
        &self,
        _: &DecodedEntity,
        _: &mut EntityDecoder,
        _: &IfcSchema,
        _: TessellationQuality,
    ) -> Result<Mesh> {
        self.0.set(self.0.get() + 1);
        Err(Error::ProgramStopped(
            crate::resource::ProgramStop::Cancelled,
        ))
    }
    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcBlock]
    }
}

#[test]
fn issue_7781_nested_terminal_stop_never_becomes_a_drop_or_runs_a_sibling() {
    let source = SOURCE
        .replace(
            "#20=IFCMAPPEDITEM($,#3);",
            "#20=IFCMAPPEDITEM(#41,#3);\
        #40=IFCSHAPEREPRESENTATION($,'Body','CSG',(#10));#41=IFCREPRESENTATIONMAP(#2,#40);",
        )
        .replace("(#10,#1,#20,#11)", "(#20,#11)");
    for styled in [false, true] {
        let mut decoder = EntityDecoder::new(&source);
        let item = decoder.decode_by_id(32).unwrap();
        let calls = Rc::new(Cell::new(0));
        let mut router = GeometryRouter::new();
        router.register(Box::new(StopBlock(calls.clone())));
        let result = if styled {
            GeometryProgram::styled_item(
                &item,
                crate::SubMeshCollection::new(),
                false,
                None,
                (0., 0., 0.),
            )
            .drain_styled(&router, &mut decoder)
            .map(|_| ())
        } else {
            GeometryProgram::mapped_item(&item)
                .drain_parts(&router, &mut decoder)
                .map(|_| ())
        };
        assert!(matches!(
            result,
            Err(Error::ProgramStopped(
                crate::resource::ProgramStop::Cancelled
            ))
        ));
        assert_eq!(
            calls.get(),
            1,
            "stop terminates both the nested and parent walk"
        );
        assert!(router.take_unsupported_items().is_empty());
        assert_eq!(router.unsupported_scope_depth(), 0);
    }
}

#[cfg(feature = "observability")]
mod diagnostics {
    use super::*;
    use std::{
        cell::RefCell,
        collections::BTreeMap,
        rc::Weak,
        sync::{Arc, Mutex},
    };
    use tracing::{span, Event, Metadata, Subscriber};
    // The router is thread-confined; a weak TLS reference lets the subscriber
    // observe it synchronously without unsafe pointers or retaining test state.
    thread_local! {
        static OBSERVED_ROUTER: RefCell<Weak<GeometryRouter>> = const { RefCell::new(Weak::new()) };
    }
    type Events = Vec<(
        String,
        BTreeMap<String, String>,
        tracing::Level,
        Option<usize>,
    )>;
    #[derive(Clone, Default)]
    struct Capture(Arc<Mutex<Events>>);
    #[derive(Default)]
    struct Fields(BTreeMap<String, String>);
    impl tracing::field::Visit for Fields {
        fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
            self.0.insert(field.name().to_owned(), value.to_owned());
        }
        fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
            self.0.insert(field.name().to_owned(), format!("{value:?}"));
        }
    }
    impl Subscriber for Capture {
        fn enabled(&self, _: &Metadata<'_>) -> bool {
            true
        }
        fn new_span(&self, _: &span::Attributes<'_>) -> span::Id {
            span::Id::from_u64(1)
        }
        fn record(&self, _: &span::Id, _: &span::Record<'_>) {}
        fn record_follows_from(&self, _: &span::Id, _: &span::Id) {}
        fn enter(&self, _: &span::Id) {}
        fn exit(&self, _: &span::Id) {}
        fn event(&self, event: &Event<'_>) {
            let mut fields = Fields::default();
            event.record(&mut fields);
            if fields.0.contains_key("error") {
                let depth = OBSERVED_ROUTER.with_borrow(|router| {
                    router
                        .upgrade()
                        .map(|router| router.unsupported_scope_depth())
                });
                self.0.lock().unwrap().push((
                    event.metadata().target().to_owned(),
                    fields.0,
                    *event.metadata().level(),
                    depth,
                ));
            }
        }
    }

    #[test]
    fn issue_7781_structured_drop_events_preserve_targets_fields_and_order() {
        let capture = Capture::default();
        tracing::subscriber::with_default(capture.clone(), || {
            issue_7781_drop_trace_preserves_siblings_parent_truncation_and_policy();
        });
        let events = capture.0.lock().unwrap();
        assert_eq!(events.len(), 8);
        for (index, pair) in events[..8].chunks_exact(2).enumerate() {
            for (target, _, level, _) in pair {
                assert_eq!(target, "ifc_lite_geometry::program::mapping::reduce");
                assert_eq!(*level, tracing::Level::DEBUG);
            }
            let item = &pair[0].1;
            assert_eq!(item["item_id"], "1");
            assert_eq!(item["ifc_type"], "IfcCartesianPoint");
            assert_eq!(
                item["walk"],
                if index < 2 {
                    "mapped-source"
                } else {
                    "styled-source"
                }
            );
            assert_eq!(item["message"], "skipping unsupported source item");
            let nested = &pair[1].1;
            assert_eq!(nested["item_id"], "20");
            assert_eq!(
                nested["error"],
                "Geometry processing error: Failed to resolve MappingSource"
            );
            assert_eq!(nested["message"], "skipping nested IfcMappedItem");
        }
    }

    /// #7781 / PR #8253: select the logical-stop diagnostic through the real
    /// controller, and observe restoration DURING emission, not after drain.
    #[test]
    fn issue_7781_logical_stop_event_restores_outer_policy_before_emission() {
        for body in [false, true] {
            for outer_depth in [0, 1] {
                let source = SOURCE
                    .replace(
                        "#20=IFCMAPPEDITEM($,#3);",
                        "#20=IFCMAPPEDITEM(#41,#3);\
                        #40=IFCSHAPEREPRESENTATION($,'Body','CSG',(#10));\
                        #41=IFCREPRESENTATIONMAP(#2,#40);",
                    )
                    .replace("(#10,#1,#20,#11)", "(#20,#20,#20)")
                    .replace(
                        "#30=IFCSHAPEREPRESENTATION($,'Body','CSG'",
                        if body {
                            "#30=IFCSHAPEREPRESENTATION($,'Body','CSG'"
                        } else {
                            "#30=IFCSHAPEREPRESENTATION($,'FootPrint',''"
                        },
                    );
                let mut decoder = EntityDecoder::new(&source);
                let item = decoder.decode_by_id(32).unwrap();
                let mut router = GeometryRouter::new();
                let cache = GeometryRouter::new_mapped_item_cache();
                router.enable_shared_mapped_item_cache(cache.clone());
                let router = Rc::new(router);
                OBSERVED_ROUTER.set(Rc::downgrade(&router));
                let outer = (outer_depth == 1).then(|| router.enter_unsupported_policy(false));
                let program = GeometryProgram::styled_item(
                    &item,
                    crate::SubMeshCollection::new(),
                    false,
                    None,
                    (0., 0., 0.),
                )
                // Root Items costs three; the first child's one-item source
                // fits, then the second occurrence exhausts the logical budget.
                .with_logical_limit(4);
                let capture = Capture::default();
                let meshes = tracing::subscriber::with_default(capture.clone(), || {
                    program.drain_styled(&router, &mut decoder).unwrap()
                });
                assert_eq!(meshes.sub_meshes.len(), 1, "completed prefix survives");
                assert_eq!(meshes.sub_meshes[0].mesh.indices.len(), 36);
                assert!(cache.lock().unwrap().is_empty(), "no partial publication");
                let drops = router.take_unsupported_items();
                assert_eq!(drops.len(), usize::from(body));
                assert_eq!(
                    drops.get("IfcMappedItem").copied().unwrap_or(0),
                    u64::from(body)
                );
                assert_eq!(router.unsupported_scope_depth(), outer_depth);
                assert_eq!(
                    *capture.0.lock().unwrap(),
                    vec![(
                        "ifc_lite_geometry::program::mapping::stop".to_owned(),
                        BTreeMap::from([
                            ("item_id".to_owned(), "20".to_owned()),
                            (
                                "message".to_owned(),
                                "skipping nested IfcMappedItem".to_owned()
                            ),
                            (
                                "error".to_owned(),
                                "Geometry processing error: Representation expansion exceeded the work budget of 4 levels or item references at #20".to_owned()
                            ),
                        ]),
                        tracing::Level::DEBUG,
                        Some(outer_depth),
                    )],
                    "logical stop must close its reporting scope before emission (body={body})",
                );
                drop(outer);
                assert_eq!(router.unsupported_scope_depth(), 0);
            }
        }
    }
}
