/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { invalidInput } from './refusals';

export function bcfArchiveRefusal(error: unknown): never {
  if (error instanceof Error) {
    if (error.name === 'BCFResourceLimitError') throw invalidInput('limit', error.message);
    if (error.name === 'BCFArchiveFormatError' || error.name === 'DraftArchiveError')
      throw invalidInput('invalid-value', error.message);
  }
  throw error;
}
