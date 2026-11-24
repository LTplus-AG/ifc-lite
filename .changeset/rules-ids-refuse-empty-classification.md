---
"@ifc-lite/rules": patch
---

`ruleSetToIds` refuses a classification rule with no system ("any classification") with a reason in `refused` instead of letting `writeIdsXml` throw, since IDS 1.0 needs a system or a code in a classification facet.
