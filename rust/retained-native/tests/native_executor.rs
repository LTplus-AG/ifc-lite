// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
#[path = "support/adversarial_tests.rs"]
mod adversarial_tests;
#[path = "support/affine_tests.rs"]
mod affine_tests;
#[path = "support/async_tests.rs"]
mod async_tests;
#[path = "support/boolean_tests.rs"]
mod boolean_tests;
#[path = "support/contract_tests.rs"]
mod contract_tests;
#[path = "../examples/compare/metrics.rs"]
#[allow(dead_code)]
mod metrics;
#[path = "support/predispatch_tests.rs"]
mod predispatch_tests;
mod support;
#[path = "support/tests.rs"]
mod tests;
#[path = "support/type_map_tests.rs"]
mod type_map_tests;

#[path = "support/geometry_assertions.rs"]
mod geometry_assertions;
