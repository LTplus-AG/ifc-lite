# P-10 — Trust and teamwork

**Problem.**
- IDS are contracts that evolve, but there is no diff, no sign-off and no proof that a spec does what it says.
- Review happens over email.

**Appetite.** 6 weeks (C4: diff, revisions, test suites IFC4) + 3 weeks (C5: comments, co-authoring, more fixture versions), Track D.

**Solution.**
- Semantic diff with a plain-language changelog, and three-way merge.
- Revisions with a hash chain and sign-off.
- Comments.
- Yjs co-authoring through `@ifc-lite/collab`, with the gate applied to remote ops.
- **IDS test suites** with synthetic pass/fail/NA fixtures via `@ifc-lite/create`, plus snapshot fixtures from real models, runnable in the UI and CLI (JUnit).

**Rabbit holes.**
- Fixture generation for complex partOf and IFC2X3 type mapping. Label these as unsupported rather than faking them.
- CRDT ↔ op-log mapping edge cases (concurrent moves). Use last-writer-wins on order, with a diagnostic on conflict.

**No-gos.**
- No accounts or permissions system beyond what collab-server provides.
- No legal e-signature (sign-off is attestation, not a qualified signature).

**Scopes.** IDS-104 … IDS-114.

**Done means.**
- The diff explains every change in plain language.
- Generated fixtures confirm expected verdicts for 100% of generable corpus specs.
- Two browsers co-edit without divergence.

**Evidence.** Recordings; the fixture validation report.
