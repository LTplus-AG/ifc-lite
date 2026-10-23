// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#![no_main]

use libfuzzer_sys::fuzz_target;

// The assertions live once, in the file the stable replay test
// (tests/fuzz_regressions.rs) includes too, so a corpus file replays through
// exactly what the fuzzer checked.
#[path = "../../tests/support/grammar_oracle.rs"]
mod oracle;

// Contract under fuzz: the STEP string decoders are total on arbitrary bytes. A
// return of the quadratic unterminated \X2\ path (CORE-28) shows up as a
// libFuzzer timeout.
fuzz_target!(|data: &[u8]| {
    oracle::decode_string(data);
});
