/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cross-reference validation: ensure every command referenced by a
 * toolbar / contextMenu / keybinding / statusBar contribution is declared
 * in `contributes.commands` or `entry.commands`.
 *
 * Runs after structural validation passes so the inputs already have the
 * expected shape.
 */

import type {
  ManifestContributions,
  ManifestEntry,
} from '../types.js';
import type { ValidationContext } from './primitives.js';

export function crossReferenceCommands(
  ctx: ValidationContext,
  obj: Record<string, unknown>,
  entry: ManifestEntry | undefined,
): void {
  const declared = new Set<string>();
  const contributes = obj.contributes as ManifestContributions | undefined;

  if (contributes?.commands) {
    for (const c of contributes.commands) declared.add(c.id);
  }
  if (entry?.commands) {
    for (const id of Object.keys(entry.commands)) declared.add(id);
  }

  const references = collectCommandReferences(contributes);

  for (const { path, command } of references) {
    if (!declared.has(command)) {
      ctx.add(path, 'invalid_reference',
        `Command "${command}" is referenced but not declared in contributes.commands or entry.commands.`);
    }
  }
}

function collectCommandReferences(
  contributes: ManifestContributions | undefined,
): Array<{ path: string; command: string }> {
  const refs: Array<{ path: string; command: string }> = [];
  if (!contributes) return refs;

  for (const tb of contributes.toolbar ?? []) {
    refs.push({ path: 'contributes.toolbar', command: tb.command });
  }
  for (const cm of contributes.contextMenu ?? []) {
    refs.push({ path: 'contributes.contextMenu', command: cm.command });
  }
  for (const kb of contributes.keybindings ?? []) {
    refs.push({ path: 'contributes.keybindings', command: kb.command });
  }
  for (const sb of contributes.statusBar ?? []) {
    if (sb.command) refs.push({ path: 'contributes.statusBar', command: sb.command });
  }
  return refs;
}
