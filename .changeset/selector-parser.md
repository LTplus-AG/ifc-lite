---
"@ifc-lite/query": minor
---

Add `parseSelector`, a parser for the IfcOpenShell selector (filter) syntax, plus its AST types. It reads the whole grammar — class and GlobalId terms with `!` subtraction, attribute and `Pset.Prop` comparisons over `= != > >= < <= *= !*=`, `type=` / `material=` / `classification=` / `location=` / `parent=` keywords, `query:` key paths, quoted values, `/regex/` literals and `+` unions — and answers with either an AST or an error carrying the character offset that broke. Accepting more than any one surface can evaluate is deliberate: an adapter names what it dropped instead of matching nothing in silence.
