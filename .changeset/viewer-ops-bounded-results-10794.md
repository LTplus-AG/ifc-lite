---
"@ifc-lite/viewer": major
---

**Breaking for agent clients (#10794).** Reads and expected-state tokens used to grow with the model until they passed the 1 MB result limit; they are now paged and short.

- `zones.read` drops `configuration_json` and returns `configuration_revision`. Pass that revision as `expected_configuration` to every zone edit; each edit also returns the next one. `zones.read` returns flat rows tagged by `kind` (`set`, `zone`, `apportionment`, `apportioned`, `refused`, `assignment`) in place of the `sets`, `assignments` and `apportionment` fields.
- Zone operations return receipts, never sets or rows: `zones.set.edit`, `zones.box.write`, `zones.box.remove`, `zones.import` and `zones.generateStoreys` return ids and counts instead of a set or every set (`zones.set.create` already returned only `set_id`); `zones.assign` returns `element_count` instead of the assignments; `zones.apportion` returns `apportioned_count`, `refused_count`, `refusals` by reason, `computed_at` and `elapsed_ms` instead of its per-element rows.
- Every `expected_*` input on these operations takes a short revision instead of the full state as JSON: clash `expected_reports`, `expected_library` and `clash.drafts.create`'s `expected_groups`, validation `expected_reports`, zone `expected_configuration`. Read it from the matching read operation; an old full-JSON token is refused. The clash group `expected_library` also covers the active workspace, so a token read before another client switches workspace is refused.
- `clash.reports.read`, `clash.groups.read` and `validation.reports.read` return one page; pass `next_offset` as the optional `offset` until it is null, and start again from 0 if the revision changes. `zones.read` pages its rows under one cursor (`page.next_offset`, restart on `page.revision`).
- `exports.anonymized.prepare` refuses a membership above 100,000 entities or a preview above the result limit (narrow the selection or exclude types), and reports `truncated` relationship expansion in its preview and export diagnostics.

Also: `zones.writeback.prepare` returns `row_count`, a bounded `rows` sample and `truncated`.
