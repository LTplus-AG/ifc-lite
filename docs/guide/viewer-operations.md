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
| `viewer_operation_execute` | Run a parameterized view or settings operation with the current commands and edits grant. |
| `viewer_operation_job` | Inspect an owned job's actual state, progress and result. |
| `viewer_operation_cancel` | Request cancellation; inspect until the native runner settles. |
| `viewer_operation_coverage` | Inspect implemented slices, remaining gaps and host boundaries. |

The concrete operations include model-qualified selection, visibility and colors;
numerical camera and section planes; numerical distances and perimeters;
lighting/solar settings; point-cloud display and LAS class masks; effective IFC
schedule, cost and structural reads; IDS validation; and clash analysis against
live geometry, including GPU-instanced occurrences. Clash analysis returns its
own result and does not replace the current panel report.

For example, discover `measurements.distance`, then execute:

```json
{
  "model_id": "the-id-from-model_list",
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
reusing a key with changed input, model or revision is refused.

A background request returns `running`, never a fabricated completed analysis.
Cancellation is forwarded to the native service. A cancellation request can still
report `running` until that service actually settles. Jobs are owned by the
viewer host and are bounded to 32 retained records.

Each operation declares effects independently of the SDK namespace. The gateway
accepts reads, view/selection changes and configuration only. Native feature
switches and the live commands and edits grant remain authoritative. Model
writes, file/network effects and publication require their separate existing
native workflows; they are not reachable through this executor. Browser file
pickers, provider credential prompts and concrete publication approval still
require their existing human interaction.
