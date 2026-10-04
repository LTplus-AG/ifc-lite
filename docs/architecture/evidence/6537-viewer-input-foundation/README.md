# Independent viewer input: bounded correctness evidence

Refs #6537. This packet covers the observer foundation, not a hosted viewer run.

- Generic controls: 23 pass, zero skipped. Historical disk refusal and the 15-pass/
  one-failure expectation correction are retained unchanged.
- Flat-piece surgical inverse: four genuine assertion failures; exact restoration
  gives four passes. All registration remains present in both source snapshots.
- Seven canonical CPU controls pass using real store/decoder/preparation/Scene.
  Only GPU bytes are mocked. Rust four-index goldens remain unchanged/refused;
  the successful triangle compatibility fixture is openly synthetic.
- Own fresh official WASM build and plain forced root typecheck pass: 111 executed
  tasks, zero cached; 3,324 test sources audited. Source-before/after inventories,
  actual tooling, raw output and independent root review are preserved.

The archive contains no model, compiled binary or dependency tree. Every logical
record preserves original bytes and SHA256. Original absolute paths in raw
receipts are historical provenance, not executable instructions.
Use the existing bounded data-only reader, without extraction or archived code:

```python
import importlib.util
from pathlib import Path
p = Path('docs/architecture/evidence/6537-viewer-source-allocation/replay.py')
s = importlib.util.spec_from_file_location('evidence_reader', p)
m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
records, manifest = m.read_archive(Path('docs/architecture/evidence/6537-viewer-input-foundation'))
```

The compatibility archive filename does not imply hosted evidence. No mounted
React, public-model, GPU/pixel, full-fidelity, timing or physical-memory win is
qualified. Future controller integration must authenticate literal source pins.
