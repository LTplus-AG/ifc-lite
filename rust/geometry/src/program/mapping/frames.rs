// SPDX-License-Identifier: MPL-2.0
//! Pure frame staging with explicit, exact backing/work admission. A poll moves
//! the existing Vec and at most two pending pushes into one resource request.
use crate::Result;
use crate::resource::{self, Cost};

pub(super) struct Frames<T> {
    values: Vec<T>, pushes: [Option<T>; 2], admitted: Option<T>, initial: bool,
}
pub(super) enum Next<T> { Admission(Admission<T>), Frame(T), Complete }
pub(super) struct Admission<T> {
    values: Vec<T>, pushes: [Option<T>; 2], frame: Option<T>, initial: bool, occurrence: bool,
}
pub(super) struct Admitted<T> { values: Vec<T>, frame: Option<T> }
impl<T> Frames<T> {
    pub(super) fn new(frame: T) -> Self {
        Self { values:Vec::new(), pushes:[Some(frame),None], admitted:None, initial:true }
    }
    pub(super) fn push(&mut self, frame: T) {
        let slot = self.pushes.iter_mut().find(|slot| slot.is_none()).expect("at most two staged mapping frames");
        *slot = Some(frame);
    }
    pub(super) fn pending_admission(&mut self) -> Option<Admission<T>> {
        if !self.initial && !self.pushes.iter().any(Option::is_some) { return None }
        Some(Admission { values:std::mem::take(&mut self.values),
            pushes:std::mem::replace(&mut self.pushes,[None,None]), frame:None,
            initial:std::mem::take(&mut self.initial), occurrence:false })
    }
    pub(super) fn pop_control(&mut self) -> Option<T> { self.values.pop() }
    pub(super) fn next(&mut self, occurrence: impl FnOnce(&T) -> bool) -> Next<T> {
        if let Some(admission)=self.pending_admission() {return Next::Admission(admission)}
        if let Some(frame) = self.admitted.take() { return Next::Frame(frame) }
        match self.values.pop() {
            Some(frame) => {
                let occurrence = occurrence(&frame);
                Next::Admission(Admission { values:std::mem::take(&mut self.values), pushes:[None,None],
                    frame:Some(frame), initial:false, occurrence })
            }
            None => Next::Complete,
        }
    }
    pub(super) fn accept(&mut self, admitted: Result<Admitted<T>>) -> Result<()> {
        let admitted = admitted?;
        self.values = admitted.values; self.admitted = admitted.frame; Ok(())
    }
    pub(super) fn clear(&mut self) {
        self.values.clear(); self.pushes=[None,None]; self.admitted=None; self.initial=false;
    }
}
impl<T> Admission<T> {
    pub(super) fn execute(mut self) -> Result<Admitted<T>> {
        resource::check_current()?;
        if self.initial || self.frame.is_some() { resource::charge(Cost { work:1, ..Default::default() })?.retain(); }
        if self.occurrence { resource::charge(Cost { occurrences:1, ..Default::default() })?.retain(); }
        for frame in self.pushes.into_iter().flatten() {
            resource::reserve_headers(&mut self.values,1)?.retain(); self.values.push(frame);
        }
        Ok(Admitted { values:self.values, frame:self.frame })
    }
}
