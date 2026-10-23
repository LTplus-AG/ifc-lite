// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::element_tasks;
use rayon::prelude::*;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// Element 0 waits for element 1 to start. With rayon's default ranges both share
/// one thread's leaf, so element 0 times out; one task per element frees element 1.
#[test]
fn a_slow_element_does_not_hold_its_neighbour_on_the_same_thread() {
    let pool = rayon::ThreadPoolBuilder::new().num_threads(2).build().unwrap();
    let jobs: Vec<usize> = (0..64).collect();
    let neighbour_started = AtomicBool::new(false);
    let deadline = Duration::from_secs(10);
    let saw_neighbour: Vec<bool> = pool.install(|| {
        element_tasks(&jobs)
            .map(|&job| match job {
                0 => {
                    let start = Instant::now();
                    while !neighbour_started.load(Ordering::Acquire) {
                        if start.elapsed() > deadline {
                            return false;
                        }
                        std::thread::yield_now();
                    }
                    true
                }
                1 => {
                    neighbour_started.store(true, Ordering::Release);
                    true
                }
                _ => true,
            })
            .collect()
    });
    assert!(saw_neighbour[0], "element 1 only started after element 0 gave up");
}
