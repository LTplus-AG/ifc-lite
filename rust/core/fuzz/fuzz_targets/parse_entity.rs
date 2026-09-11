// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#![no_main]

use libfuzzer_sys::fuzz_target;

// Contract under fuzz: parsing arbitrary bytes as a single STEP entity must
// never panic, hang, or overflow the stack; it may only return Ok or Err. The
// return value is intentionally discarded; libFuzzer drives input coverage.
fuzz_target!(|data: &[u8]| {
    let _ = ifc_lite_core::parse_entity(data);
});
