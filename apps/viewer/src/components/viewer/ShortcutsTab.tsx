/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Info dialog's Shortcuts tab, generated from the keyboard command table
 * (`lib/commands/keyboard-commands.ts`, #5836). Nothing here lists a key by
 * hand: a row exists because a command declares the key, and its glyphs are
 * formatted for the platform the viewer runs on.
 */

import { useTranslation, type TranslationKey, type TranslationParameters } from '@/i18n';
import { ALT_SHORTCUT_PANELS } from '@/lib/panels/registry';
import { isApplePlatform } from '@/lib/commands/chord';
import {
  KEY_COMMANDS,
  KEY_COMMAND_CATEGORIES,
  POINTER_GESTURES,
  type KeyCommandCategory,
} from '@/lib/commands/keyboard-commands';
import { formatCommandKeys } from '@/lib/commands/shortcut-label';

interface ShortcutRow {
  readonly id: string;
  readonly keys: string;
  readonly labelKey: TranslationKey;
  readonly params?: TranslationParameters;
}

/** Alt+1…0 panel names, taken from the registry so a rename cannot go stale. */
const altPanelTitles = (bottom: boolean) =>
  ALT_SHORTCUT_PANELS.filter((p) => (p.region === 'bottom') === bottom).map((p) => p.title).join(', ');

function rowsByCategory(apple: boolean, gestureKeys: (row: (typeof POINTER_GESTURES)[number]) => string) {
  const rows = new Map<KeyCommandCategory, ShortcutRow[]>();
  const push = (category: KeyCommandCategory, row: ShortcutRow) => {
    const list = rows.get(category) ?? [];
    list.push(row);
    rows.set(category, list);
  };
  for (const command of KEY_COMMANDS) {
    push(command.category, {
      id: command.id,
      keys: formatCommandKeys(command, apple),
      labelKey: command.labelKey,
      params: command.id === 'ui.openPanel'
        ? { sidePanels: altPanelTitles(false), bottomPanels: altPanelTitles(true) }
        : undefined,
    });
  }
  for (const gesture of POINTER_GESTURES) {
    push(gesture.category, { id: gesture.id, keys: gestureKeys(gesture), labelKey: gesture.labelKey });
  }
  return KEY_COMMAND_CATEGORIES.flatMap((category) => {
    const list = rows.get(category);
    return list ? [{ category, rows: list }] : [];
  });
}

export function ShortcutsTab() {
  const { t } = useTranslation();
  const apple = isApplePlatform();
  const groups = rowsByCategory(apple, (gesture) => t(gesture.gestureKey, { mod: apple ? '⌘' : 'Ctrl' }));

  return (
    <div className="space-y-4">
      {/* Learn-more row: drives discovery to the marketing site and the github.io
          docs. Sits above the shortcut groups so it's the first thing users hunting
          for help see, without crowding the keyboard reference itself. */}
      <div className="rounded border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{t('keyboardShortcuts.shortcuts.learnMore')}</span>
        <a
          href="https://ifclite.dev"
          target="_blank"
          rel="noopener noreferrer"
          className="ml-2 underline-offset-2 hover:underline hover:text-primary transition-colors"
        >
          {t('keyboardShortcuts.shortcuts.homepageLink')}
        </a>
        <span className="mx-1.5 opacity-40">·</span>
        <a
          href="https://ifclite.dev/docs/"
          target="_blank"
          rel="noopener noreferrer"
          className="underline-offset-2 hover:underline hover:text-primary transition-colors"
        >
          {t('keyboardShortcuts.shortcuts.docsLink')}
        </a>
      </div>
      {groups.map(({ category, rows }) => (
        <div key={category}>
          <h3 className="text-sm font-medium text-muted-foreground mb-2">
            {t(`commands.category.${category}`)}
          </h3>
          <div className="space-y-1">
            {rows.map((row) => (
              <div
                key={row.id}
                data-shortcut-command={row.id}
                className="flex items-center justify-between gap-3 py-1"
              >
                <span className="text-sm">{t(row.labelKey, row.params)}</span>
                <kbd className="shrink-0 px-2 py-0.5 text-xs bg-muted rounded border font-mono">
                  {row.keys}
                </kbd>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
