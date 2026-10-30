// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

// #8007: FirstChain has no work meter, even when an internal counter cannot
// increment. A large finite allowance would incorrectly refuse this fixture.
#[test]
fn first_chain_neither_checks_nor_increments_expansion_meters() {
    #[derive(Default)]
    struct Trace {
        events: Vec<(char, u32)>,
    }
    impl WalkVisitor for Trace {
        fn item(&mut self, item: &DecodedEntity, at: &WalkCtx<'_>, _: &mut EntityDecoder) -> Flow {
            assert_eq!(at.path.len(), 2);
            self.events.push(('i', item.id));
            Flow::Continue
        }
        fn enter_map(
            &mut self,
            level: &MappedLevel,
            _: &WalkCtx<'_>,
            _: &mut EntityDecoder,
        ) -> Flow {
            self.events.push(('e', level.item.id));
            Flow::Continue
        }
        fn leave_map(&mut self, level: &MappedLevel) {
            self.events.push(('l', level.item.id));
        }
        fn refused(&mut self, _: &DecodedEntity, why: WalkRefusal, _: &WalkCtx<'_>) {
            panic!("unmetered chain refused: {why:?}");
        }
    }
    let model = "#10=IFCMAPPEDITEM(#20,$);#20=IFCREPRESENTATIONMAP($,#30);\
        #30=IFCSHAPEREPRESENTATION($,'Body','Brep',(#40));\
        #40=IFCMAPPEDITEM(#50,$);#50=IFCREPRESENTATIONMAP($,#60);\
        #60=IFCSHAPEREPRESENTATION($,'Body','Brep',(#1));\
        #1=IFCCARTESIANPOINT((0.,0.,0.));";
    let mut decoder = EntityDecoder::new(model);
    let root = decoder.decode_by_id(10).unwrap();
    let mut trace = Trace::default();
    let mut run = Run {
        visitor: &mut trace,
        element: None,
        path: smallvec::SmallVec::new(),
        levels: u32::MAX,
        items: u32::MAX,
    };
    let walk = RepresentationWalk {
        select: Select::Any,
        nested: NestedMaps::FirstChain { max_depth: 2 },
    };
    assert_eq!(
        walk.execute(&mut run, engine::Task::Enter(root), &mut decoder),
        Flow::Continue
    );
    assert_eq!((run.levels, run.items), (u32::MAX, u32::MAX));
    assert!(run.path.is_empty());
    assert_eq!(
        trace.events,
        [('e', 10), ('e', 40), ('i', 1), ('l', 40), ('l', 10)]
    );
}

#[test]
fn issue_7781_flat_prefix_and_mapped_suffix_preserve_stop_order_and_scopes() {
    #[derive(Default)]
    struct Trace {
        stop: Option<u32>,
        events: Vec<(char, u32)>,
    }
    impl WalkVisitor for Trace {
        fn item(&mut self, item: &DecodedEntity, _: &WalkCtx<'_>, _: &mut EntityDecoder) -> Flow {
            self.events.push(('i', item.id));
            if self.stop == Some(item.id) {
                Flow::Stop
            } else {
                Flow::Continue
            }
        }
        fn enter_map(
            &mut self,
            level: &MappedLevel,
            _: &WalkCtx<'_>,
            _: &mut EntityDecoder,
        ) -> Flow {
            self.events.push(('e', level.item.id));
            Flow::Continue
        }
        fn leave_map(&mut self, level: &MappedLevel) {
            self.events.push(('l', level.item.id));
        }
        fn refused(&mut self, _: &DecodedEntity, why: WalkRefusal, _: &WalkCtx<'_>) {
            panic!("valid four-member walk refused: {why:?}");
        }
    }
    let model = "#100=IFCREPRESENTATIONMAP($,#101);\
        #101=IFCSHAPEREPRESENTATION($,'Body','Brep',(#1,#10,#2));\
        #10=IFCMAPPEDITEM(#20,$);#20=IFCREPRESENTATIONMAP($,#30);\
        #30=IFCSHAPEREPRESENTATION($,'Body','Brep',(#3));\
        #1=IFCCARTESIANPOINT((1.,0.,0.));#2=IFCCARTESIANPOINT((2.,0.,0.));\
        #3=IFCCARTESIANPOINT((3.,0.,0.));";
    for stop in [None, Some(1), Some(3)] {
        let mut decoder = EntityDecoder::new(model);
        let root = decoder.decode_by_id(100).unwrap();
        let mut trace = Trace {
            stop,
            ..Trace::default()
        };
        RepresentationWalk {
            select: Select::Any,
            nested: NestedMaps::Expand {
                max_depth: 32,
                max_levels: 4,
            },
        }
        .map(&root, &mut decoder, &mut trace)
        .unwrap();
        let expected = match stop {
            Some(1) => vec![('i', 1)],
            Some(3) => vec![('i', 1), ('e', 10), ('i', 3), ('l', 10)],
            _ => vec![('i', 1), ('e', 10), ('i', 3), ('l', 10), ('i', 2)],
        };
        assert_eq!(trace.events, expected);
        if stop == Some(1) {
            assert!(
                decoder.get_cached(20).is_none(),
                "stopped prefix reached its mapped suffix"
            );
        }
    }
}
