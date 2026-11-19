---
"@ifc-lite/viewer": patch
---

Agent operations stay usable on large libraries and models. The clash report, clash group, validation report and zone expected-state tokens (`expected_reports`, clash `expected_library` and `expected_groups`, `expected_configuration`) are now short revisions instead of the whole state as JSON; `zones.read` returns `configuration_revision` in place of `configuration_json`. `clash.reports.read`, `clash.groups.read`, `validation.reports.read` and zone assignments are paged with an optional `offset` and a `next_offset`. `zones.writeback.prepare` returns `row_count`, a bounded `rows` sample and `truncated`. `exports.anonymized.prepare` reports `truncated` relationship expansion and refuses a membership above 100,000 entities or a preview above the result limit, with a message to narrow the selection.
