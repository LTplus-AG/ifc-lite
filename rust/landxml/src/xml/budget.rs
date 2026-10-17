/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! The one resource counter (C9a-2, #7784, D72/D73).
//!
//! Seventeen hand-written `checked_add` then `> max` copies guarded the
//! parsers' caps, each with its own message and, in one family, its own error
//! code. A [`Budget`] is that sequence once: reserve, and past the cap refuse
//! with `LimitExceeded` and `"<label> limit exceeded"`.

use super::{error, Result};
use crate::{LandXmlCancellation, LandXmlDiagnosticCode as Code};

/// A cap on one kind of resource, spent as the document is read.
#[derive(Clone, Debug)]
pub(crate) struct Budget {
    used: usize,
    max: usize,
    label: &'static str,
    refusal: Refusal,
}

#[derive(Clone, Copy, Debug)]
enum Refusal {
    /// `LimitExceeded`, `"<label> limit exceeded"`.
    Limit,
    /// `InputTooLarge`, `"input exceeds byte limit"`: the raw input is the
    /// caller's to size, so it keeps its own code.
    InputBytes,
}

impl Budget {
    pub(crate) fn new(max: usize, label: &'static str) -> Self {
        Self { used: 0, max, label, refusal: Refusal::Limit }
    }

    /// The cap on raw input bytes, which refuses as `InputTooLarge`.
    pub(crate) fn input_bytes(max: usize) -> Self {
        Self { used: 0, max, label: "input", refusal: Refusal::InputBytes }
    }

    /// Spend `amount`. Refuses, without spending, once the total would pass
    /// the cap or overflow.
    pub(crate) fn reserve(&mut self, amount: usize) -> Result<()> {
        match self.used.checked_add(amount) {
            Some(total) if total <= self.max => {
                self.used = total;
                Ok(())
            }
            _ => Err(match self.refusal {
                Refusal::Limit => error(Code::LimitExceeded, format!("{} limit exceeded", self.label)),
                Refusal::InputBytes => error(Code::InputTooLarge, "input exceeds byte limit"),
            }),
        }
    }

    /// [`Self::reserve`], naming the refusal differently. For one count that
    /// two record kinds spend (`CantStation` and `SpeedStation`), whose
    /// refusals were already worded apart.
    pub(crate) fn reserve_labelled(&mut self, amount: usize, label: &'static str) -> Result<()> {
        let own = std::mem::replace(&mut self.label, label);
        let reserved = self.reserve(amount);
        self.label = own;
        reserved
    }

    /// What has been spent.
    pub(crate) fn used(&self) -> usize {
        self.used
    }

    /// What is left to spend.
    pub(crate) fn remaining(&self) -> usize {
        self.max.saturating_sub(self.used)
    }

    /// Direct access to the spent count, for callees that predate `Budget`
    /// and still take a `&mut usize` (`terrain.rs`, C9d's).
    pub(crate) fn used_mut(&mut self) -> &mut usize {
        &mut self.used
    }
}

/// Cooperative cancellation: the one place a host's flag is read.
pub(crate) fn poll(cancelled: Option<&dyn LandXmlCancellation>) -> Result<()> {
    if cancelled.is_some_and(LandXmlCancellation::is_cancelled) {
        return Err(error(Code::Cancelled, "ingestion cancelled"));
    }
    Ok(())
}

/// The `work` budget of one parse, charged with a cancellation poll. Work is
/// events + attributes + text bytes, spent where an event enters a family
/// (`consume_event`, `start`, `text`) and nowhere in its record handlers.
pub(crate) struct Meter<'a> {
    work: Budget,
    cancelled: Option<&'a dyn LandXmlCancellation>,
}

impl<'a> Meter<'a> {
    pub(crate) fn new(max_work: usize, cancelled: Option<&'a dyn LandXmlCancellation>) -> Self {
        Self { work: Budget::new(max_work, "work"), cancelled }
    }

    pub(crate) fn charge(&mut self, amount: usize) -> Result<()> {
        poll(self.cancelled)?;
        self.work.reserve(amount)
    }

    /// See [`Budget::used_mut`].
    pub(crate) fn used_mut(&mut self) -> &mut usize {
        self.work.used_mut()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserve_refuses_past_the_cap_with_the_label_and_does_not_spend() {
        let mut budget = Budget::new(3, "point");
        budget.reserve(2).unwrap();
        let refusal = budget.reserve(2).unwrap_err();
        assert_eq!(refusal.code, Code::LimitExceeded);
        assert_eq!(refusal.message, "point limit exceeded");
        assert_eq!(budget.remaining(), 1);
        budget.reserve(1).unwrap();
        assert_eq!(budget.remaining(), 0);
        budget.reserve(0).unwrap();
    }

    #[test]
    fn reserve_refuses_on_overflow() {
        let mut budget = Budget::new(usize::MAX, "work");
        budget.reserve(usize::MAX).unwrap();
        assert_eq!(budget.reserve(1).unwrap_err().message, "work limit exceeded");
    }

    #[test]
    fn the_input_budget_keeps_its_own_code() {
        let refusal = Budget::input_bytes(1).reserve(2).unwrap_err();
        assert_eq!(refusal.code, Code::InputTooLarge);
        assert_eq!(refusal.message, "input exceeds byte limit");
    }

    #[test]
    fn a_meter_polls_cancellation_before_it_spends() {
        struct Cancelled;
        impl LandXmlCancellation for Cancelled {
            fn is_cancelled(&self) -> bool {
                true
            }
        }
        let mut meter = Meter::new(10, Some(&Cancelled));
        assert_eq!(meter.charge(1).unwrap_err().code, Code::Cancelled);
        assert_eq!(*meter.used_mut(), 0);
    }
}
