// SPDX-License-Identifier: MPL-2.0
use super::*;
use ifc_lite_core::EntityDecoder;

fn source() -> &'static str { "#1=IFCBLOCK($,2.,3.,4.);" }
fn begin(decoder: &mut EntityDecoder<'_>) -> GeometryProgram {
    GeometryProgram::item(decoder.decode_by_id(1).unwrap(), (0.,0.,0.))
}
fn drain(program: &mut GeometryProgram, router: &GeometryRouter, decoder: &mut EntityDecoder<'_>) {
    while let Some(request) = program.request().unwrap() {
        let reply = program.execute(request, router, decoder).unwrap();
        program.accept(reply, router).unwrap();
    }
}

#[test]
fn numerical_recipe_is_linear_and_foreign_reply_survives_rejection() {
    let router = GeometryRouter::new();
    let mut decoder = EntityDecoder::new(source());
    let mut first = begin(&mut decoder);
    let mut second = begin(&mut decoder);
    let request = first.request().unwrap().unwrap();
    let reply = first.execute(request, &router, &mut decoder).unwrap();
    assert_eq!(first.execute(request, &router, &mut decoder).err(), Some(ProgramError::AlreadyExecuted));
    let rejected = second.accept(reply, &router).unwrap_err();
    assert_eq!(rejected.error, ProgramError::StaleRequest);
    first.accept(rejected.reply, &router).unwrap();
    drain(&mut first, &router, &mut decoder);
    let mesh = first.finish().unwrap();
    assert!(!mesh.indices.is_empty());
    let (min, max) = mesh.bounds();
    assert_eq!([max.x-min.x,max.y-min.y,max.z-min.z], [2.,3.,4.]);
    drain(&mut second, &router, &mut decoder);
    assert_eq!(second.finish().unwrap().indices.len(), mesh.indices.len());
}

#[test]
fn constructor_executes_after_source_decoder_has_been_released() {
    let router = GeometryRouter::new();
    let mut decoder = EntityDecoder::new(source());
    let mut program = begin(&mut decoder);
    loop {
        let request = program.request().unwrap().unwrap();
        if request.stage == ProgramStage::Numerical {
            // The packet owns the numerical inputs after decoder release.
            // Session execution supplies lexical resource and diagnostic scopes.
            let ready = program.take_ready(request).unwrap();
            drop(decoder);
            let reply = ready.execute();
            program.accept(reply, &router).unwrap();
            assert!(!program.finish().unwrap().is_empty());
            return;
        }
        let reply = program.execute(request, &router, &mut decoder).unwrap();
        program.accept(reply, &router).unwrap();
    }
}

#[test]
fn dormant_program_is_send_and_cancellation_blocks_pending_work() {
    fn require_send<T: Send>() {}
    require_send::<GeometryProgram>();
    let router = GeometryRouter::new();
    let mut decoder = EntityDecoder::new(source());
    let mut program = begin(&mut decoder);
    let request = program.request().unwrap().unwrap();
    program.cancel();
    assert_eq!(program.execute(request, &router, &mut decoder).err(), Some(ProgramError::Cancelled));
}
