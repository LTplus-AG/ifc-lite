# Hierarchy row selection (#5885)

Captured by `PLAYWRIGHT_PORT=46327 pnpm test:e2e tests/e2e/hierarchy-row-selection.e2e.spec.ts` in headed Chrome after a production viewer build. The spec loads the authored `building-architecture.ifc` sample through the viewer URL and adds its authored `building-architecture-rev-b.ifc` revision through the normal file input. It selects a wall class and then a unified storey, framing the current selection before each capture.

- [One model, wall class selected](one-model-class.png): the class row and its four selected wall instances are visible, while the house remains visible. The spec verifies no Advanced Filter or isolation state changed.
- [Two models, unified storey selected](two-model-storey.png): the unified storey row is selected with both model entries visible. The spec verifies click alone did not activate Solo or change Advanced Filter; Solo is then exercised through its explicit row action. The viewer reports that it could not align the revision sample, so it displays the revision in its local frame; the warning is retained in the capture.

The browser run passed 1/1. The screenshot evidence complements the store-state assertions in the spec and the focused mounted tests for modifier keys and context-menu actions.
