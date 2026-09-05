# Collaboration architecture

IFC-Lite collaboration is built around `@ifc-lite/collab`, with the sync and
persistence service provided by `@ifc-lite/collab-server`. The browser viewer,
CLI, MCP server, and third-party clients consume these shared packages rather
than implementing independent collaboration protocols.

## Model

An editing session stores IFCX operations in a Yjs document. Operations are
identified independently of transient STEP express IDs, and snapshots are
materialized through the same IFCX composition and mutation paths used by
headless consumers. Tombstones represent deletions; immutable published layers
carry canonical content identifiers and provenance manifests.

Geometry blobs are content-addressed and remain separate from the CRDT document.
The document contains references and parametric state, which keeps ordinary
updates small and makes missing or corrupt blobs detectable.

## Synchronization

Clients exchange Yjs updates through `@ifc-lite/collab-server`. The server owns
room admission, authorization, persistence, audit records, retention, and blob
transport. It does not introduce a second IFC decoding or geometry pipeline.

The client provider handles reconnects and awareness state. Awareness—cursor,
selection, identity, and presence—is ephemeral and is not part of a model
snapshot.

## Conflict and history model

CRDT convergence guarantees that peers reach the same operation state; it does
not make concurrent BIM edits semantically compatible. Domain conflicts are
detected separately and presented through the shared merge and review models.
Published layers and refs provide durable history, while local undo remains a
session concern.

## Security boundary

Deployments choose anonymous or token-authenticated access. Authorization is
checked by the server for room, role, and protected registry operations. Audit
events and content hashes provide evidence for changes, but callers must still
apply transport security, retention, and deployment controls appropriate to
their data.

## Further reading

- [Using collaboration](../guide/collaboration.md)
- [Collaboration server](../guide/collab-server.md)
- [Testing collaboration](../contributing/collaboration-testing.md)
- [Layer format](layer-prs/02-layer-format.md)
- [Diff and merge semantics](layer-prs/05-merge.md)
