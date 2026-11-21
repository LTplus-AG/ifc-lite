/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Settings } from './analytics-appearance';
import { invalidInput, parseJsonInput } from './refusals';
let decoder: Promise<(value: unknown) => Settings> | undefined;
/** Use the existing canonical operation settings codec; do not transcribe it. */
export async function decodeAppearanceSettings(json: string): Promise<Settings> {
  decoder ??= (async () => {
    const [{ default: Ajv }, { settingsSchema }] = await Promise.all([import('ajv'), import('./analytics-appearance')]);
    const validate = new Ajv({ allErrors: true, strict: false }).compile<Settings>(settingsSchema);
    return (value: unknown) => {
      if (!validate(value)) throw invalidInput('invalid-value', `Invalid native appearance settings: ${JSON.stringify(validate.errors)}`);
      return value;
    };
  })();
  return (await decoder)(parseJsonInput(json, 'settings_json'));
}
