# P-04 — Lint engine and catalogue

**Problem.** Valid IDS can still be useless or wrong:
- abstract entities that match nothing;
- `^`/`$` literals in patterns;
- millimetres instead of metres;
- contradictions;
- requirements that can't fail.

No tool catches these today.

**Appetite.** 6 weeks, Track A (C2).

**Solution.**
- An incremental lint engine with stable codes, quick-fix op batches, suppressions with reasons and per-rule docs.
- ≥25 static rules in this cycle; model-aware rules come with P-05.
- A constraint-intersection solver for contradiction/tautology rules (enumerations, ranges, patterns via sampling).

**Rabbit holes.**
- Regex intersection is undecidable in practice for complex patterns. Use sampling with the pattern string generator (IDS-114) or skip; never claim certainty we don't have (severity info).
- Semantics we're unsure of (entity-subtype rule, boolean lexical forms) must be verified against the corpus before shipping as warning/error (RAID A-03, A-04).

**No-gos.** No auto-applying fixes. No rule that contradicts the audit.

**Scopes.** IDS-046 … IDS-054.

**Done means.** ≥25 rules each with fixtures and docs; precision ≥95% on the lint corpus (or the rule is demoted to info).

**Evidence.** Precision report; screenshots of quick fixes.
