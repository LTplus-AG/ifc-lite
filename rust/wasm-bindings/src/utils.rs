// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Panic plumbing for the browser.
//!
//! With `panic = "abort"` every Rust panic reaches JavaScript as the same
//! content-free `RuntimeError: unreachable`, so error tracking kept minting
//! untriageable issues that said nothing but "unreachable" (issues #1196 and
//! #2527). The hook installed here keeps `console_error_panic_hook`'s console
//! report and ADDITIONALLY stashes the panic's source location on the realm's
//! JS global (`globalThis.__ifclite_wasm_panic = { location, at }`), where the
//! viewer's analytics `before_send` gate picks it up and attaches it to the
//! trap's exception event (`apps/viewer/src/lib/analytics-scrub.ts`).
//!
//! Privacy contract: ONLY the source location travels — the panic payload
//! message can embed model-derived text (an entity value, a name), so it stays
//! console-only. [`sanitize_panic_path`] additionally strips build-machine
//! prefixes so no checkout path or username can leave the browser.

#[cfg(feature = "console_error_panic_hook")]
use std::panic;

/// JS global property the most recent panic's location is stashed under.
/// Kept in lockstep with `WASM_PANIC_STASH_KEY` in
/// `apps/viewer/src/lib/analytics-scrub.ts`.
#[cfg(feature = "console_error_panic_hook")]
const PANIC_STASH_KEY: &str = "__ifclite_wasm_panic";

/// Stash `{ location: "crate/src/file.rs:line:col", at: Date.now() }` on the
/// JS global of whichever realm (window or worker) this instance runs in.
/// Best-effort: a JS-side failure must never disturb the panic report itself.
#[cfg(feature = "console_error_panic_hook")]
fn stash_panic_location(info: &panic::PanicHookInfo<'_>) {
    let Some(location) = info.location() else {
        return;
    };
    stash_location_parts(location.file(), location.line(), location.column());
}

/// The stash write itself, split from the hook so it is observable: a REAL
/// panic aborts the test runner under `panic = "abort"`, so the wasm32 test
/// leg (`tests/panic_stash.rs`) exercises this seam directly. `#[doc(hidden)]`
/// `pub` for that test only — not part of the JS API (no `#[wasm_bindgen]`).
#[cfg(feature = "console_error_panic_hook")]
#[doc(hidden)]
pub fn stash_location_parts(file: &str, line: u32, column: u32) {
    let text = format!("{}:{}:{}", sanitize_panic_path(file), line, column);
    let stash = js_sys::Object::new();
    let ok = js_sys::Reflect::set(
        &stash,
        &wasm_bindgen::JsValue::from_str("location"),
        &wasm_bindgen::JsValue::from_str(&text),
    )
    .is_ok()
        && js_sys::Reflect::set(
            &stash,
            &wasm_bindgen::JsValue::from_str("at"),
            &wasm_bindgen::JsValue::from_f64(js_sys::Date::now()),
        )
        .is_ok();
    if ok {
        let _ = js_sys::Reflect::set(
            &js_sys::global(),
            &wasm_bindgen::JsValue::from_str(PANIC_STASH_KEY),
            &stash.into(),
        );
    }
}

/// Strip build-machine prefixes from a panic location's file path so the
/// stashed location is safe to ship: crate identity stays, checkout paths and
/// usernames go.
///
/// - workspace-relative paths (the common case) pass through unchanged;
/// - cargo-registry dependency paths keep only `<crate>-<version>/…`;
/// - absolute paths containing the workspace's `rust/` root are cut there;
/// - any other absolute path keeps a short tail, with a `Users`/`home`
///   segment (and the username after it) always removed first.
#[cfg_attr(not(feature = "console_error_panic_hook"), allow(dead_code))]
fn sanitize_panic_path(file: &str) -> String {
    let unified = file.replace('\\', "/");
    // Dependency from the cargo registry: skip through the registry index
    // segment, keep the crate-version tail.
    if let Some(idx) = unified.find("/registry/src/") {
        let rest = &unified[idx + "/registry/src/".len()..];
        if let Some(slash) = rest.find('/') {
            return rest[slash + 1..].to_string();
        }
    }
    // Absolute checkout of this workspace: the deepest `rust/` segment is the
    // workspace root, so the tail from there is the stable identity.
    if let Some(idx) = unified.rfind("/rust/") {
        return unified[idx + 1..].to_string();
    }
    let is_absolute = unified.starts_with('/') || unified.as_bytes().get(1) == Some(&b':');
    if !is_absolute {
        return unified;
    }
    // Unrecognised absolute path (a rustc std mapping, a stray local build):
    // drop a home directory outright, then keep at most four segments.
    let segments: Vec<&str> = unified.split('/').filter(|s| !s.is_empty()).collect();
    let after_home = match segments.iter().position(|s| *s == "Users" || *s == "home") {
        Some(idx) => &segments[(idx + 2).min(segments.len())..],
        None => &segments[..],
    };
    let keep = after_home.len().saturating_sub(4);
    after_home[keep..].join("/")
}

/// Install the panic hook: `console_error_panic_hook`'s console report plus
/// the analytics location stash above. Idempotent.
pub fn set_panic_hook() {
    #[cfg(feature = "console_error_panic_hook")]
    {
        use std::sync::Once;
        static SET_HOOK: Once = Once::new();
        SET_HOOK.call_once(|| {
            panic::set_hook(Box::new(|info| {
                stash_panic_location(info);
                console_error_panic_hook::hook(info);
            }));
        });
    }
}

#[cfg(test)]
#[path = "utils_tests.rs"]
mod tests;
