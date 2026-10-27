// SPDX-License-Identifier: MPL-2.0
//! Typed host refusal, shared by the WASM conversion and its native oracle.
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
use ifc_lite_processing::element::retained_runtime::{RefusalOrigin, RetainedProductRefusal};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RefusedProduct {
    status: &'static str,
    express_id: u32,
    ifc_type: String,
    code: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    origin: Option<Origin>,
    #[serde(skip_serializing_if = "Option::is_none")]
    kernel_status: Option<i32>,
}
#[derive(Serialize)]
struct Origin {
    site: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    entity: Option<u32>,
    cause: &'static str,
}
impl RefusedProduct {
    pub(crate) fn new(
        express_id: u32,
        ifc_type: String,
        refusal: RetainedProductRefusal,
        origin: Option<RefusalOrigin>,
    ) -> Self {
        Self {
            status: "refused",
            express_id,
            ifc_type,
            code: refusal.code(),
            origin: origin.map(|o| Origin {
                site: o.site,
                entity: o.entity,
                cause: o.cause,
            }),
            kernel_status: match refusal {
                RetainedProductRefusal::KernelFailure { status } => Some(status),
                _ => None,
            },
        }
    }
}
