---
'@ifc-lite/cli': minor
---

`ifc-lite gym` gains an episode factory: `--seed`/`--family`/`--corrupt` (and
mid-session `reset` messages with a `seed`) serve procedurally generated,
deterministic world-gym models through the existing reset/step/reward JSONL
protocol, so RL-style consumers get labeled episodes without touching
internals. `--model` payloads are unchanged and remain backward compatible.
The generator is loaded lazily from a repo checkout; the published package
prints a clear error if the world-gym tooling is unavailable.
