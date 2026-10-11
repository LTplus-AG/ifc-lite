# ADR-011: Strict IDS 1.0 output; Studio metadata only in a sidecar; 1.1 behind a flag

## Context
- Interoperability is the reason IDS exists. Users complain that tools disagree.
- IDS 1.1 is in progress with no date.

## Decision
- The writer emits strict IDS 1.0. Studio metadata goes in the sidecar or the `.idsz` bundle. The optional fingerprint is an XML comment, which any parser ignores.
- 1.1 candidate features are modelled behind an `ids11Preview` flag and cannot be exported to 1.0.
- CI verifies exported files against the official audit tool.

## Consequences
- **+** Files work everywhere. Our conformance claims are testable.
- **−** Some features (translations, test suites) live outside the IDS file. That is acceptable, and the bundle carries them.
