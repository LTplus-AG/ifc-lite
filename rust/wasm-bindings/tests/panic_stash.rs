// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Panic-location stash — wasm32 leg (issues #1196 / #2527).
//!
//! The panic hook installed by `set_panic_hook` stashes the panic's sanitised
//! source location on the JS global, where the viewer's analytics gate
//! (`apps/viewer/src/lib/analytics-scrub.ts`) attaches it to the trap's
//! exception event. A REAL panic aborts the test runner under
//! `panic = "abort"`, so what CAN be observed end-to-end is the seam directly
//! below the hook: the stash write, in a real wasm/JS environment.
//!
//! Run: `wasm-pack test --node rust/wasm-bindings --test panic_stash`
#![cfg(target_arch = "wasm32")]

use wasm_bindgen::JsValue;
use wasm_bindgen_test::wasm_bindgen_test;

const STASH_KEY: &str = "__ifclite_wasm_panic";

fn read_stash() -> JsValue {
    js_sys::Reflect::get(&js_sys::global(), &JsValue::from_str(STASH_KEY))
        .expect("global read must not throw")
}

#[wasm_bindgen_test]
fn stash_lands_on_the_js_global_with_location_and_timestamp() {
    ifc_lite_wasm::stash_location_parts("geometry/src/mesh_weld.rs", 412, 9);
    let stash = read_stash();
    let location = js_sys::Reflect::get(&stash, &JsValue::from_str("location"))
        .unwrap()
        .as_string()
        .expect("location must be a string");
    assert_eq!(location, "geometry/src/mesh_weld.rs:412:9");
    let at = js_sys::Reflect::get(&stash, &JsValue::from_str("at"))
        .unwrap()
        .as_f64()
        .expect("at must be a number");
    let now = js_sys::Date::now();
    assert!(at <= now && now - at < 60_000.0, "at={at} now={now}");
}

#[wasm_bindgen_test]
fn stash_sanitises_a_build_machine_path_before_it_touches_js() {
    // Kills the mutation where the stash path skips sanitisation: the privacy
    // cut must happen BEFORE the value exists anywhere JS can read it.
    ifc_lite_wasm::stash_location_parts("/Users/somebody/scratch/lib.rs", 1, 2);
    let stash = read_stash();
    let location = js_sys::Reflect::get(&stash, &JsValue::from_str("location"))
        .unwrap()
        .as_string()
        .unwrap();
    assert_eq!(location, "scratch/lib.rs:1:2");
}

#[wasm_bindgen_test]
fn a_second_stash_overwrites_the_first() {
    // One panic, one location: the most recent panic must win, so a suppressed
    // older trap can never label a newer one.
    ifc_lite_wasm::stash_location_parts("geometry/src/a.rs", 1, 1);
    ifc_lite_wasm::stash_location_parts("geometry/src/b.rs", 2, 2);
    let stash = read_stash();
    let location = js_sys::Reflect::get(&stash, &JsValue::from_str("location"))
        .unwrap()
        .as_string()
        .unwrap();
    assert_eq!(location, "geometry/src/b.rs:2:2");
}

/// Reproduces the #2539 regression directly against `IfcAPI::new()` — the
/// constructor the viewer actually calls — instead of `stash_location_parts`
/// (the seam every other test in this file exercises).
///
/// A REAL panic can't be used to observe this end-to-end: `panic = "abort"`
/// is this target's actual panic strategy (confirmed via
/// `rustc --print target-spec-json --target wasm32-unknown-unknown`), and
/// separately this binary's own JS test harness
/// (`wasm_bindgen_test::Context::new()`, built once by the generated runner
/// before any test executes) already installs its own `panic::set_hook` for
/// diagnostic output — via the exact same "unconditional `set_hook` behind a
/// private `Once`" shape this test exists to rule out in `IfcAPI::new()` — so
/// even a trap that JS manages to catch at a nested call boundary says
/// nothing about whether `set_panic_hook`'s hook specifically survived.
///
/// So this test observes the mechanism directly instead: `std::panic::Hook`
/// is a `Box<dyn Fn>`, and `take_hook`/`set_hook` let a test read back
/// *which* box is currently installed without ever invoking it. It first
/// calls `set_panic_hook()` itself — exactly what `#[wasm_bindgen(start)]
/// init()` does in production, and the call that fires `set_panic_hook`'s
/// private `Once` for real, whether or not the wasm `start` section already
/// ran under this harness — then fingerprints (by address) whatever is
/// installed and puts it right back, unchanged: this is the sentinel state
/// the fixed code must leave alone. It then calls `IfcAPI::new()` (the real
/// production call site — `#[wasm_bindgen(constructor)]` only changes the
/// generated JS binding, not what runs) and fingerprints the hook again.
///
/// Before the #2539 fix, `IfcAPI::new()` called
/// `console_error_panic_hook::set_once()` directly. That function owns a
/// private `Once` distinct from `set_panic_hook`'s, never fired elsewhere in
/// this binary, so its first-ever call — right here — unconditionally builds
/// a brand new hook `Box` and installs it via `panic::set_hook`, so the
/// address recorded after `IfcAPI::new()` differs from the one recorded
/// before, and the assertion below fails.
#[wasm_bindgen_test]
fn ifc_api_new_does_not_clobber_the_installed_panic_hook() {
    // Mirrors `#[wasm_bindgen(start)] init()`: fires `set_panic_hook`'s own
    // `Once` for real, exactly as production does before any `IfcAPI` is
    // constructed.
    ifc_lite_wasm::set_panic_hook();

    // Fingerprint whatever is now installed (the crate's real hook, if this
    // was the `Once`'s first-ever fire in this binary; the JS harness's own
    // hook otherwise — either way, a hook `IfcAPI::new()` must not replace)
    // and put the SAME box right back so nothing has actually changed yet.
    let installed = std::panic::take_hook();
    let before = format!("{:p}", &*installed);
    std::panic::set_hook(installed);

    let _api = ifc_lite_wasm::IfcAPI::new();

    let after_box = std::panic::take_hook();
    let after = format!("{:p}", &*after_box);
    std::panic::set_hook(after_box);

    assert_eq!(
        before, after,
        "IfcAPI::new() replaced the installed panic hook instead of \
         leaving it in place (the #2539 regression: \
         console_error_panic_hook::set_once() installs a brand new hook \
         behind its own private Once, clobbering whatever set_panic_hook \
         had already installed)"
    );
}
