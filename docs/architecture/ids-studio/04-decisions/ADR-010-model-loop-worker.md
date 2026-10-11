# ADR-010: Model loop in the IDS worker, reusing validator internals; explain instruments, never re-implements

## Context
- Live previews must match final validation results exactly, or users stop trusting them.
- The validator has a broadphase + inverted property index (`ApplicabilityPropertyIndex`) and progress/yield support.

## Decision
- Funnel, requirement preview, coverage, distinct values and inference run in the existing IDS worker (`workers/idsValidation.worker.ts`, extended), on the same `IFCDataAccessor`.
- Stage results are cached per (model-set hash, facet-prefix signature).
- **Explain** adds an optional tracer parameter to the facet evaluators (zero cost when absent). There is no second evaluator.
- Parity tests: preview verdicts ≡ validator verdicts, and trace verdicts ≡ validator verdicts, across the corpus.

## Consequences
- **+** Preview ≡ result by construction; one place to optimise.
- **−** Touches hot validator code. Benchmarks are required in the PR (performance doc rules).
