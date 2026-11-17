/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Mounted palette ownership only. Keep the eager shell independent of its command graph. */
import type { Command } from '@/components/viewer/commandPaletteSearch';

type CommandHost = () => readonly Command[];
let current: CommandHost | null = null;

/** Replacements own their own cleanup; an old owner cannot unregister a new one. */
export function registerAgentCommandHost(host: CommandHost): () => void {
  current = host;
  return () => { if (current === host) current = null; };
}

export function getAgentCommandHost(): CommandHost | null { return current; }
