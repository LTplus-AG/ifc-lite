# @ifc-lite/extensions

Extension manifest, capability grammar, and slot registry for IFClite's
user-customization system.

This package implements the **non-UI** half of the design described in
[`docs/architecture/ai-customization/`](../../docs/architecture/ai-customization/).
It is host-agnostic — the same code is consumed by the browser viewer,
the CLI, and the headless server.

## What's here (v0.3.3)

- **Manifest** — typed schema + hand-rolled validator producing
  structured `{ path, code, hint }` errors.
- **Capability grammar** — parser + matcher + risk-badge computation
  + set-diff helpers. The OCAP capability vocabulary that gates every
  bridge call.
- **Slot registry** — in-memory pub/sub for contribution points. The
  host subscribes; the loader registers extensions; the registry
  composes contributions.
- **`when` clause language** — small expression grammar (boolean ops,
  comparisons, dotted identifiers, literals) the host evaluates to
  show/hide contributions.
- **Bundle layout** — walker that reads a directory or a `.iflx`
  archive into an in-memory `Bundle` value. Verifies referenced
  files exist.
- **Manifest migrations** — chain scaffold for forward-compatibility
  with future manifest versions.

## Also included (re-exported from the package root)

- **Storage, host, audit** - IndexedDB storage, host loader, runtime
  activation, sandbox wiring, audit log, viewer-side slot binding.
- **Widget + authoring** - Widget DSL renderer, AI authoring pipeline,
  repair loop.
- **Flavor** - Flavor data model, export/import, three-way merge.
- **Log, miner, inference** - Action log, pattern miner, prompt overlay,
  SDK-update repair.

## Usage

```ts
import {
  validateManifest,
  parseCapability,
  matchCapability,
  computeRisk,
  diffCapabilities,
  parseWhen,
  evaluateWhen,
  SlotRegistry,
} from '@ifc-lite/extensions';
// The directory/`.iflx` bundle loader is Node-only:
import { loadBundleFromDirectory } from '@ifc-lite/extensions/node';

// Validate a manifest
const result = validateManifest(manifestJson);
if (result.ok) {
  console.log(result.value.id);
} else {
  for (const err of result.errors) {
    console.error(`${err.path}: ${err.message}`);
  }
}
```

## Design references

- `docs/architecture/ai-customization/01-extension-model.md`
- `docs/architecture/ai-customization/02-security.md`
- `docs/architecture/ai-customization/03-ui-surface.md`

Licensed under MPL-2.0.
