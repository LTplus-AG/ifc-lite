/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cross-reference validator.
 *
 * Sits between manifest validation and bundle execution. Confirms:
 *
 *   - Every command id referenced by toolbar / contextMenu /
 *     keybinding / statusBar exists in `contributes.commands` OR
 *     `entry.commands`.
 *   - Every entry path exists in the bundle's file map.
 *   - Every widget path exists in the bundle's file map.
 *   - (Optionally) every test fixture id is in the supplied fixture
 *     catalogue.
 *
 * The manifest validator handles (1) on its own. This module adds (2),
 * (3), and (4) for the post-load + dry-run stages of the AI authoring
 * pipeline.
 *
 * Spec: docs/architecture/ai-customization/04-ai-authoring.md §6.
 */

import type {
  Bundle,
  ValidationError,
  ValidationResult,
} from '../types.js';

export interface CrossRefOptions {
  /** Set of fixture ids the test runner has available. */
  knownFixtures?: ReadonlySet<string>;
}

/**
 * Run all cross-reference checks against a loaded bundle. Returns
 * `{ ok }` on full success; otherwise an aggregated error list.
 */
export function crossReferenceBundle(
  bundle: Bundle,
  opts: CrossRefOptions = {},
): ValidationResult<true> {
  const errors: ValidationError[] = [];
  const manifest = bundle.manifest;
  const files = bundle.files;

  // 1. Entry paths
  const entry = manifest.entry;
  if (entry.activate && !files.has(normalise(entry.activate))) {
    errors.push({ path: 'entry.activate', code: 'invalid_reference', message: `entry.activate "${entry.activate}" not found.` });
  }
  if (entry.deactivate && !files.has(normalise(entry.deactivate))) {
    errors.push({ path: 'entry.deactivate', code: 'invalid_reference', message: `entry.deactivate "${entry.deactivate}" not found.` });
  }
  if (entry.commands) {
    for (const [id, p] of Object.entries(entry.commands)) {
      if (!files.has(normalise(p))) {
        errors.push({ path: `entry.commands.${id}`, code: 'invalid_reference', message: `Handler "${p}" not found.` });
      }
    }
  }
  if (entry.triggers) {
    for (const [id, p] of Object.entries(entry.triggers)) {
      if (!files.has(normalise(p))) {
        errors.push({ path: `entry.triggers.${id}`, code: 'invalid_reference', message: `Trigger handler "${p}" not found.` });
      }
    }
  }

  // 2. Widget paths
  for (const dock of manifest.contributes?.dock ?? []) {
    if (!files.has(normalise(dock.widget))) {
      errors.push({ path: `contributes.dock[${dock.id}].widget`, code: 'invalid_reference', message: `Widget "${dock.widget}" not found.` });
    }
  }

  // 3. Lens / exporter / validator handlers
  for (const lens of manifest.contributes?.lenses ?? []) {
    if (!files.has(normalise(lens.evaluator))) {
      errors.push({ path: `contributes.lenses[${lens.id}].evaluator`, code: 'invalid_reference', message: `Evaluator "${lens.evaluator}" not found.` });
    }
  }
  for (const ex of manifest.contributes?.exporters ?? []) {
    if (!files.has(normalise(ex.handler))) {
      errors.push({ path: `contributes.exporters[${ex.id}].handler`, code: 'invalid_reference', message: `Handler "${ex.handler}" not found.` });
    }
  }
  for (const v of manifest.contributes?.idsValidators ?? []) {
    if (!files.has(normalise(v.handler))) {
      errors.push({ path: `contributes.idsValidators[${v.id}].handler`, code: 'invalid_reference', message: `Validator "${v.handler}" not found.` });
    }
  }

  // 4. Test fixtures
  if (opts.knownFixtures && manifest.tests) {
    for (let i = 0; i < manifest.tests.length; i += 1) {
      const t = manifest.tests[i];
      if (!opts.knownFixtures.has(t.fixture)) {
        errors.push({
          path: `tests[${i}].fixture`,
          code: 'invalid_reference',
          message: `Unknown fixture id: "${t.fixture}".`,
          hint: 'Check tests/models/manifest.json for available fixtures.',
        });
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: true };
}

function normalise(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}
