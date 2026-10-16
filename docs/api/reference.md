# Search the TypeScript API

[Open the searchable API reference](generated/index.html).

The reference is generated from every published package declaration entry point,
including subpath imports such as `@ifc-lite/sdk/headless`. Search for `openModel`,
`IfcQuery`, `GeometryProcessor`, an IFC entity name, or a method. Pages show
signatures, parameter and return types, JSDoc, and inheritance. Private members
and declarations marked `@internal` are omitted.

Start with the [quickstart](../guide/quickstart.md) for complete tasks.
For package selection, use the [TypeScript package guide](typescript.md).

The reference follows the source revision used to build this documentation.
Packages have independent versions; consult the README and changelog of the
release you installed.

## Generate locally

```bash
pnpm install --frozen-lockfile
pnpm docs:api
pnpm docs:serve
```

`docs:api` builds package declarations through root Turbo, then generates the
reference and search assets with TypeDoc. The API compatibility snapshot and
reference share one declaration-entry resolver. Output in `docs/api/generated/`
is regenerated during CI and the documentation deployment; edit source JSDoc
or types to change it.
