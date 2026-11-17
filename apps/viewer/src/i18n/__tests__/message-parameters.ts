/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { TranslationValue } from '../types';

export function messageParameters(message: TranslationValue): string[] {
  const forms = typeof message === 'string' ? [message] : Object.values(message);
  return [...new Set(forms.flatMap(form =>
    [...form.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(match => match[1])))].sort();
}
