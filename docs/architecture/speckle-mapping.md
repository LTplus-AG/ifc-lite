# Speckle → IFC mapping (v1)

`speckle.receive` (`packages/flow-nodes/src/speckle-receive-node.ts`) reads one
Speckle model version and writes IFC elements into an existing model. This page
is the contract: what is mapped, how, and what is refused. The code lives in
`packages/flow-nodes/src/speckle/`.

## Protocol

All requests go through `coreNetworkRequest` (`@ifc-lite/sandbox`) with the
host's `networkGrants` and `networkTransport`: https only, exact-host grants,
no redirects, a per-response byte cap. The node never calls `fetch` itself.

| Step | Request | Notes |
|---|---|---|
| Version → root object | `POST /graphql` | `project(id).version(id).referencedObject` for a pinned version, `project(id).model(id).versions(limit: 1)` for the latest. Skipped for a `/streams/<id>/objects/<id>` URL. |
| Root object | `GET /objects/<project>/<object>/single` | The root alone. |
| Everything it references | `POST /api/getobjects/<project>` with `{"objects": "<JSON array of ids>"}` | Answered as one `id\tjson` line per object, in batches of 500. |

The walk is lazy and iterative: each round fetches only the ids the previous
round referenced and has not seen. Values under `displayValue` /
`displayMesh` are never followed, so display meshes and their data chunks
(most of a commit's bytes) are never downloaded. A visited set bounds cycles and
revisits; `maxObjects` bounds the total and fails the receive loudly when hit.
A response that exceeds `maxBytes`, an id the server does not return, a 401/403
and a GraphQL error each fail the receive with a message that names the cause.

Authentication is `Authorization: Bearer <token>`, from the `token` param,
which should be `{{secret:NAME}}` (see [Flow graphs](../guide/flow.md)).

The protocol handling is adapted, as new code, from the author's own
ifc-ai-rendering project (`lib/speckle-loader.ts`), at the author's request.
Unlike that loader, it reads the correct `getobjects` request body (a
JSON-encoded id array), resolves a pinned version by id rather than among
the latest versions only, and does not fall back to unbounded requests.

## Traversal

From the root, containers are walked in document order: any
`Speckle.Core.Models.Collections.Collection`, `Objects.Organization.*` or plain
`Base`, through `elements` and any `@`-prefixed dynamic member. A mapped
element's own `elements` (hosted elements, the layers of a stacked wall) are
walked too. Any other object reached this way is refused as `unmapped-type`.

## Elements

The type test is on the `speckle_type` inheritance chain, so every Revit
subclass of a base type maps the same way.

| Speckle base type | IFC | Written via | Requires |
|---|---|---|---|
| `Objects.BuiltElements.Wall` | `IfcWall` | `bim.store.addWall` | a straight, horizontal `baseLine` (`Objects.Geometry.Line`), `height`, parameter `WALL_ATTR_WIDTH_PARAM` |
| `Objects.BuiltElements.Floor` | `IfcSlab` | `bim.store.addSlab` (polygon) | a closed, horizontal `outline` of straight segments, no `voids`, zero `slope`, parameter `FLOOR_ATTR_THICKNESS_PARAM` |
| `Objects.BuiltElements.Roof` | `IfcRoof` | `bim.store.addRoof` (polygon) | same as a floor, parameter `ROOF_ATTR_THICKNESS_PARAM`; extrusion roofs are refused |
| `Objects.BuiltElements.Column` | `IfcColumn` | `bim.store.addColumn` | a vertical `baseLine`, zero `rotation`, parameters `b` and `h` |
| `Objects.BuiltElements.Beam` | `IfcBeam` | `bim.store.addBeam` | a straight `baseLine`, parameters `b` and `h` |

Geometry details:

- **Units.** Coordinates are converted from each point's own `units`, falling
  back to the element's, to metres (the unit the store builders take; they
  emit into the file's native length unit). An element without a length unit
  is refused.
- **Levels.** Every element goes into the one storey wired to the node's
  `storey` input. Z is made relative to the element's own Speckle `level`
  elevation, so a Level 2 beam sits at its height above Level 2. Levels are
  not created. Use the `level` param to receive one level per storey.
- **Floors** hang below their outline (Revit draws a floor's outline at its
  top face); **roofs** sit on theirs.
- **Beams** use the location line as the section centre. Revit's default
  z-justification puts the line at the top of the beam, so a beam can sit up
  to half its depth high. This is a known v1 offset.
- **Bodies are parametric.** `bim.store` has no tessellated-body writer, so
  `Objects.Geometry.Mesh` display values are NOT written. The body is rebuilt
  from the location and dimensions above, and the meshes are reported
  (`display-meshes`).

Identity: `Name` is `"<family>: <type>"`, `ObjectType` the type, and `Tag` the
Revit element id. The GlobalId is
`trackingGuid("speckle:<server origin>/<project>", applicationId)`, with the
Speckle id used when there is no application id. The server's normalised
origin is part of the key, so the same project id on two servers never
collides. The target storey is not part of it. Receiving a later version
therefore replaces the elements an earlier receive wrote; it does not
duplicate them. Elements that vanished from the newer version are not removed
(v1).

Replacing is write-first. The new element is written beside the old one, and
the old one is removed only once that write succeeded. If the IFC builder
rejects the new version, the earlier element stays in the model and the
refusal is `write-failed-kept-previous`. Replacing needs `model.delete`, which
is checked only when an earlier element exists.

Capabilities, as exact strings: `model.create`, `model.delete`,
`model.mutate:Speckle_Source`, `model.mutate:Speckle_TypeParameters`,
`model.mutate:Speckle_InstanceParameters`, and `network.fetch:<host>` for the
server.

## Properties

| Property set | Contents |
|---|---|
| `Speckle_Source` | `SpeckleId`, `SpeckleType` (full chain), `ApplicationId`, `Category`, `Family`, `Type`, `ElementId`, `Level`, `SourceUnits` |
| `Speckle_TypeParameters` | Revit type parameters, by display name |
| `Speckle_InstanceParameters` | Revit instance parameters, by display name |

Both parameter shapes the Revit connector has written are read: the current
`properties["Type Parameters" / "Instance Parameters"][group][name]` and the
older `parameters[internalName]` map (`isTypeParameter` decides the set).
Lengths, areas and volumes are converted to m, m² and m³ from either unit
vocabulary (`mm`, `Centimeters`, `Square feet`, `m³`, …). Every other unit is
carried as authored. A dimension the mapping needs (width, thickness, `b`,
`h`) is read only if it was actually converted as a length. A compound or
unknown label such as `Feet and fractional inches` or `Meters and
centimeters`, or no unit at all, refuses the element as `missing-dimension`,
naming the unit. It is never read as metres. A repeated display name is kept, qualified by its
internal name. Entries with no scalar value (compound structure layers) are
counted as `non-parameter-entries`.

## Refusals

Nothing is dropped silently. The node's `refusals` output lists, per Speckle
type and reason, a count, a message, and up to five example object ids. Each
refusal is also logged as a warning.

| Reason | Meaning |
|---|---|
| `unmapped-type` | The type has no v1 mapping (generic models, curtain panels, grids, topography, loose geometry, v3 `DataObject`s). |
| `geometry` | Mapped type, but the geometry cannot be reproduced: curved/arc location, non-horizontal wall line, sloped or gapped outline, slanted or rotated column, extrusion roof. |
| `missing-dimension` | A required height, thickness or section parameter is absent, or its unit is not a supported length unit. |
| `openings` | A floor or roof with voids, which a v1 extrusion would fill in. |
| `no-units` | The element has no length unit. |
| `other-level` | Excluded by the `level` param. |
| `write-failed` | The IFC builder rejected the mapped parameters. |
| `write-failed-kept-previous` | On a re-receive, the builder rejected the new version, so the element from the earlier receive was kept. |
| `display-meshes` | Display meshes on written elements (under `displayValue`, `@displayValue`, `displayMesh` or `@displayMesh`), not carried. |
| `non-parameter-entries` | Property entries with no scalar value, not carried. |

## Out of scope (v1)

- Tessellated bodies from display meshes (needs a store-level tessellated
  writer).
- Speckle v3 (`Objects.Data.DataObject` / `RevitObject`) objects, doors,
  windows, openings, curtain systems, stairs and MEP. All of them are refused
  by name.
- Creating storeys from Speckle levels, and removing elements a newer version
  deleted.

## Tests

`packages/flow-nodes/src/__fixtures__/speckle/` holds a hand-authored corpus:
a small Revit-style commit with walls, floors, a column, a beam, a roof and
display meshes. Its README describes it. `speckle-receive.test.ts` replays
it through an injected transport and asserts the created elements, SI
dimensions, property sets, refusals, the unfetched meshes, and that an
ungranted host is refused before any request.
`packages/cli/src/commands/flow-speckle.test.ts` runs the same corpus through
`ifc-lite flow run` into a real model and reads the exported IFC back.
