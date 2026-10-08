/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { registerEnglish } from '../registry';
import { semanticAssistEn } from './semantic-assist.en';

// Imported by the Linked records and Assistant chunks, so these strings are not in the eager bundle.
registerEnglish(semanticAssistEn);
