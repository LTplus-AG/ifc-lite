/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The Model workspace's modeling-command HUD (charter #6232, WP2): the
 * command bar chrome and the units its typed fields show. Each command's own
 * label, field names and hints live beside it in this catalogue too.
 */
export const modelingCommandEn = {
  'modelingCommand.closeAria': 'Leave the command',
  'modelingCommand.unit.m': 'm',
  'modelingCommand.unit.deg': '°',
  'modelingCommand.unit.count': '',
} as const satisfies Record<string, TranslationValue>;
