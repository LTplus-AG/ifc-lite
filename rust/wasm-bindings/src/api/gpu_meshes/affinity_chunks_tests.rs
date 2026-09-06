// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Regression contract for #4051:
// publishing bulk jobs must not wait for all remaining affinity computation.
use std::cell::{Cell, RefCell};
use super::emit_affinity_chunks;

#[derive(Debug, PartialEq)]
enum Event {
    Key(u32),
    Emit(Vec<u32>, Vec<u32>),
}

#[test]
fn publishes_each_chunk_before_computing_later_keys() {
    let events = RefCell::new(Vec::new());
    let result: Result<(), ()> = emit_affinity_chunks(&[10, 11, 12, 13, 14], 2,
        |&job| {
            events.borrow_mut().push(Event::Key(job));
            job + 100
        },
        |jobs, keys| {
            events.borrow_mut().push(Event::Emit(jobs.to_vec(), keys.to_vec()));
            Ok(())
        });
    assert_eq!(result, Ok(()));
    assert_eq!(events.into_inner(), vec![
        Event::Key(10), Event::Key(11), Event::Emit(vec![10, 11], vec![110, 111]),
        Event::Key(12), Event::Key(13), Event::Emit(vec![12, 13], vec![112, 113]),
        Event::Key(14), Event::Emit(vec![14], vec![114]),
    ]);
}

#[test]
fn callback_error_stops_before_any_later_key_or_publication() {
    // Check failure on both the first and second publication: a completed
    // prefix remains valid and the failed callback's exact error propagates.
    for stop_after in [1, 2] {
        let keyed = RefCell::new(Vec::new());
        let publications = Cell::new(0);
        let result = emit_affinity_chunks(&[1, 2, 3, 4, 5, 6], 2,
            |&job| { keyed.borrow_mut().push(job); job * 7 },
            |jobs, keys| {
                publications.set(publications.get() + 1);
                assert_eq!(keys, jobs.iter().map(|id| id * 7).collect::<Vec<_>>());
                if publications.get() == stop_after { Err("consumer stopped") } else { Ok(()) }
            });
        assert_eq!(result, Err("consumer stopped"));
        assert_eq!(publications.get(), stop_after);
        assert_eq!(keyed.into_inner(), (1..=stop_after * 2).collect::<Vec<_>>());
    }
}

#[test]
fn empty_input_does_not_compute_or_publish() {
    let result: Result<(), ()> = emit_affinity_chunks::<u32, ()>(&[], 2,
        |_| panic!("empty stream must not compute keys"),
        |_, _| panic!("empty stream must not publish"));
    assert_eq!(result, Ok(()));
}
