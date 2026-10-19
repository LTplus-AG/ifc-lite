// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Python bridge to the same std::time::Instant producer used by native wrappers.
use std::{sync::OnceLock,time::Instant};
#[no_mangle]
pub extern "C" fn d47_clock_now_ns() -> u64 {
    static ORIGIN: OnceLock<Instant> = OnceLock::new();
    ORIGIN.get_or_init(Instant::now).elapsed().as_nanos().try_into().unwrap()
}
