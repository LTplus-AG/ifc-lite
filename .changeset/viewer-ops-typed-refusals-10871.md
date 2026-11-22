---
"@ifc-lite/viewer": major
---

**Breaking for agent clients (#10871):** viewer operation refusals that came back as `INTERNAL_ERROR` now carry the matching error code and a `details.reason`. A refusal of the caller's input is `INVALID_INPUT` with `details.reason` (`unknown-target`, `wrong-target`, `invalid-value`, `limit`, `conflict` or `refused`); a changed expected state is `STATE_CHANGED`; a host-disabled feature or missing grant is `PERMISSION_DENIED`; a viewer not ready for the call is `UNSUPPORTED_OPERATION`; the executor's own grant refusals keep `READ_ONLY` with `details.reason: read-only`, and a mutation-gate denial carries `details.denial`. A failed background job keeps `error_code` and `error_details`. Agents that branched on `INTERNAL_ERROR` for these refusals should branch on the new codes.
