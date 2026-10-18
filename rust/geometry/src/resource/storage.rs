// SPDX-License-Identifier: MPL-2.0
//! Checked backing admission for accumulating frame/occurrence header vectors.
use super::{Cost, ProgramStop, Reservation};

#[cfg(test)]
thread_local! { static RESERVE_EVENTS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) }; }

/// Reserve before push; caller moves/retains this permit with the storage owner.
/// Replaced old backing remains conservatively charged until owner destruction.
/// Allocator rounding and bookkeeping overhead remain outside this accounting.
pub(crate) fn reserve_headers<T>(
    values: &mut Vec<T>,
    additional: usize,
) -> Result<Reservation, ProgramStop> {
    super::check_current()?;
    if !super::is_active() {
        return Ok(Reservation::empty());
    }
    let length = values
        .len()
        .checked_add(additional)
        .ok_or_else(super::overflow)?;
    let width = std::mem::size_of::<T>();
    let backing = length.checked_mul(width).ok_or_else(super::overflow)?;
    if backing > isize::MAX as usize {
        return Err(super::overflow());
    }
    let growth = values.capacity() < length;
    let copy_bytes = if growth {
        values
            .len()
            .checked_mul(width)
            .ok_or_else(super::overflow)? as u64
    } else {
        0
    };
    let work = u64::try_from(additional)
        .map_err(|_| super::overflow())?
        .checked_add(if growth { values.len() as u64 } else { 0 })
        .ok_or_else(super::overflow)?;
    let permit = super::charge(Cost {
        work,
        copy_bytes,
        live_bytes: if growth { backing as u64 } else { 0 },
        ..Cost::default()
    })?;
    #[cfg(test)]
    RESERVE_EVENTS.with(|events| events.set(events.get() + 1));
    values
        .try_reserve_exact(additional)
        .map_err(|_| super::allocation_failure())?;
    Ok(permit)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resource::{ExecutionAccount, ExecutionPolicy, ResourceLimits};

    #[test]
    fn zero_residency_refuses_header_growth_before_reservation_event() {
        let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits {
            live_bytes: Some(0),
            ..ResourceLimits::default()
        }));
        let mut headers = Vec::<[u64; 4]>::new();
        RESERVE_EVENTS.with(|events| events.set(0));
        account.scope(|| assert!(reserve_headers(&mut headers, 1).is_err()));
        RESERVE_EVENTS.with(|events| assert_eq!(events.get(), 0));
        assert_eq!(headers.capacity(), 0);
    }

    #[test]
    fn header_relocation_charges_real_old_bytes_and_retains_order() {
        let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
        let mut headers = Vec::<u64>::new();
        account.scope(|| {
            reserve_headers(&mut headers, 1).unwrap().retain();
            headers.push(7);
            let before = account.usage();
            let additional = headers.capacity();
            let permit = reserve_headers(&mut headers, additional).unwrap();
            headers.extend(std::iter::repeat_n(11, additional));
            assert_eq!(headers[0], 7);
            assert_eq!(account.usage().copy_bytes - before.copy_bytes, 8);
            assert_eq!(headers.len(), additional + 1);
            drop((headers, permit));
        });
    }
}
