---
"@ifc-lite/rules": patch
---

The text requirement parser (`parseRequirementText`) now rejects the same shapes the JSON rule-set parser rejects (#5182). Those shapes are an aggregate with no subject and a function other than `count` (`sum() > 300`), a numeric aggregate over a multi-valued subject (`sum(material) > 1`), and a `compare` with a multi-valued side (`material = Name`). Before, the text parser accepted them, and the rule then failed at evaluation time instead of being refused while it was being written. Both parsers now call one shared check.
