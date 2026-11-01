---
"@ifc-lite/rules": minor
"@ifc-lite/lists": minor
"@ifc-lite/viewer": minor
---

Lists can show each element's custom grouping (#8425). The list builder offers a "Grouping: <Lens>" column for every rule-based Lens, and each row shows the group the element belongs to (the same first match the `customGrouping` filter rule applies, live edits included). `@ifc-lite/lists` adds the `customGrouping` column source and the optional `ListDataProvider.getCustomGroup` hook. `@ifc-lite/rules` adds `customGroupOfElement`.
