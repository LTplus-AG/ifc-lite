---
'@ifc-lite/mutations': minor
---

Added an opt-in write guard for collaborative/multi-user setups: `BulkQueryEngine` and `CsvConnector` now accept a `canEdit` callback that is checked before any write is applied, throwing a new `MutationGuardError` if it returns false. A `MutationGuard` type is exported for the callback shape. Callers that do not pass `canEdit` see no behaviour change.
