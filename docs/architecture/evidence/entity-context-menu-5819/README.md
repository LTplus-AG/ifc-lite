# Entity context menu (#5819)

The [browser capture](./authored-ifc-menu.png) shows the Radix menu opened for
an `IfcWall` in the authored `apps/viewer/public/samples/building-architecture.ifc`
model. The model loaded with geometry before the menu was opened through the
same resolved entity ID used by viewport picking.

`tests/e2e/entity-context-menu.e2e.spec.ts` checks the rendered action list,
keyboard navigation into and out of the Duplicate submenu, Escape focus
return, shortcut hint contrast, and the Hide action's effect on viewer state.
The existing mounted context-menu action suites cover export, frame selection,
same-storey selection, and federation resolution.
