#![no_main]

use libfuzzer_sys::fuzz_target;

// Contract under fuzz: parsing arbitrary bytes as a single STEP entity must
// never panic, hang, or overflow the stack; it may only return Ok or Err. The
// return value is intentionally discarded; libFuzzer drives input coverage.
fuzz_target!(|data: &[u8]| {
    let _ = ifc_lite_core::parse_entity(data);
});
