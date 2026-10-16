// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#![no_main]

use libfuzzer_sys::fuzz_target;

// Contract under fuzz: see `exercise_landxml`. LandXML arrives as untrusted
// survey exports, so every pull entry point and the streaming session must
// return Ok or Err on arbitrary bytes and never panic, hang or overflow the
// stack. The shared file is also replayed on stable by
// `tests/fuzz_regressions.rs`, so the two can never drift.
include!("../../tests/fuzz/exercise.rs");

fuzz_target!(|data: &[u8]| {
    exercise_landxml(data);
});
