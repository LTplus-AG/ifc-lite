// SPDX-License-Identifier: MPL-2.0
//! #7781: admission is shared by merged/styled and synchronous/stepped paths.
use super::*;
#[path = "../../../tests/support/profile_walk_model.rs"]
mod model;

fn triangles(output: ProductOutput) -> usize {
    match output {
        ProductOutput::Parts(parts) => parts.iter().map(Mesh::triangle_count).sum(),
        ProductOutput::Styled(parts) => parts.sub_meshes.iter().map(|p| p.mesh.triangle_count()).sum(),
    }
}

fn run(content: &str, allowance: u32, styled: bool, stepped: bool, warm: bool) -> (usize, u64) {
    let mut decoder = EntityDecoder::new(content);
    let router = GeometryRouter::new();
    let wall = decoder.decode_by_id(100).unwrap();
    if warm { router.process_element(&wall, &mut decoder).unwrap(); }
    let mut control = if styled {
        ProductControl::styled(&wall, false, None, SourceHygiene::Watertight)
    } else {
        ProductControl::merged(&wall, SourceHygiene::Watertight)
    };
    control.allowance = allowance;
    // Product refusals belong to the request even under source suppression.
    let _suppressed = router.enter_unsupported_policy(false);
    if stepped {
        while control.stage().unwrap().is_some() {
            let reply = control.execute(&router, &mut decoder).unwrap();
            control.accept(reply, &router);
        }
    } else {
        control.run(&router, &mut decoder).unwrap();
    }
    (triangles(control.take_result().unwrap().unwrap()), router.take_unsupported_items().values().sum())
}

#[test]
fn issue_7781_cached_product_roots_pay_the_same_logical_cost() {
    let content = model::chain(1);
    for styled in [false, true] {
        for stepped in [false, true] {
            for warm in [false, true] {
                assert_eq!(run(&content, 1, styled, stepped, warm), (0, 1));
                assert_eq!(run(&content, 2, styled, stepped, warm), (12, 0));
            }
        }
    }
}

#[test]
fn issue_7781_completed_root_survives_atomic_later_root_refusal() {
    let content = model::wall("#160", &format!(
        "{}\n#160=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#140,#1000,#240));\n{}",
        model::TARGET, model::mapped(1000, "#240")));
    for styled in [false, true] {
        for stepped in [false, true] {
            for warm in [false, true] {
                // The full root list costs three; entering the mapped root
                // needs a fourth item debit. Only the first solid survives.
                assert_eq!(run(&content, 3, styled, stepped, warm), (12, 1));
                assert_eq!(run(&content, 4, styled, stepped, warm), (36, 0));
            }
        }
    }
}

#[test]
fn issue_7781_admitted_roots_reject_replaced_decoder_and_changed_configuration() {
    let content = model::chain(1);
    for change in 0..3 {
        let mut decoder = EntityDecoder::new(&content);
        let mut router = GeometryRouter::new();
        let wall = decoder.decode_by_id(100).unwrap();
        let mut control = ProductControl::merged(&wall, SourceHygiene::Watertight);
        let plan = control.admit_shape(&router, &mut decoder).unwrap();
        control.action = control.shape_done(plan);
        match change {
            0 => decoder = EntityDecoder::new(&content),
            1 => decoder.set_entity_index(std::sync::Arc::new(ifc_lite_core::build_entity_index(content.as_bytes()))),
            _ => router.set_tessellation_quality(crate::TessellationQuality::High),
        }
        control.run(&router, &mut decoder).unwrap();
        let error = control.take_result().unwrap().err().expect("foreign owner refused");
        assert!(error.to_string().contains("execution owner changed"), "{error}");
        assert!(router.take_unsupported_items().is_empty());
    }
}

#[test]
fn issue_7781_product_protocol_rejects_foreign_decoder_after_admission() {
    use crate::program::inner::ProgramError;
    let content = model::chain(1);
    let mut decoder = EntityDecoder::new(&content);
    let router = GeometryRouter::new();
    let wall = decoder.decode_by_id(100).unwrap();
    let mut program = crate::program::GeometryProgram::product(&wall, SourceHygiene::Watertight);
    let request = program.request().unwrap().unwrap();
    let reply = program.execute(request, &router, &mut decoder).unwrap();
    program.accept(reply, &router).ok().unwrap();
    let request = program.request().unwrap().unwrap();
    let mut foreign = EntityDecoder::new(&content);
    assert_eq!(program.execute(request, &router, &mut foreign).err(), Some(ProgramError::WrongOwner));
    // A refused foreign execution must leave the original ticket usable.
    let reply = program.execute(request, &router, &mut decoder).unwrap();
    program.accept(reply, &router).ok().unwrap();
}

#[test]
fn issue_7781_cancellation_precedes_product_shape_and_budget_refusal() {
    use crate::resource::{ExecutionAccount, ExecutionPolicy, ProgramStop, ResourceLimits};
    for content in [model::chain(1), model::wall("#160", "#160=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid');")] {
        for styled in [false, true] {
            for stepped in [false, true] {
                let mut decoder = EntityDecoder::new(&content);
                let router = GeometryRouter::new();
                let wall = decoder.decode_by_id(100).unwrap();
                let mut control = if styled {
                    ProductControl::styled(&wall, false, None, SourceHygiene::Watertight)
                } else { ProductControl::merged(&wall, SourceHygiene::Watertight) };
                control.allowance = 0;
                let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
                account.scope(|| {
                    account.cancel();
                    if stepped {
                        let reply = control.execute(&router, &mut decoder).unwrap();
                        control.accept(reply, &router);
                    } else { control.run(&router, &mut decoder).unwrap(); }
                    assert!(matches!(control.take_result().unwrap(),
                        Err(crate::Error::ProgramStopped(ProgramStop::Cancelled))));
                    assert!(router.take_unsupported_items().is_empty());
                });
            }
        }
    }
}

#[test]
fn issue_7781_product_allowance_spans_representations_and_repeated_dag_roots() {
    let representations = model::wall("#160,#161", &format!(
        "{}\n#160=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#140));\n\
         #161=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#1000));\n{}",
        model::TARGET, model::mapped(1000, "#240")));
    let repeated = model::wall("#160", &format!(
        "{}\n#160=IFCSHAPEREPRESENTATION(#13,'Body','MappedRepresentation',(#1000,#1000));\n{}",
        model::TARGET, model::mapped(1000, "#240")));
    for (content, limit) in [(&representations, 2), (&repeated, 3)] {
        for styled in [false, true] {
            for stepped in [false, true] {
                for warm in [false, true] {
                    assert_eq!(run(content, limit, styled, stepped, warm), (12, 1));
                    assert_eq!(run(content, limit + 1, styled, stepped, warm), (24, 0));
                }
            }
        }
    }
}

#[test]
fn issue_7781_owner_change_after_completed_root_cannot_publish_a_partial_product() {
    let content = model::wall("#160", "#160=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#140,#240));");
    for styled in [false, true] {
        let mut decoder = EntityDecoder::new(&content);
        let router = GeometryRouter::new();
        let wall = decoder.decode_by_id(100).unwrap();
        let mut control = if styled {
            ProductControl::styled(&wall, false, None, SourceHygiene::Watertight)
        } else { ProductControl::merged(&wall, SourceHygiene::Watertight) };
        // Execute the first root through the real controller before changing
        // the decoder between roots, while its output is still unpublished.
        while !matches!(&control.action, Action::Raw(item) if item.id == 240) {
            assert!(control.stage().unwrap().is_some());
            let reply = control.execute(&router, &mut decoder).unwrap();
            control.accept(reply, &router);
        }
        decoder = EntityDecoder::new(&content);
        control.run(&router, &mut decoder).unwrap();
        let error = control.take_result().unwrap().err().expect("partial product must not publish");
        assert!(error.to_string().contains("execution owner changed"), "{error}");
        assert!(router.take_unsupported_items().is_empty());
    }
}
