/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Shared homes for static viewer commands (#5870).
 *
 * The remaining palette rows move here with their surface families. Runtime
 * rows (recent files, extensions, tours) stay with their runtime providers.
 */

import { Eye, FolderOpen, Palette, Save, Tag } from 'lucide-react';
import type { TranslationKey } from '@/i18n';
import { resolveEnglish } from '@/i18n/registry';
import { executeBasketToggleVisibility } from '@/store/basket/basketCommands';
import type { Command } from './commandPaletteSearch';

export type CommandSurface = 'palette' | 'ribbon' | 'context' | 'mobile';

export interface SurfaceCommandContext {
  surface: CommandSurface;
  execute?: (code: string) => void;
  resetColors?: () => void;
}

export interface SurfaceCommandState {
  canEditInSession: boolean;
}

export interface SurfaceCommandDefinition {
  id: string;
  labelKey: TranslationKey;
  keywords: string;
  category: Command['category'];
  icon: Command['icon'];
  surfaces: readonly CommandSurface[];
  enabled: (state: SurfaceCommandState) => boolean;
  run: (context: SurfaceCommandContext) => void;
  immediate?: boolean;
}

const alwaysEnabled = (_state: SurfaceCommandState): boolean => true;
const paletteAndRibbon = ['palette', 'ribbon'] as const;

export const SURFACE_COMMANDS = [
  {
    id: 'file:save-federation-setup', labelKey: 'commandPalette.file.saveFederationSetup.label',
    keywords: 'federation setup save export portable models order alignment anchor',
    category: 'File', icon: Save, surfaces: paletteAndRibbon, enabled: alwaysEnabled,
    run: () => { window.dispatchEvent(new CustomEvent('ifc-lite:save-federation-setup')); },
  },
  {
    id: 'file:open-federation-setup', labelKey: 'commandPalette.file.openFederationSetup.label',
    keywords: 'federation setup restore reopen import portable models order alignment anchor',
    category: 'File', icon: FolderOpen, surfaces: paletteAndRibbon, enabled: alwaysEnabled,
    immediate: true,
    run: () => { window.dispatchEvent(new CustomEvent('ifc-lite:open-federation-setup')); },
  },
  {
    id: 'file:model-tags', labelKey: 'commandPalette.file.modelTags.label',
    keywords: 'model tags label discipline federation organise organize',
    category: 'File', icon: Tag, surfaces: paletteAndRibbon, enabled: alwaysEnabled,
    run: () => { window.dispatchEvent(new CustomEvent('ifc-lite:edit-model-tags')); },
  },
  {
    id: 'vis:toggle-iso', labelKey: 'commandPalette.vis.toggleBasket.label',
    keywords: 'basket show hide', category: 'Visibility', icon: Eye,
    surfaces: paletteAndRibbon, enabled: alwaysEnabled,
    run: () => { executeBasketToggleVisibility(); },
  },
  {
    id: 'vis:reset-colors', labelKey: 'commandPalette.vis.resetColors.label',
    keywords: 'clear color override', category: 'Visibility', icon: Palette,
    surfaces: paletteAndRibbon, enabled: alwaysEnabled,
    run: ({ execute, resetColors }: SurfaceCommandContext) => {
      if (resetColors) resetColors();
      else if (execute) execute('bim.viewer.resetColors()\nconsole.log("Colors reset")');
      else throw new Error('Reset Colors requires a viewer action');
    },
  },
] as const satisfies readonly SurfaceCommandDefinition[];

export type SurfaceCommandId = (typeof SURFACE_COMMANDS)[number]['id'];

export function surfaceCommand(id: SurfaceCommandId, surface: CommandSurface): SurfaceCommandDefinition {
  const definition = SURFACE_COMMANDS.find((command) => command.id === id);
  if (!definition) throw new Error(`Unknown surface command: ${id}`);
  if (!definition.surfaces.includes(surface)) throw new Error(`${id} is not registered for ${surface}`);
  return definition;
}

export function paletteSurfaceCommands(
  state: SurfaceCommandState,
  execute: (code: string) => void,
): Command[] {
  return SURFACE_COMMANDS
    .filter((command) => command.surfaces.includes('palette') && command.enabled(state))
    .map((command) => ({
      id: command.id,
      label: resolveEnglish(command.labelKey),
      labelKey: command.labelKey,
      keywords: command.keywords,
      category: command.category,
      icon: command.icon,
      immediate: 'immediate' in command ? command.immediate : undefined,
      action: () => command.run({ surface: 'palette', execute }),
    }));
}
