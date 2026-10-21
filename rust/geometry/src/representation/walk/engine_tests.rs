// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

// #8007: FirstChain has no work meter, even when an internal counter cannot
// increment. A large finite allowance would incorrectly refuse this fixture.
#[test]
fn first_chain_neither_checks_nor_increments_expansion_meters() {
    #[derive(Default)]
    struct Trace { events: Vec<(char, u32)> }
    impl WalkVisitor for Trace {
        fn item(&mut self, item: &DecodedEntity, at: &WalkCtx<'_>, _: &mut EntityDecoder) -> Flow {
            assert_eq!(at.path.len(), 2);
            self.events.push(('i', item.id));
            Flow::Continue
        }
        fn enter_map(&mut self, level: &MappedLevel, _: &WalkCtx<'_>, _: &mut EntityDecoder) -> Flow {
            self.events.push(('e', level.item.id));
            Flow::Continue
        }
        fn leave_map(&mut self, level: &MappedLevel) { self.events.push(('l', level.item.id)); }
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
    let mut run = Run { visitor: &mut trace, element: None, path: Vec::new(),
        levels: u32::MAX, items: u32::MAX };
    let walk = RepresentationWalk { select: Select::Any,
        nested: NestedMaps::FirstChain { max_depth: 2 } };
    assert_eq!(walk.execute(&mut run, engine::Task::Enter(root), &mut decoder), Flow::Continue);
    assert_eq!((run.levels, run.items), (u32::MAX, u32::MAX));
    assert!(run.path.is_empty());
    assert_eq!(trace.events, [('e', 10), ('e', 40), ('i', 1), ('l', 40), ('l', 10)]);
}
