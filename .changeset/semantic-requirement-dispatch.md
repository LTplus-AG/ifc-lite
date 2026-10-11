---
"@ifc-lite/viewer": minor
---

Reviewed source requirements can now be turned into native checks. The requirement review shows, for each requirement, which native tool can check it: an IDS check, an information rule on a model quantity, a manual check listed in a document, or no native check with the reason (quote not matching, source changed or detached, unaddressable property, unsupported comparison, value or unit). On request it prepares the IDS, rule and document drafts, which go through the existing review, dry run, save and editor handoff. Each saved record keeps the requirement's statement, stated unit, exact source passage and source revision. Manual and unresolved requirements are listed as not checked, never with a pass or fail result, and unsaved drafts are withdrawn if a source text changes.
