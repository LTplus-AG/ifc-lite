# Parameterized viewer operations

The viewer's local agent connection offers a bounded operation gateway alongside
its existing model tools and command palette gateway. It uses native SDK adapters
and store actions. Panels do not need to be open for these operations.

This is a partial migration. `viewer_operation_coverage` returns the exact
implemented operation IDs, remaining work for all 35 panels and viewport tools,
and genuine browser/credential/review boundaries. No panel is marked complete.
The full migration acceptance criteria are in
[the architecture plan](../architecture/viewer-automation-plan.md).

| Tool | Purpose |
| --- | --- |
| `viewer_operations` | Search by task with bounded pages; pass `operation_id` to describe its exact schema and effects. |
| `viewer_operation_inspect` | Run a read-only operation, optionally as a background job. |
| `viewer_operation_execute` | Run a declared native operation with the current commands and edits grant. |
| `viewer_operation_job` | Inspect an owned job's actual state, progress and result. |
| `viewer_operation_cancel` | Request cancellation; inspect until the native runner settles. |
| `viewer_operation_coverage` | Inspect control bindings, remaining gaps and host boundaries. |
| `viewer_artifacts` | List connection-owned completed exports. |
| `viewer_artifact_read` | Read a bounded base64 chunk of an export. |
| `viewer_artifact_download` | Dispatch a native browser download; this does not confirm a saved file. |
| `viewer_artifact_delete` | Release an owned artifact. |

The concrete operations include model-qualified selection, visibility and colors;
numerical camera and section planes; numerical distances and perimeters;
lighting/solar settings; point-cloud display and LAS class masks; effective IFC
schedule, cost and structural reads; IDS validation; and clash analysis against
live geometry, including GPU-instanced occurrences. Clash analysis returns its
own result and does not replace the current panel report.

For example, discover `measurements.distance`, then execute:

```json
{
  "operation_id": "measurements.distance",
  "input": { "start": [0, 0, 0], "end": [3, 4, 0] },
  "expected_revision": 0,
  "idempotency_key": "distance-request-1"
}
```

Coordinates in the viewport operations are renderer **Y-up metres**. Entity
operations use local `express_ids` scoped by `model_id`; renderer offsets are
resolved by the native federation adapters. Camera operations require a mounted
viewport. Other implemented services remain usable with their panels closed.

Inspection returns a model revision. Supplying `expected_revision` refuses a
stale request. Running and completed jobs refuse model replacement, geometry
replacement and subsequent native edits. Results are limited to 1 MB. The optional
idempotency key retains an outcome for up to 100 synchronous requests per host;
reusing a key with changed input, model or explicit expected revision is refused.
A retry retains its outcome after its own successful revision change.

A background request returns `running`, never a fabricated completed analysis.
Cancellation is forwarded to the native service. A cancellation request can still
report `running` until that service actually settles. Jobs are owned by the
viewer host and are bounded to 32 retained records.

Each operation declares effects independently of the SDK namespace. Sensitive
model, artifact, network and publication effects additionally require an explicit
native policy. They reuse native transactions, provider permissions and exact
candidate review. The commands and edits grant does not replace those boundaries.
Browser file pickers, credential prompts and concrete external publication
approval retain their existing user interaction.

Model-required operations accept `model_id` from `model_list`. Viewer/session
operations, including numerical measurements and lighting, omit `model_id` and
can run before loading IFC. Discover `needs` before executing an operation. Model
reads reject stale model identities and revisions; model-free settings are not
invalidated by unrelated IFC loads.

Native authoring operations prepare detached candidates, then apply the exact
candidate through their native transaction and undo path. Cancellation before
commit refuses the write. Once a native write is admitted, the gateway waits for
its actual outcome; it does not claim cancellation rolled the write back. Native
limitations remain visible in operation descriptions and results.

Exports retain bounded, opaque handles owned by the connection. Read them in
chunks of at most 65,536 bytes. Handles expire at disconnect and cannot be read by
another connection. The connection retains at most 32 artifacts and 128 MiB.

Feature arrays own input/output schemas, effects and handlers. The build derives
a metadata-only catalogue and lazy module loaders with
`pnpm viewer:operations:update`; the viewer build rejects stale generated files.
Discovery does not import feature implementations. Execution verifies the loaded
handler's contract against that catalogue before calling it.
