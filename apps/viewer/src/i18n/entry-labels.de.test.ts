/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { validationPanelDe } from './locales/de/validation-panel';
import { manualValidationDe } from './locales/de/manual-validation';

it('German rule-set entry follows the current UI (#8802)', () => {
  assert.equal(validationPanelDe['validationPanel.entry.openRuleSet'], 'Regelsatz öffnen');
});
it('German IDS entry follows the current UI (#8802)', () => {
  assert.equal(validationPanelDe['validationPanel.entry.importIds'], 'IDS importieren');
});
it('German checklist entry follows the current UI (#8802)', () => {
  assert.equal(manualValidationDe['manualValidation.entry.open'], 'Checkliste öffnen');
});
