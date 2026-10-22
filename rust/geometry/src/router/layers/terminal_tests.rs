// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7887: a completed stage's content result cannot hide a newly sticky stop.
//! These exercise the actual handoff gates after parsed stage execution, not
//! scheduling-dependent cancellation inside a public call or an entry pre-cancel.
use super::{buildup, LayerProgram, WALL};
use crate::resource::{Cost, ExecutionAccount, ExecutionPolicy, ProgramStop, ResourceLimits};
use crate::{GeometryRouter, Result};
use ifc_lite_core::EntityDecoder;
use rustc_hash::FxHashMap;

fn account() -> ExecutionAccount {
    ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()))
}

fn exhaust(account: &ExecutionAccount) -> ProgramStop {
    account.prepare(Cost { work: 1, ..Cost::default() }).unwrap();
    let work = account.usage().work;
    let stop = account.prepare(Cost { work: u64::MAX, ..Cost::default() }).unwrap_err();
    assert_eq!(account.usage().work, work, "refused work is not committed");
    assert_eq!(account.check(), Err(stop));
    stop
}

fn assert_stop<T>(result: Result<T>, stop: ProgramStop) {
    assert!(matches!(result, Err(crate::Error::ProgramStopped(actual)) if actual == stop));
}

#[test]
fn issue_7887_post_eligibility_stop_beats_real_skip_and_success() {
    for multiple in [false, true] {
        let content = if multiple { WALL.replace("(#6)", "(#6,#6)") } else { WALL.into() };
        for stopped in [false, true] {
            let mut decoder = EntityDecoder::new(&content);
            let element = decoder.decode_by_id(9).unwrap();
            let router = GeometryRouter::new();
            let account = account();
            account.scope(|| {
                crate::resource::check_current().unwrap();
                let outcome = LayerProgram::admit(&element, &mut decoder, &buildup(), 1.);
                assert_eq!(outcome.is_err(), multiple);
                // The stage genuinely ran before the stop; both its successful
                // output and its ordinary content skip must now be withheld.
                if stopped {
                    let stop = exhaust(&account);
                    assert_stop(router.accept_layer_stage(9, outcome), stop);
                    assert!(router.take_layer_slice_diag().is_empty());
                } else {
                    let accepted = router.accept_layer_stage(9, outcome).unwrap();
                    assert_eq!(accepted.is_none(), multiple);
                    let expected = if multiple { vec![(9, "skip:not-single-unshifted-item")] } else { vec![] };
                    assert_eq!(router.take_layer_slice_diag(), expected);
                }
            });
        }
    }
}

#[test]
fn issue_7887_post_host_and_frame_stops_beat_real_stage_results() {
    for boundary in ["empty-host", "frame", "planes"] {
        for stopped in [false, true] {
            let content = if boundary == "empty-host" {
                WALL.replace(
                    "#4=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,4.,0.3);",
                    "#4=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#11);\n#11=IFCPOLYLINE(());",
                )
            } else { WALL.into() };
            let mut decoder = EntityDecoder::new(&content);
            let element = decoder.decode_by_id(9).unwrap();
            let router = GeometryRouter::new();
            let account = account();
            account.scope(|| {
                let program = LayerProgram::admit(&element, &mut decoder, &buildup(), 1.)
                    .ok().flatten().unwrap();
                let host = router.process_element_with_voids(&element, &mut decoder, &FxHashMap::default()).unwrap();
                let request = program.accept_host(host);
                if boundary == "empty-host" {
                    assert!(request.is_err());
                    if stopped {
                        let stop = exhaust(&account);
                        assert_stop(router.accept_layer_stage(9, request), stop);
                    } else {
                        assert!(router.accept_layer_stage(9, request).unwrap().is_none());
                    }
                } else {
                    let frame = request.ok().unwrap().admit_frame(&element, &mut decoder, &router);
                    assert!(frame.is_ok());
                    if boundary == "frame" {
                        if stopped {
                            let stop = exhaust(&account);
                            assert_stop(router.accept_layer_stage(9, frame), stop);
                        } else {
                            assert!(router.accept_layer_stage(9, frame).unwrap().is_some());
                        }
                    } else {
                        let planes = frame.ok().unwrap().execute();
                        assert!(planes.is_ok());
                        if stopped {
                            let stop = exhaust(&account);
                            assert_stop(router.accept_layer_stage(9, planes), stop);
                        } else {
                            assert!(router.accept_layer_stage(9, planes).unwrap().is_some());
                        }
                    }
                }
                let expected = if boundary == "empty-host" && !stopped {
                    vec![(9, "skip:empty-base-mesh")]
                } else { vec![] };
                assert_eq!(router.take_layer_slice_diag(), expected);
            });
        }
    }
}

#[test]
fn issue_7887_post_slice_stop_prevents_publication_and_material_output() {
    for stopped in [false, true] {
        let mut decoder = EntityDecoder::new(WALL);
        let element = decoder.decode_by_id(9).unwrap();
        let router = GeometryRouter::new();
        let account = account();
        account.scope(|| {
            let program = LayerProgram::admit(&element, &mut decoder, &buildup(), 1.)
                .ok().flatten().unwrap();
            let host = router.process_element_with_voids(&element, &mut decoder, &FxHashMap::default()).unwrap();
            let reply = program.accept_host(host).ok().unwrap()
                .admit_frame(&element, &mut decoder, &router).ok().unwrap()
                .execute().ok().unwrap().execute();
            assert!(router.take_layer_slice_diag().is_empty());
            if stopped {
                let stop = exhaust(&account);
                assert_stop(reply.publish(&router, 9), stop);
                assert!(router.take_layer_slice_diag().is_empty());
            } else {
                let collection = reply.publish(&router, 9).unwrap();
                assert_eq!(collection.sub_meshes.len(), 2);
                assert!(collection.ids_are_materials);
                assert_eq!(router.take_layer_slice_diag(), [(9, "ok:sliced")]);
            }
        });
    }
}

#[test]
fn issue_7887_wrapper_stop_beats_completed_success_abstention_and_ordinary_error() {
    for kind in ["success", "none", "error"] {
        for stopped in [false, true] {
            // All outcomes come from the public gateway and parsed IFC. A
            // missing Items list is an ordinary shape error, not a typed stop.
            let content = match kind {
                "none" => WALL.replace("(#6)", "(#6,#6)"),
                "error" => WALL.replace("'SweptSolid',(#6)", "'SweptSolid'"),
                _ => WALL.into(),
            };
            let mut decoder = EntityDecoder::new(&content);
            let element = decoder.decode_by_id(9).unwrap();
            let router = GeometryRouter::new();
            let account = account();
            account.scope(|| {
                let outcome = router.process_element_with_material_layers(
                    &element, &mut decoder, &buildup(), &FxHashMap::default(),
                );
                match &outcome {
                    Ok(Some(collection)) => { assert_eq!(kind, "success"); assert_eq!(collection.sub_meshes.len(), 2); }
                    Ok(None) => assert_eq!(kind, "none"),
                    Err(crate::Error::ProgramStopped(_)) => panic!("fixture must produce ordinary content outcome"),
                    Err(_) => assert_eq!(kind, "error"),
                }
                // Already-published gateway diagnostics precede this boundary;
                // the wrapper must add no fallback diagnostic after the stop.
                router.take_layer_slice_diag();
                if stopped {
                    let stop = exhaust(&account);
                    assert_stop(router.finish_layer_attempt(9, outcome), stop);
                    assert!(router.take_layer_slice_diag().is_empty());
                } else {
                    let collection = router.finish_layer_attempt(9, outcome).unwrap();
                    assert_eq!(collection.is_some(), kind == "success");
                    let expected = if kind == "error" { vec![(9, "skip:base-mesh-error")] } else { vec![] };
                    assert_eq!(router.take_layer_slice_diag(), expected);
                }
            });
        }
    }
}

#[test]
fn issue_7887_layer_public_gateways_propagate_reached_work_refusal() {
    let content = format!("{WALL}
#100=IFCMATERIAL('outer',$,$);
#101=IFCMATERIAL('inner',$,$);
#110=IFCMATERIALLAYER(#100,0.15,$,$,$,$,$);
#111=IFCMATERIALLAYER(#101,0.15,$,$,$,$,$);
#120=IFCMATERIALLAYERSET((#110,#111),$,$);
#121=IFCMATERIALLAYERSETUSAGE(#120,.AXIS2.,.POSITIVE.,-0.15,$);
#130=IFCRELASSOCIATESMATERIAL('layers',$,$,$,(#9),#121);");
    for gateway in ["layers", "submeshes", "voids"] {
        for bounded in [false, true] {
            let mut decoder = EntityDecoder::new(&content);
            let element = decoder.decode_by_id(9).unwrap();
            let index = crate::MaterialLayerIndex::from_content(&content, &mut decoder);
            let layers = index.get(9).unwrap().clone();
            assert!(layers.is_sliceable());
            let mut router = GeometryRouter::new();
            router.set_material_layer_index(std::sync::Arc::new(index));
            let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits {
                work: if bounded { Some(0) } else { None },
                ..ResourceLimits::default()
            }));
            account.scope(|| {
                // Zero work is not an entry stop: the request must reach an
                // actual debit inside production before becoming terminal.
                crate::resource::check_current().unwrap();
                let outcome = match gateway {
                    "layers" => router.process_element_with_material_layers(
                        &element, &mut decoder, &layers, &FxHashMap::default(),
                    ),
                    "submeshes" => router.process_element_with_submeshes(&element, &mut decoder).map(Some),
                    _ => router.process_element_with_submeshes_and_voids(
                        &element, &mut decoder, &FxHashMap::default(),
                    ).map(Some),
                };
                if bounded {
                    let stop = account.check().expect_err("production must reach its actual work guard");
                    assert_stop(outcome, stop);
                    assert!(router.take_layer_slice_diag().is_empty());
                    assert_eq!(account.usage().work, 0);
                } else {
                    let collection = outcome.unwrap().unwrap();
                    assert_eq!(collection.sub_meshes.len(), 2);
                    assert!(collection.ids_are_materials);
                    assert_eq!(router.take_layer_slice_diag(), [(9, "ok:sliced")]);
                }
            });
        }
    }
}
