# P-06 — bSDD integration

**Problem.** bSDD exists in ifc-lite (SDK, viewer card, MCP, CLI) but is not connected to IDS. bSDD support in existing tools is shallow (lookups only) or tied to a vendor.

**Appetite.** 3 weeks (small batch), Track C (C3). Dictionary→IDS may spill to the C4 cooldown.

**Solution.**
- A bSDD tab in pickers.
- Class → classification/entity facets.
- Class properties → requirements via a tested mapping table.
- Dictionary → IDS generator with inheritance.
- URI health lints.
- An offline cache.

**Rabbit holes.**
- bSDD data quality varies by dictionary: missing data types and units. Map conservatively and flag with lint info rather than guessing.
- The `system` naming convention for the classification facet (dictionary name vs URI). Follow the IDS docs, and lint mismatches.

**No-gos.** No write-back to bSDD (D6). No bSDD dictionary editing.

**Scopes.** IDS-069 … IDS-074.

**Done means.** A real public dictionary turns into an audit+lint-clean IDS with inheritance; pickers work offline for cached classes.

**Evidence.** Recording plus the generated IDS from a public dictionary.
