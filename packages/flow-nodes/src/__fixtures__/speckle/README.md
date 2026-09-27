# Speckle receive corpus (hand-authored)

A small Revit-style Speckle commit used to test `speckle.receive` without a
live server. **Nothing here was recorded from a real Speckle server**: every
object was written by hand from Speckle's documented object model and the
shape the Revit (v2) connector emits (checked against the serialization test
data in `specklesystems/speckle-sharp-sdk` and the `specklepy` unit tables).

| File | What it stands in for |
|---|---|
| `objects.json` | The project's object store: the root collection first, then every object it references, including display meshes and their `DataChunk`s. |
| `graphql-latest.json` | The `POST /graphql` answer for a model's latest version. |
| `graphql-version.json` | The `POST /graphql` answer for one pinned version (`a1b2c3d4e5`). |

`src/__tests__/speckle-server.ts` serves these through an injected
`FetchTransport`, answering `/graphql`, `/objects/<project>/<id>/single` and
`/api/getobjects/<project>` (`id\tjson` lines) as a Speckle server would.

## Contents (units `mm`)

- Level 1 (elevation 0): two straight `RevitWall`s (Width 200), one curved
  `RevitWall` (an `Arc` location, refused), one `RevitFloor` (250 thick, with
  two compound-structure layer entries), one `RevitColumn` (400 x 400), one
  `RevitElement` (a generic model, no v1 mapping).
- Level 2 (elevation 3000): one `RevitBeam` (300 x 600, written with the
  connector's older `parameters` map), one flat `RevitFootprintRoof` (300
  thick, outline as a chunked `Polyline`), one `RevitFloor` with a void
  (refused).

Object ids are deterministic stand-ins (MD5 of a label), not Speckle's
content hashes; `__closure` tables are computed from the references so the
graph is self-consistent.
