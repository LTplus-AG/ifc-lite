# PDF vector annotation through a fresh collaboration room

Captured on 2026-09-12 by
`tests/e2e/collab-pdf-vector-room.e2e.spec.ts` with Chromium
153.0.8010.36, the built viewer, and a disposable signed local relay.

The browser journey loads `tests/models/various/issue-604-door.ifc`, creates a
two-colour PDF vector `IfcAnnotation` through the Appearance UI, shares the
model, closes the owner context, and joins from a fresh context using the
signed room URL. It then proves the joined annotation:

- resolves to its current room model and express id;
- hydrates both renderer parts with the original red/green colours and two
  triangles per part;
- is selected through an actual canvas pointer event;
- renders as a native red symbolic fill in the 2D section panel;
- survives the viewer's IFC export and a clean-context reopen with the same
  identity, parts, colours, triangles, and native 2D fill.

The two source polygons overlap in plan, so the red polygon occludes the green
one in the 2D canvas. The behavioral test checks both symbolic fill records at
the parser boundary and both coloured renderer parts before and after reopen;
the browser pixel oracle checks the visible red fill.

`browser-run.json` contains the exact observations. The screenshots show the
fresh-room selected identity, the fresh-room native 2D fill, and the reopened
export. The signed URL and token are deliberately not recorded.
