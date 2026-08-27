---
'@ifc-lite/ids': patch
---

`xs:double` now accepts the special literals upstream IDS-Audit-tool accepts.

`literalCastsUnder(value, 'xs:double')` rejected `NaN`, `+INF` and `-INF`, which
upstream accepts.

The coherence audit was NOT the counterexample this change was first written
against. Its table carries upstream's pattern, but `isValidLexicalForXsType`
vetoes any value with no digit before that pattern runs, and none of the three
specials has a digit. So both sites reject the three specials and agree with each other there, while
both diverge from upstream.

They do NOT agree everywhere, and the first draft of this changeset said they
did. Measured: upstream also accepts an exponent-only family (`e5`, `+e5`,
`.e5`), and the audit's digit veto is SATISFIED by the digit in the exponent, so
the audit accepts those while the cast rejects them. That split predates this
change. The audit follow-up has to reconcile both classes, not just the
specials.

This fixes the cast.

Upstream is the contract here, and it is neither .NET nor XSD. It generates the
validator as a regex, `^([-+]?[0-9]*\.?[0-9]*([eE][-+]?[0-9]+)?|NaN|\+INF|-INF)$`,
which takes `+INF` (an XSD 1.1 spelling) while rejecting bare `INF` (the 1.0
one), and rejects `Infinity` (the .NET one). The coherence table already carried
that pattern verbatim, behind a veto that suppresses it for these inputs.

A family of deviations is kept and documented at the call site: every part of upstream's
pattern is optional, so it also matches `""`, `"+"`, `"."`, `"-"`, `"+."` and
the exponent-only forms. Those fall out of how the regex is written rather than
being a decision, and accepting an empty string as a double turns a malformed
IDS literal into a passing constraint. The cast keeps rejecting them. The test
pins representatives rather than the whole family, and says so.

The docblock claiming these arms mirror `int.TryParse` / `double.TryParse` was
wrong and is corrected: upstream does not use `TryParse` for this.
