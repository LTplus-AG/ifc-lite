---
"@ifc-lite/viewer": minor
---

The Data validation panel has a third tab, Manual validation ([#6401](https://github.com/LTplus-AG/ifc-lite/issues/6401)), for checks done by eye, such as "the model was uploaded to the CDE on time" or "objects sit on the right storey". A checklist holds groups of checks; each check takes Pass, Fail or Warning and an optional comment, and an unchecked item shows as Not checked. Each group has a ring chart and there is an overall ring, with warnings counted separately from passes. Groups and checks can be added, renamed, reordered and deleted.

The checklist structure saves to and opens from a `.checklist.json` file (the template only, never the answers), with a Recent checklists list like rule sets have. Answers are stored in the browser per model, keyed by the model file's identity, so they come back when the same file is loaded again. Manual results are kept apart from IDS and information-validation results and never replace them.
