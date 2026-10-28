// SPDX-License-Identifier: MPL-2.0
//! #7781/#7887: actual controller replies cannot hide a newly sticky stop.
use super::*;
use crate::material_layer_index::{LayerAxis, LayerInfo};
use crate::resource::{Cost, ExecutionAccount, ExecutionPolicy, ProgramStop, ResourceLimits};
use rustc_hash::FxHashMap;

const WALL: &str = "#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCAXIS2PLACEMENT3D(#1,$,$);
#3=IFCLOCALPLACEMENT($,#2);
#4=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,4.,0.3);
#5=IFCDIRECTION((0.,0.,1.));
#6=IFCEXTRUDEDAREASOLID(#4,#2,#5,3.);
#7=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#6));
#8=IFCPRODUCTDEFINITIONSHAPE($,$,(#7));
#9=IFCWALL('wall',$,$,$,$,#3,#8,$,$);";

fn buildup() -> LayerBuildup {
    LayerBuildup::Sliceable {
        layers: vec![
            LayerInfo {
                material_id: 100,
                thickness: 0.15,
            },
            LayerInfo {
                material_id: 101,
                thickness: 0.15,
            },
        ],
        axis: LayerAxis::Axis2,
        direction_sense: 1.,
        offset_from_reference_line: -0.15,
    }
}

fn account() -> ExecutionAccount {
    ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()))
}

fn exhaust(account: &ExecutionAccount) -> ProgramStop {
    account
        .prepare(Cost {
            work: 1,
            ..Cost::default()
        })
        .unwrap();
    let work = account.usage().work;
    let stop = account
        .prepare(Cost {
            work: u64::MAX,
            ..Cost::default()
        })
        .unwrap_err();
    assert_eq!(account.usage().work, work, "refused work is not committed");
    assert_eq!(account.check(), Err(stop));
    stop
}

fn assert_stop<T>(result: Result<T>, stop: ProgramStop) {
    assert!(matches!(result, Err(crate::Error::ProgramStopped(actual)) if actual == stop));
}

#[test]
fn issue_7887_stops_between_execution_and_acceptance_override_layer_outcomes() {
    for variant in ["success", "multiple", "empty", "error"] {
        let content = match variant {
            "multiple" => WALL.replace("(#6)", "(#6,#6)"),
            "empty" => WALL.replace(
                "#4=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,4.,0.3);",
                "#4=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#11);#11=IFCPOLYLINE(());",
            ),
            "error" => WALL.replace(
                "#3=IFCLOCALPLACEMENT($,#2);",
                "#3=IFCLOCALPLACEMENT(#3,#2);",
            ),
            _ => WALL.into(),
        };
        for boundary in ["eligibility", "host", "frame", "planes", "slice", "clean"] {
            for stopped in [false, true] {
                let mut decoder = EntityDecoder::new(&content);
                let element = decoder.decode_by_id(9).unwrap();
                let router = GeometryRouter::new();
                let buildup = buildup();
                let account = account();
                account.scope(|| {
                    let mut control = LayerControl::buildup(&element, &buildup, &[]);
                    // Index mode also exercises the fallback and cleanup gates.
                    let mut reached = false;
                    for _ in 0..1000 {
                        if control.stage().unwrap().is_none() {
                            break;
                        }
                        let target = matches!(
                            (&control.state, boundary),
                            (State::Eligibility, "eligibility")
                                | (State::Host(..), "host")
                                | (State::Frame(_), "frame")
                                | (State::Planes(_), "planes")
                                | (State::Slice(_), "slice")
                                | (State::Clean(_), "clean")
                        );
                        // Observe actual child/stage execution before acceptance.
                        let reply = control.execute(&router, &mut decoder).unwrap();
                        if target {
                            reached = true;
                            if stopped {
                                let stop = exhaust(&account);
                                router.take_layer_slice_diag();
                                control.accept(reply, &router);
                                assert_stop(control.take_result().expect("terminal result"), stop);
                                assert!(router.take_layer_slice_diag().is_empty());
                                return;
                            }
                        }
                        control.accept(reply, &router);
                        if boundary == "clean" {
                            control.mode = Mode::Index;
                        }
                    }
                    if variant == "success" {
                        assert!(reached, "{boundary}");
                    }
                    // A declined earlier stage legitimately cannot reach later gates.
                    let result = control.take_result().expect("controller completes");
                    if variant == "success" {
                        assert_eq!(result.unwrap().unwrap().len(), 2);
                    } else if variant != "error" {
                        assert!(result.is_ok());
                    }
                });
            }
        }
    }
}

#[test]
fn issue_7887_layer_public_gateways_propagate_reached_work_refusal() {
    let content = format!(
        "{WALL}
#100=IFCMATERIAL('outer',$,$);
#101=IFCMATERIAL('inner',$,$);
#110=IFCMATERIALLAYER(#100,0.15,$,$,$,$,$);
#111=IFCMATERIALLAYER(#101,0.15,$,$,$,$,$);
#120=IFCMATERIALLAYERSET((#110,#111),$,$);
#121=IFCMATERIALLAYERSETUSAGE(#120,.AXIS2.,.POSITIVE.,-0.15,$);
#130=IFCRELASSOCIATESMATERIAL('layers',$,$,$,(#9),#121);"
    );
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
                        &element,
                        &mut decoder,
                        &layers,
                        &FxHashMap::default(),
                    ),
                    "submeshes" => router
                        .process_element_with_submeshes(&element, &mut decoder)
                        .map(Some),
                    _ => router
                        .process_element_with_submeshes_and_voids(
                            &element,
                            &mut decoder,
                            &FxHashMap::default(),
                        )
                        .map(Some),
                };
                if bounded {
                    let stop = account
                        .check()
                        .expect_err("production must reach its actual work guard");
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
