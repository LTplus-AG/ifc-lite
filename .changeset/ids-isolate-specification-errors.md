---
"@ifc-lite/ids": patch
---

One specification that throws no longer ends the whole `validateIDS` run. Only a rejected `xs:pattern` (`UnsafeRegexPatternError`) used to be caught per specification; any other error rejected the run and discarded every other specification's verdict. Now any error fails its own specification with `error: "Specification could not be evaluated: <reason>"`, as a rejected pattern always did, and the other specifications are reported, as `runRuleSet` in `@ifc-lite/rules` already does. A host's cancellation (`AbortError`) still ends the run.
