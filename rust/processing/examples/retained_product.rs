// SPDX-License-Identifier: MPL-2.0
//! Local intermediate diagnostic; an existing real SDK executable is required.
#[cfg(not(target_arch = "wasm32"))]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use std::{future::Future, task::{Context, Poll, Wake, Waker}, sync::Arc};
    struct Notify(std::thread::Thread);
    impl Wake for Notify { fn wake(self: Arc<Self>) { self.0.unpark(); } }
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 4 { return Err("usage: retained_product MODEL.ifc EXPRESS_ID EXISTING_SMLIB_WORKER suppress_instanced|emit_tagged".into()); }
    let source = ifc_lite_core::SourceBundle::new(std::fs::read(&args[0])?);
    let id = args[1].to_str().ok_or("invalid Express ID")?.parse()?;
    let mode = match args[3].to_str() {
        Some("suppress_instanced") => ifc_lite_processing::element::TypeGeometryMode::SuppressInstanced,
        Some("emit_tagged") => ifc_lite_processing::element::TypeGeometryMode::EmitTagged,
        _ => return Err("invalid type geometry mode".into()),
    };
    let mut future = Box::pin(ifc_lite_processing::element::diagnose_retained_native(
        source, id, std::path::Path::new(&args[2]), 0.001, 15., 256 * 1024 * 1024, 1_000_000, mode));
    let waker = Waker::from(Arc::new(Notify(std::thread::current())));
    let mut context = Context::from_waker(&waker);
    let diagnostic = loop {
        match future.as_mut().poll(&mut context) {
            Poll::Ready(result) => break result?,
            Poll::Pending => std::thread::park(),
        }
    };
    assert!(diagnostic.require_final_product().is_err());
    println!("{}", std::str::from_utf8(diagnostic.bytes()?)?);
    Ok(())
}
#[cfg(target_arch = "wasm32")]
fn main() { panic!("the native diagnostic is unavailable on wasm32"); }
