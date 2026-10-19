// SPDX-License-Identifier: MPL-2.0
//! Real source and numerical pauses on the common opening child protocol.
use super::control::{OpeningControl, OpeningOutput, OpeningPoll};
use super::requests::{OpeningReady, OpeningReply, OpeningSource};
use super::*;
use crate::program::tests::{ObservedBlock, BLOCK};
use crate::GeometryRouter;
use ifc_lite_core::EntityDecoder;
use std::{cell::Cell, rc::Rc};

fn unwrap(reply: OpeningReply) -> OpeningReply {
    match reply {
        OpeningReply::Captured(reply, _) | OpeningReply::Numerical(_, reply) => unwrap(*reply),
        reply => reply,
    }
}
fn geometry(
    child: OpeningChild,
    router: &GeometryRouter,
    decoder: &mut EntityDecoder<'_>,
) -> OpeningReply {
    let result = child.admit(router).and_then(|(mut program, mesh)| {
        while let Some(request) = program.request().expect("actual child request") {
            let reply = program
                .execute(request, router, decoder)
                .expect("actual child execute");
            program.accept(reply, router).expect("actual child accept");
        }
        if mesh {
            program.finish().map(|mesh| vec![mesh])
        } else {
            program.finish_parts()
        }
    });
    OpeningReply::Parts(result)
}
#[test]
fn opening_whole_representations_fault_precedes_placement_and_any_geometry_child() {
    let mut decoder = EntityDecoder::new(
        "#1=IFCOPENINGELEMENT('void',$,$,$,$,#2,#5,$);
#2=IFCLOCALPLACEMENT($,#3);#3=IFCAXIS2PLACEMENT3D(#4,$,$);
#4=IFCCARTESIANPOINT((1.E400,0.,0.));
#5=IFCPRODUCTDEFINITIONSHAPE($,$,(#6,#999));#6=IFCSHAPEREPRESENTATION($,'Body','CSG',(#10));
#10=IFCBLOCK($,2.,3.,4.);",
    )
    .with_strict_reals();
    let opening = decoder.decode_by_id(1).unwrap();
    let router = GeometryRouter::new();
    let mut control = OpeningControl::probe(opening, true);
    let OpeningPoll::Source(source @ OpeningSource::Representations { .. }) = control.poll() else {
        panic!("whole representations admission")
    };
    let reply = source.execute(&router, &mut decoder);
    control.resume(reply, &router);
    assert!(matches!(control.poll(), OpeningPoll::Complete(Err(_))));
    assert!(
        decoder.refused_record_ids().is_empty(),
        "unreached placement point remains dormant"
    );
    assert!(
        decoder.decode_by_id(4).is_err(),
        "the dormant placement was really invalid"
    );
}
#[test]
fn opening_classifier_executes_one_real_decision_before_consuming_its_effect() {
    let content = format!(
        "{BLOCK}\n#1=IFCWALL('host',$,$,$,$,$,#2,$);
#2=IFCPRODUCTDEFINITIONSHAPE($,$,(#3));#3=IFCSHAPEREPRESENTATION($,'Body','CSG',(#10));
#20=IFCOPENINGELEMENT('opening',$,$,$,$,$,#2,$);"
    );
    let calls = Rc::new(Cell::new(0));
    let mut router = GeometryRouter::new();
    router.register(Box::new(ObservedBlock {
        calls: calls.clone(),
        repair: false,
    }));
    let mut decoder = EntityDecoder::new(&content);
    let host = decoder.decode_by_id(1).unwrap();
    let mut control = OpeningControl::classifier(host, vec![20, 20], true);
    let mut decisions = 0;
    loop {
        let reply = match control.poll() {
            OpeningPoll::Source(source) => source.execute(&router, &mut decoder),
            OpeningPoll::Geometry(child) => geometry(child, &router, &mut decoder),
            OpeningPoll::Ready(ready @ OpeningReady::Decision(_)) => {
                let before = router.take_classification_stats();
                assert_eq!(
                    before.rectangular + before.diagonal + before.non_rectangular,
                    decisions
                );
                decisions = 0;
                let reply = ready.execute();
                let untouched = router.take_classification_stats();
                assert_eq!(
                    untouched.rectangular + untouched.diagonal + untouched.non_rectangular,
                    0,
                    "sourcefree decision execution cannot publish counters"
                );
                if matches!(unwrap_ref(&reply), OpeningReply::Decision(_, Some(_))) {
                    decisions = 1;
                }
                reply
            }
            OpeningPoll::Ready(ready) => ready.execute(),
            OpeningPoll::Complete(output) => {
                let OpeningOutput::Classified(openings) = output.unwrap() else {
                    panic!("classified output")
                };
                assert_eq!(openings.len(), 2);
                break;
            }
            OpeningPoll::Pending => panic!("unconsumed child"),
        };
        control.resume(reply, &router);
    }
    assert_eq!(
        calls.get(),
        6,
        "each occurrence still invokes body, bounds and mesh processors"
    );
    let diagnostics = router.take_host_opening_diagnostics();
    assert_eq!(
        diagnostics[&1]
            .openings
            .iter()
            .map(|entry| entry.opening_id)
            .collect::<Vec<_>>(),
        [20, 20]
    );
}
fn unwrap_ref(reply: &OpeningReply) -> &OpeningReply {
    match reply {
        OpeningReply::Captured(reply, _) | OpeningReply::Numerical(_, reply) => unwrap_ref(reply),
        reply => reply,
    }
}
#[test]
fn opening_numerical_probe_uses_owned_mesh_and_frame_after_source_disposal() {
    let mesh = {
        let mut decoder = EntityDecoder::new("#1=IFCBLOCK($,2.,3.,4.);");
        let entity = decoder.decode_by_id(1).unwrap();
        crate::processors::BlockProcessor::new()
            .lower(&entity, &mut decoder)
            .unwrap()
            .evaluate()
    };
    let recipe = OpeningReady::ProbeParts {
        parts: vec![mesh],
        placement: nalgebra::Matrix4::new_translation(&crate::Vector3::new(5., 6., 7.)),
        frame: crate::router::transforms::WorldFrame {
            rtc_offset: (0., 0., 0.),
            local_frame_enabled: false,
        },
        meshes: false,
        direction: None,
    };
    let OpeningReply::ProbeParts(meshes, bounds) = unwrap(recipe.execute()) else {
        panic!("numerical bounds result")
    };
    assert!(meshes.is_empty());
    assert_eq!(bounds.len(), 1);
    assert_eq!(bounds[0].0, crate::Point3::new(5., 6., 7.));
    assert_eq!(bounds[0].1, crate::Point3::new(7., 9., 11.));
}
#[test]
fn dormant_opening_control_and_operations_are_send() {
    fn send<T: Send>() {}
    send::<OpeningControl>();
    send::<OpeningSource>();
    send::<OpeningReady>();
    send::<OpeningReply>();
}
