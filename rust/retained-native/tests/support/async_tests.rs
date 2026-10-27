// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955: dropped async work retires the captured domain and publishes nothing.
use super::support::*;
use ifc_lite_processing::element::retained_runtime::*;
use std::{
    future::Future,
    task::{Context, Poll, Waker},
};
#[test]
fn async_drop_cannot_publish_and_retires_only_the_captured_domain() {
    let mut transport = peer();
    transport.suspend = true;
    let domain = transport.domain.clone();
    let mut transport = Some(transport);
    let other = peer();
    let options = ModelOptions::default();
    let mut outcomes = Vec::new();
    let mut future = Box::pin(run_model(
        ifc_lite_core::SourceBundle::new(BOX.as_bytes().to_vec()),
        &options,
        || Ok(transport.take().unwrap()),
        |o| outcomes.push(o),
    ));
    assert!(matches!(
        future
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop())),
        Poll::Pending
    ));
    assert!(domain.0.get());
    drop(future);
    assert!(!domain.0.get());
    assert!(other.domain.0.get());
    assert!(outcomes.is_empty());
}
