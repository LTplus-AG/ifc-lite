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
