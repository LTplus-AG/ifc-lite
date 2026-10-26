// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955: invalid limits are refused before acquiring any numerical worker.
use super::support::*;
use ifc_lite_processing::element::retained_runtime::*;
#[test]
fn invalid_limits_never_dispatch_or_publish() {
    let mut options = ModelOptions::default();
    options.limits.chord_metres = f64::NAN;
    let result = ifc_lite_retained_native::block_on(run_model(
        ifc_lite_core::SourceBundle::new(BOX.as_bytes().to_vec()),
        &options,
        || -> Result<Peer, RuntimeFault> { panic!("must not acquire") },
        |_| panic!("must not publish"),
    ));
    assert_eq!(result.unwrap_err().refusal().0.code(), "contract_breach");
}
