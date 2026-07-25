---
'@ifc-lite/cli': minor
---

New `ifc-lite gym` command: a deterministic reset/step/reward environment
loop (JSONL over stdin/stdout) that scores data-mutation ops against the
existing schema/clash/ids checks, plus an episode factory:
`--seed`/`--family`/`--corrupt` (and mid-session `reset` messages with a
`seed`) serve procedurally generated, deterministic world-gym models through
the same protocol, so RL-style consumers get labeled episodes without
touching generator internals. `--model <file.ifc>` wraps a fixed model
instead. The generator is loaded lazily from a repo checkout; the published
package prints a clear error if the world-gym tooling is unavailable.
