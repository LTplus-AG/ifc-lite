# @ifc-lite/source-fixture

An in-memory, network-free `FileSourceProvider` (from `@ifc-lite/plugin-api`
v2) plus a reusable conformance test kit. This package is test
infrastructure, not a shipped feature — it exists so the host, the browser
source-picker UI, sync, persistence, and every provider error path get real
CI coverage without depending on a tenant, credentials, or fixture files on
disk. It is `"private": true` and is deliberately excluded from the published
API surface (`scripts/api-surface.json`).

## The fixture provider

`createFixtureSourceProvider(options)` builds a fully-conformant provider
over a plain declarative world: projects -> containers -> files -> revisions
-> deterministic bytes.

```ts
import { createFixtureContext, createFixtureSourceProvider } from '@ifc-lite/source-fixture';

const provider = createFixtureSourceProvider({
  world: {
    projects: [
      {
        id: 'proj-1',
        name: 'Alpha Tower',
        containers: [
          { id: 'root', name: 'Design' },
          { id: 'sub', name: 'Structural', parentId: 'root' },
        ],
        files: [
          {
            id: 'model',
            name: 'model.ifc',
            containerId: 'sub',
            revisions: [
              { id: 'rev2', content: 'the newer bytes' },
              { id: 'rev1', content: 'the older bytes' },
            ],
          },
        ],
      },
    ],
  },
});

const ctx = createFixtureContext();
await provider.listProjects(ctx);
```

Everything is configurable at construction:

- **`containerListing`**: `'direct-children'` (default) or `'flat-subtree'` —
  drives `listContainers` from the *same* declared data, so a test can flip
  modes without restating the world.
- **`listFilesIsRecursive`**: whether `listFiles` sweeps descendant
  containers too.
- **`pageSize`**: the server-side page cap every listing call clamps to
  (default 25) — set it small (or pass a small `limit` per call) to force
  multi-page pagination deterministically.
- **`auth: 'interactive'`**: adds a real `SourceAuth` (backed by
  `ctx.storage`, no popup, no IdP) that gates every data method with a 401
  until `signIn` is called — exercises a host's sign-in flow end-to-end.
- **`capabilities`**: toggle `revisionHistory` / `changeDetection` / `search`
  independently; the matching optional method (`listRevisions` /
  `watchRevisions` / `searchFiles`) is present on the returned object if and
  only if its flag is `true`.
- **`failures`**: make any method throw, return a 429-shaped rate-limit
  error, hang until the caller's `AbortSignal` fires, or truncate a page
  below what its own cursor math promises. Adjustable after construction too,
  via `provider.fixture.setFailure(method, failure | undefined)`.

Revision content is deterministic and exact — `download()` returns precisely
the bytes declared for that revision, so a sync test can assert bytes
actually changed between two revisions without guessing at encoding.

## The conformance kit

`@ifc-lite/source-fixture/conformance` exports `runConformanceSuite(provider,
options)`, which registers a full suite of `describe`/`it` blocks (via
`vitest`) asserting the `FileSourceProvider` contract holds for *any*
provider — not just this fixture:

- the manifest is well-formed (`api` satisfies `PLUGIN_API_VERSION`,
  capabilities present, `auth: 'interactive'` implies `provider.auth` exists,
  a declared `relay` has both fields, network entries are valid host
  patterns);
- `listContainers` matches the declared `containerListing` mode (no
  grandchildren leak into a `direct-children` result; a `flat-subtree` result
  forms one connected tree rooted at the queried container);
- `listFiles` recursion matches `listFilesIsRecursive`, and every returned
  file's `containerId` names a container the provider also returns;
- paging terminates, never repeats an item, and following cursors to
  exhaustion reconstructs the same set as one large page;
- `download` honors `revisionId` and rejects promptly on an already-aborted
  signal;
- optional methods are present if and only if the matching capability is
  `true`;
- `watchRevisions` returns a cursor when `changeDetection` is `true`.

```ts
import { runConformanceSuite } from '@ifc-lite/source-fixture/conformance';

runConformanceSuite(myProvider, {
  createContext: () => myTestContext,
  fixtures: {
    projectId: 'known-good-project-id',
    containerWithFilesId: 'a-container-that-has-files',
    containerWithChildrenId: 'a-container-with-nested-children', // omit if flat
    fileWithRevisions: { containerId: '...', fileId: '...' }, // omit if no history
    searchQuery: 'something that matches at least one file',
  },
  smallPageLimit: 1, // small enough to force multiple pages
});
```

This is deliberately the **only** dependency-bearing export of the whole
package beyond `@ifc-lite/plugin-api` (types) and `vitest`'s
`describe`/`it`/`expect` — so the Dalux and Microsoft Graph provider packages
can run the same kit against their own mocked providers without pulling in
the fixture's data model.

Cursor scoping (a cursor minted for one query being rejected if reused
against a different one) is intentionally **not** part of the portable
conformance kit — that's this fixture's own implementation choice, not
something every real provider's cursor scheme is guaranteed to detect. It's
covered instead in this package's own `test/provider.test.ts`.

See `packages/source-fixture/test/` for the fixture proving itself
conformant across the full `containerListing` x `listFilesIsRecursive` x
`auth` matrix, plus the fixture-specific behavior (failure injection,
hang/abort, truncated pages, the auth gate, and cursor scoping).
