---
"@ifc-lite/ids": patch
---

One specification that throws no longer ends the whole `validateIDS` run. Only a rejected `xs:pattern` (`UnsafeRegexPatternError`) used to be caught per specification; any other error rejected the run and discarded every other specification's verdict. Now any error fails its own specification with `error: "Specification could not be evaluated: <reason>"`, as a rejected pattern always did, and the other specifications are reported, as `runRuleSet` in `@ifc-lite/rules` already does. A host's cancellation (`AbortError`) still ends the run. The applicability property index that the specifications of a run share now marks an entity as indexed only once its property sets are folded in, so an entity whose sets could not be read is not silently left out of a later specification. The buildingSMART corpus tests and the conformance scripts count a specification that could not be evaluated as an error, not as a `fail` verdict.
