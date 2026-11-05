/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Data validation entry cards' one pattern (#8802 R3a): a heading with
 * its glyph, one line of explanation, and a single row of actions whose
 * first button is the card's main way in. Shared by the IDS, Information
 * and Manual validation cards so sibling cards never lay the same kind of
 * controls out differently.
 */

import type { ReactNode } from 'react';

/** One entry card's heading and explanation, shared by all three cards (#8802). */
export function EntryHeading({ icon, title, description }: { icon: ReactNode; title: string; description: string }) {
  return (
    <>
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="flex shrink-0 text-muted-foreground [&>svg]:h-4 [&>svg]:w-4">{icon}</span>
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
    </>
  );
}

/** The row of a card's actions: the first is the card's main way in, the rest are quieter. */
export const ENTRY_ACTIONS = 'mt-3 flex flex-wrap items-center gap-1';
export const ENTRY_BUTTON = 'h-7 gap-1 px-2 text-xs';
