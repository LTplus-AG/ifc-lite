// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Memoised `IfcMaterial*SetUsage` resolution (SERVER-5, #7673).
//!
//! A usage's attribute 0 names the next entity, so following usages is a walk
//! over file-supplied references. Per association it is an iterative loop with
//! a visited set, so cycles and long chains cannot overflow the stack. That
//! alone still costs `associations × chain length`: 40k associations naming
//! the head of one 40k-usage chain took 244 s. The terminal a usage resolves
//! to is a pure function of its id, so one memo shared by every association
//! (AGENTS.md "Bounding walks", global / memoising scope) records it for every
//! usage on the path. Each usage is then decoded about once per file, plus at
//! most one racing walk per pool worker.

use ifc_lite_core::{DecodedEntity, EntityDecoder};
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, PoisonError};

/// Usage id → the first non-usage entity its chain reaches, or `None` when
/// the chain is cyclic, dangling, or unreadable. Shared across associations.
#[derive(Default)]
pub(super) struct UsageTerminals {
    memo: Mutex<HashMap<u32, Option<u32>>>,
    /// Usage hops actually decoded, so a test can pin the bound.
    #[cfg(test)]
    hops: std::sync::atomic::AtomicUsize,
}

impl UsageTerminals {
    /// Follow usages from `id` to the first entity that is not a usage and
    /// return its id. `usage_target` returns `Some(attribute 0)` for a usage
    /// entity and `None` for anything else.
    pub(super) fn terminal(
        &self,
        decoder: &mut EntityDecoder,
        id: u32,
        usage_target: impl Fn(&DecodedEntity) -> Option<Option<u32>>,
    ) -> Option<u32> {
        let mut path = Vec::new();
        let mut on_path = HashSet::new();
        let mut current = id;
        let terminal = loop {
            if let Some(&known) = self.lock().get(&current) {
                break known;
            }
            if !on_path.insert(current) {
                break None; // A cycle: every usage on it resolves to nothing.
            }
            #[cfg(test)]
            self.hops.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let Ok(entity) = decoder.decode_by_id(current) else {
                break None;
            };
            match usage_target(&entity) {
                None => break Some(current),
                Some(next) => {
                    path.push(current);
                    match next {
                        Some(next) => current = next,
                        None => break None,
                    }
                }
            }
        };
        let mut memo = self.lock();
        for usage in path {
            memo.insert(usage, terminal);
        }
        terminal
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<u32, Option<u32>>> {
        // The map only ever holds complete entries, so a poisoned lock is safe to reuse.
        self.memo.lock().unwrap_or_else(PoisonError::into_inner)
    }

    #[cfg(test)]
    pub(super) fn hops(&self) -> usize {
        self.hops.load(std::sync::atomic::Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::super::materials::usage_target;
    use super::*;

    const CHAIN_LEN: u32 = 20_000;

    /// A `CHAIN_LEN`-long usage chain #1000.. ending in layer set #41, a
    /// self-referencing usage #10 and a mutual cycle #12 <-> #13.
    fn chain_file() -> String {
        let mut data = String::from(
            "#10=IFCMATERIALLAYERSETUSAGE(#10,.AXIS2.,.POSITIVE.,0.,$);
#12=IFCMATERIALLAYERSETUSAGE(#13,.AXIS2.,.POSITIVE.,0.,$);
#13=IFCMATERIALPROFILESETUSAGE(#12,$,$);
#41=IFCMATERIALLAYERSET((#42),'Set',$);
#42=IFCMATERIALLAYER(#43,200.,.F.,'Core',$,$,$);
#43=IFCMATERIAL('Concrete',$,$);
",
        );
        for i in 0..CHAIN_LEN {
            let id = 1000 + i;
            let next = if i + 1 == CHAIN_LEN { 41 } else { id + 1 };
            data.push_str(&format!("#{id}=IFCMATERIALLAYERSETUSAGE(#{next},.AXIS2.,.POSITIVE.,0.,$);\n"));
        }
        format!("ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n{data}ENDSEC;\nEND-ISO-10303-21;\n")
    }

    /// The bound itself: `CHAIN_LEN` associations naming the chain's head, then
    /// one naming each usage on it, decode each usage once in total. Without
    /// the memo the second lookup alone re-walks the whole chain, and this
    /// fails on it instead of running `CHAIN_LEN²` hops.
    #[test]
    fn many_associations_over_one_long_usage_chain_decode_each_usage_once_server_5() {
        let content = chain_file();
        let mut decoder = EntityDecoder::new(content.as_bytes());
        let usages = UsageTerminals::default();
        let bound = CHAIN_LEN as usize + 1; // every usage, plus the set
        let heads = std::iter::repeat_n(1000, CHAIN_LEN as usize);
        for start in heads.chain(1000..1000 + CHAIN_LEN) {
            assert_eq!(usages.terminal(&mut decoder, start, usage_target), Some(41));
            assert!(usages.hops() <= bound, "{} hops after resolving #{start}, bound {bound}", usages.hops());
        }
    }

    #[test]
    fn cycles_resolve_to_nothing_and_stay_memoised() {
        let content = chain_file();
        let mut decoder = EntityDecoder::new(content.as_bytes());
        let usages = UsageTerminals::default();
        for start in [10, 12, 13] {
            assert_eq!(usages.terminal(&mut decoder, start, usage_target), None);
        }
        let hops = usages.hops();
        for start in [10, 12, 13] {
            assert_eq!(usages.terminal(&mut decoder, start, usage_target), None);
        }
        assert_eq!(usages.hops(), hops, "a cycle is resolved once, then memoised");
        assert_eq!(usages.terminal(&mut decoder, 43, usage_target), Some(43), "a non-usage is its own terminal");
    }
}
