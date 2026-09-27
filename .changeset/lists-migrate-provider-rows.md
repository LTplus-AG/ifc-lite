---
"@ifc-lite/lists": minor
"@ifc-lite/rules": minor
"@ifc-lite/viewer": patch
---

Saved list filters migrate losslessly into Rules groups (#6190). `migrateLegacyListDefinition` and `migrateLegacyListConditions` now turn every Lists predicate without a canonical Rules form into a `listCondition` rule instead of an unreadable row. That covers zones, spatial levels, quantity and material presence, model file name, Lists attributes, inherited and regex-named properties, and world coordinates. It applies both to v1 `conditions` and to provider-only rows saved by earlier builds. Flat conditions are ANDed into every group, and an OR group is split so `(a OR b) AND c` becomes `(a AND c) OR (b AND c)`. `unreadableConditions` now holds only data that cannot be evaluated: malformed members, unknown operators or sources, and group rules this build cannot read. A saved group with such a rule no longer makes the whole list disappear. The rule shows as a removable row instead.

The viewer removes the Lists-only compatibility editor and its provider-only filter path. Every filter is edited in the shared Rules editor. A list with an unreadable row shows it with a Remove button and will not run until it is removed. Document table lists still reject malformed embedded groups at load.

`@ifc-lite/rules` exports `LIST_CONDITION_SOURCES` and `LIST_CONDITION_OPERATORS`, the sources and operators a `listCondition` rule may hold, which the migration validates against.
