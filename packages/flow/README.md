# @ifc-lite/flow

Keyed-data graph runtime for BIM workflows: the engine behind ifc-lite's
node graphs. Pure TypeScript, no DOM, no SDK dependency — the same graph
evaluates in the browser viewer and in the headless CLI.

## What it does

- **One data model.** Every value on an edge is an `Item`, a `List`, or a
  `Group` (lists keyed by string: GlobalId, storey, sheet name, grid
  intersection). Tables carry typed columns with IFC value types, units and
  the property they were read from.
- **Lifting instead of data trees.** A port declares `item`, `list` or
  `group` access. The scheduler lifts a node over lists by lacing
  (`shortest`, `longest`, `cross`) and over groups **by key** — branches
  match when their keys are equal, never by position. Unmatched keys are
  reported, not silently dropped.
- **Memoised evaluation.** Topological order, content-digested inputs,
  per-model revisions for nodes that read the model, a structured run log
  with per-lane errors.
- **Element tracking.** A write node's output survives re-runs: GlobalIds
  are derived from a user-visible tracking key and the lane key, vanished
  lanes are removed, and the tracked set is pinned to the model state it
  was made against.
- **Documents.** `*.flow.json` is git-diffable, hand-validated, and
  migrated by version.

## Flow document version 2

`FLOW_VERSION` is 2. `parseFlowDocument` migrates version-1 graphs before
validation and preserves existing nodes, parameters and the text `file` input.
Call `migrateFlowDocument` before `validateFlowDocument` at a custom boundary.

A `files` Player input describes local file slots. Each slot has an `id`,
`label`, `accept` extension list, `multiple` and `required` boolean. Slot IDs
are unique within the input; `fileSlots` is legal only for `kind: "files"`.

```json
{
  "nodeId": "load",
  "param": "files",
  "label": "Models",
  "kind": "files",
  "fileSlots": [
    { "id": "models", "label": "IFC models", "accept": ".ifc", "multiple": true, "required": true }
  ]
}
```

Files remain in the host session. Runtime parameter overrides carry opaque
resource tokens; exporting a graph never exports selected files, report bodies
or PDF blobs. Qualified slot addresses are `nodeId.param/slotId`. A slot selector
uses that full address to avoid ambiguity between fields.

## Install

```bash
npm install @ifc-lite/flow
```

## Usage

```ts
import { NodeRegistry, runFlow, parseFlowDocument, list } from '@ifc-lite/flow';

const registry = new NodeRegistry<{ names: string[] }>().register({
  type: 'demo.upper',
  title: 'Upper-case',
  category: 'demo',
  inputs: [{ name: 'text', type: { kind: 'scalar', access: 'item' } }],
  outputs: [{ name: 'upper', type: { kind: 'scalar', access: 'item' } }],
  params: [],
  capabilities: [],
  run: (_ctx, inputs) => ({ upper: String(inputs.text).toUpperCase() }),
});

const doc = parseFlowDocument(JSON.stringify({
  flowVersion: 1, id: 'demo', name: 'demo', capabilities: [], inputs: [], outputs: [],
  nodes: [{ id: 'u', type: 'demo.upper' }], edges: [],
}));

const result = await runFlow(doc, { host: { names: [] }, registry });
console.log(result.ok, result.reports);
```

Node libraries over the ifc-lite SDK live in `@ifc-lite/flow-nodes`.

## License

MPL-2.0

The Node-only `@ifc-lite/flow/checkpoint-file` entry exports `FileCheckpointStore`
and `sourceDigestOf`, shared by CLI and MCP review continuations. Disk updates
use an exclusive lock directory, revision CAS and atomic rename. A one-minute
age grace is necessary but never sufficient for recovery: the recorded local
process identity must also be retired. Browser consumers continue to use the
portable checkpoint entry and their native IndexedDB store.

The owner name records a hostname fingerprint, PID, Linux boot identity and
process start ticks (when procfs is available), plus a unique token. A reused
PID from another boot or process birth can therefore be reclaimed even while
the new process is alive. A matching live PID, or a live PID whose identity
cannot be verified, is retained with an explicit diagnostic. Without procfs,
recovery can prove an absent PID but cannot automatically distinguish a reused
live PID; verify the writer before manual removal.

This is local coordination within one host and PID namespace, **not a
cross-host/NFS lock service**. A PID has no liveness meaning on another host;
foreign-host owners are refused with a diagnostic, and hostnames must not be
aliased across independent PID namespaces. Verify a remote owner separately.
`mtime` is only a grace-period hint: clock skew (especially future timestamps)
can delay recovery; it never authorizes deleting a live owner.

Prepared candidate directories left by a crash between mkdir and publication
are inspected opportunistically. Only old candidates with a verified retired
local identity are removed, using owner-scoped unlink plus nonrecursive rmdir.
Recent/future-dated, live, foreign, unrecognized, non-directory and unrelated
entries are preserved. Concurrent reapers cannot remove a replacement writer's
unique owner entry. Windows EPERM when renaming over an occupied destination is
treated as a lock conflict; native Windows execution has not been validated.

Legacy empty `.lock` files have no provable owner identity: writes report an
actionable error instead of guessing. Verify no writer is active before
removing such a legacy file. Keep one writer version on a shared checkpoint.
