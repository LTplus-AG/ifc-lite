// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use std::sync::{Arc, Mutex};
use tracing::field::{Field, Visit};
use tracing::{Dispatch, Event, Subscriber};
use tracing_subscriber::filter::filter_fn;
use tracing_subscriber::layer::{Context, Layer, SubscriberExt};

const TARGET: &str = "ifc_lite_processing::probe_phase_timings";

#[derive(Clone, Copy)]
pub(super) struct Timings {
    pub(super) parse_ns: u64,
    pub(super) scan_ns: u64,
    pub(super) lookup_ns: u64,
    pub(super) preprocess_ns: u64,
    pub(super) geometry_ns: u64,
    pub(super) total_ns: u64,
}

pub(super) fn ms(ns: u64) -> f64 {
    ns as f64 / 1_000_000.0
}

#[derive(Default)]
struct Fields {
    parse_ns: Option<u64>,
    scan_ns: Option<u64>,
    lookup_ns: Option<u64>,
    preprocess_ns: Option<u64>,
    geometry_ns: Option<u64>,
    total_ns: Option<u64>,
}

impl Visit for Fields {
    fn record_u64(&mut self, field: &Field, value: u64) {
        match field.name() {
            "parse_ns" => self.parse_ns = Some(value),
            "scan_ns" => self.scan_ns = Some(value),
            "lookup_ns" => self.lookup_ns = Some(value),
            "preprocess_ns" => self.preprocess_ns = Some(value),
            "geometry_ns" => self.geometry_ns = Some(value),
            "total_ns" => self.total_ns = Some(value),
            _ => {}
        }
    }

    fn record_debug(&mut self, _: &Field, _: &dyn std::fmt::Debug) {}
}

impl Fields {
    fn timings(self) -> Option<Timings> {
        Some(Timings {
            parse_ns: self.parse_ns?,
            scan_ns: self.scan_ns?,
            lookup_ns: self.lookup_ns?,
            preprocess_ns: self.preprocess_ns?,
            geometry_ns: self.geometry_ns?,
            total_ns: self.total_ns?,
        })
    }
}

struct TimingLayer(Arc<Mutex<Option<Timings>>>);

impl<S: Subscriber> Layer<S> for TimingLayer {
    fn on_event(&self, event: &Event<'_>, _: Context<'_, S>) {
        let mut fields = Fields::default();
        event.record(&mut fields);
        *self.0.lock().expect("phase timing event capture poisoned") = fields.timings();
    }
}

pub(super) struct Recorder {
    dispatch: Dispatch,
    sample: Arc<Mutex<Option<Timings>>>,
}

impl Recorder {
    pub(super) fn new() -> Self {
        let sample = Arc::new(Mutex::new(None));
        let layer = TimingLayer(Arc::clone(&sample)).with_filter(filter_fn(|meta| meta.target() == TARGET));
        let dispatch = Dispatch::new(tracing_subscriber::registry().with(layer));
        Self { dispatch, sample }
    }

    pub(super) fn measure<T>(&self, run: impl FnOnce() -> T) -> (T, Option<Timings>) {
        let result = tracing::dispatcher::with_default(&self.dispatch, run);
        let sample = self.sample.lock().expect("phase timing event capture poisoned").take();
        (result, sample)
    }
}

#[cfg(test)]
mod tests {
    use super::{ms, Recorder};

    #[test]
    fn only_complete_event_from_current_invocation_provides_phase_timings_11669() {
        let recorder = Recorder::new();
        let (_, measured) = recorder.measure(|| {
            tracing::trace!(target: "ifc_lite_processing::probe_phase_timings",
                parse_ns = 1_500_000u64, scan_ns = 1_000_000u64, lookup_ns = 8_000u64,
                preprocess_ns = 0u64, geometry_ns = 2_750_000u64, total_ns = 4_250_000u64);
        });
        let measured = measured.expect("complete event");
        assert_eq!(ms(measured.lookup_ns), 0.008);
        assert_eq!(ms(measured.preprocess_ns), 0.0);
        assert!(recorder.measure(|| {}).1.is_none());
        assert!(recorder.measure(|| {
            tracing::trace!(target: "ifc_lite_processing::probe_phase_timings", total_ns = 1u64);
        }).1.is_none());
    }
}
