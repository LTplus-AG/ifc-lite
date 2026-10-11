---
"@ifc-lite/viewer": minor
---

Review now re-examines saved IDS and information-validation failure rows through the current native validation run. A saved report records which IDS document or rule-set content it checked. When the current run checked exactly that definition over the same model files and is up to date, each saved failure is shown as persisting, changed, or (only after a complete run explicitly passes the element) a resolution candidate. The saved report and its native statuses never change. An edited definition, another model source, a stale or capped run, an unevaluated element, ambiguous identities, or a report saved before this change stay not re-checked, with the reason named.
