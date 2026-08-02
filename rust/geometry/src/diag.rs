// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Structured-diagnostics shims for the `observability` cargo feature.
//!
//! This crate's production diagnostics historically went to stderr via
//! `eprintln!`. With the `observability` feature ON they become structured
//! `tracing` events (fields instead of prose) that flow into whatever
//! subscriber the host installed — the native server already runs a
//! `tracing_subscriber::fmt` layer, so enabling the feature there is enough.
//! With the feature OFF (the default), zero tracing code is compiled into
//! this crate and behavior is byte-identical to before.
//!
//! Gating policy (documented decision):
//!
//! - WARN-level sites report genuine anomalies that operators currently see
//!   on the server's stderr in default builds (failed layer slicing, degraded
//!   fallbacks). Those messages must NOT silently disappear from default
//!   builds, so [`diag_warn!`] keeps the legacy `eprintln!` as the
//!   feature-OFF fallback and upgrades to `tracing::warn!` when ON.
//!
//! - DEBUG-level sites are high-volume trace/progress notes that were
//!   already compile-time gated (`debug_assertions` or the `debug_geometry`
//!   feature) or are pure success chatter. [`diag_debug!`] emits
//!   `tracing::debug!` when ON; when OFF it expands to exactly the legacy
//!   tokens the call site supplies (which may themselves carry the original
//!   `#[cfg(...)]` gate, preserving today's behavior precisely).
//!
//! Both macros take the tracing form first and the legacy statements second,
//! so the feature-OFF expansion reproduces the OLD output byte-for-byte:
//!
//! ```ignore
//! diag_warn!(
//!     { element_id = element.id, "material-layers: slicing errored" }
//!     else {
//!         eprintln!("[material-layers] #{}: sliceable but slicing errored", element.id);
//!     }
//! );
//! ```

/// Anomaly-level diagnostic: `tracing::warn!` when the `observability`
/// feature is ON, the supplied legacy statements (normally the original
/// `eprintln!`) when OFF. See the module docs for the gating policy.
macro_rules! diag_warn {
    ({ $($trace:tt)+ } else { $($legacy:tt)* }) => {{
        #[cfg(feature = "observability")]
        {
            ::tracing::warn!($($trace)+);
        }
        #[cfg(not(feature = "observability"))]
        {
            $($legacy)*
        }
    }};
}

/// Trace/progress-level diagnostic: `tracing::debug!` when the
/// `observability` feature is ON, the supplied legacy statements when OFF
/// (pass an empty `else {}` to compile out entirely). See the module docs.
macro_rules! diag_debug {
    ({ $($trace:tt)+ } else { $($legacy:tt)* }) => {{
        #[cfg(feature = "observability")]
        {
            ::tracing::debug!($($trace)+);
        }
        #[cfg(not(feature = "observability"))]
        {
            $($legacy)*
        }
    }};
}

pub(crate) use diag_debug;
pub(crate) use diag_warn;
