// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit-test exact-budget configuration, isolated from ordinary geometry readers.
//! Setters affect the next begin boundary, just like the production setters.
use super::*;

#[derive(Clone, Copy)]
pub(super) struct Configured {
    cap: Option<u64>,
    element_cap: Option<u64>,
}
impl Configured {
    pub(super) fn cap(self) -> Option<u64> { self.cap }
    pub(super) fn element_cap(self) -> Option<u64> { self.element_cap }
}
thread_local! {
    static CONFIGURED: Cell<Option<Configured>> = const { Cell::new(None) };
}
pub(super) fn configured() -> Option<Configured> { CONFIGURED.with(Cell::get) }

/// Restores configured profiles and every active budget on drop, including unwind.
/// The saved ElementScope makes this guard !Send without opening an element.
#[must_use = "keep the profile alive for the budgeted test"]
pub(crate) struct TestProfile {
    previous: Option<Configured>,
    _active: ElementScope,
}
impl TestProfile {
    pub(crate) fn new() -> Self {
        let profile = Configured { cap: cap(), element_cap: element_cap() };
        let scope = Self {
            previous: configured(),
            _active: ElementScope {
                incidence: incidence_work::snapshot(),
                count: COUNT.with(Cell::get),
                op_cap: OP_CAP.with(Cell::get),
                elem_count: ELEM_COUNT.with(Cell::get),
                elem_cap: ELEM_CAP.with(Cell::get),
                _thread_bound: PhantomData,
            },
        };
        CONFIGURED.with(|c| c.set(Some(profile)));
        scope
    }
    pub(crate) fn set_cap(&self, cap: Option<u64>) {
        CONFIGURED.with(|c| {
            let mut profile = c.get().expect("an exact-budget test profile is active");
            profile.cap = cap.filter(|&n| n != 0);
            c.set(Some(profile));
        });
    }
    pub(crate) fn set_element_cap(&self, cap: Option<u64>) {
        CONFIGURED.with(|c| {
            let mut profile = c.get().expect("an exact-budget test profile is active");
            profile.element_cap = cap.filter(|&n| n != 0);
            c.set(Some(profile));
        });
    }
}
impl Drop for TestProfile {
    fn drop(&mut self) { CONFIGURED.with(|c| c.set(self.previous)); }
}
