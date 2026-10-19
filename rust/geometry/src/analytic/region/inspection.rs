// SPDX-License-Identifier: MPL-2.0
//! One rollback owner: destroy inspection caches before refunding their backing.
use crate::resource::Reservation;
use ifc_lite_core::EntityDecoder;

#[derive(Default)]
pub(super) struct InspectionPermits {
    pub _context: Option<Reservation>,
    pub _metadata: Option<Reservation>,
    pub reads: Vec<Reservation>,
}
pub(super) struct InspectionOwner<'a> {
    pub decoder: Option<EntityDecoder<'a>>,
    pub permits: InspectionPermits,
}
impl<'a> InspectionOwner<'a> {
    pub fn new(decoder: EntityDecoder<'a>) -> Self {
        Self {
            decoder: Some(decoder),
            permits: InspectionPermits::default(),
        }
    }
    fn destroy_decoder(&mut self) {
        if self.decoder.is_none() {
            return;
        }
        #[cfg(test)]
        probes::notify(probes::Phase::BeforeDecoder, self.decoder.as_ref());
        drop(self.decoder.take());
        #[cfg(test)]
        probes::notify(probes::Phase::AfterDecoder, self.decoder.as_ref());
    }
    /// Transfer only after all newly materialized inspection caches are gone.
    pub fn finish(&mut self) -> InspectionPermits {
        self.destroy_decoder();
        std::mem::take(&mut self.permits)
    }
}
impl Drop for InspectionOwner<'_> {
    fn drop(&mut self) {
        // Also runs on every early Err, typed stop and unwind. Field destruction
        // (and hence Reservation refund) follows this explicit cache teardown.
        self.destroy_decoder();
    }
}

#[cfg(test)]
pub(super) mod probes {
    use super::EntityDecoder;
    use std::cell::RefCell;
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum Phase {
        ReachedPoints,
        BeforeDecoder,
        AfterDecoder,
    }
    type Observer = dyn for<'a, 'b> FnMut(Phase, Option<&'a EntityDecoder<'b>>);
    thread_local! { static OBSERVER: RefCell<Option<Box<Observer>>> = const { RefCell::new(None) }; }
    pub fn notify(phase: Phase, decoder: Option<&EntityDecoder<'_>>) {
        OBSERVER.with(|slot| {
            if let Some(observer) = slot.borrow_mut().as_mut() {
                observer(phase, decoder);
            }
        });
    }
    pub struct Guard;
    impl Drop for Guard {
        fn drop(&mut self) {
            OBSERVER.with(|slot| {
                slot.borrow_mut().take();
            });
        }
    }
    pub fn install(
        observer: impl for<'a, 'b> FnMut(Phase, Option<&'a EntityDecoder<'b>>) + 'static,
    ) -> Guard {
        OBSERVER.with(|slot| {
            assert!(slot.borrow().is_none());
            *slot.borrow_mut() = Some(Box::new(observer));
        });
        Guard
    }
}
