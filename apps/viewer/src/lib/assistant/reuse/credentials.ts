/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reusable assistant artifacts (recipes, saved workflows, project
 * preferences) are portable files. Their schemas have no credential fields,
 * but free text (prompts, house rules, names) is user-typed, so every save and
 * export also refuses text containing a credential configured on this device
 * or one shaped like a provider key or bearer token.
 */

import { getApiKeys } from '@/services/api-keys';
import { loadBcfServerConfig } from '@/services/bcf-server-config';

/** Shapes of common provider keys and bearer tokens. Intentionally conservative. */
const CREDENTIAL_SHAPES: readonly RegExp[] = [
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
];
/** Shorter configured values (a workspace id, a user name) are not secrets on their own. */
const MIN_SECRET_LENGTH = 8;

/** Secrets configured on this device: BYOK keys and the BCF server connection. */
export function configuredCredentials(): string[] {
  const keys = getApiKeys();
  const bcf = loadBcfServerConfig();
  return [keys.anthropicKey, keys.openaiKey, bcf?.accessToken, bcf?.refreshToken, bcf?.clientSecret]
    .filter((value): value is string => typeof value === 'string' && value.trim().length >= MIN_SECRET_LENGTH)
    .map(value => value.trim());
}

/** True when any string carries a configured credential or a credential-shaped token. */
export function containsCredential(texts: readonly string[], known: readonly string[] = configuredCredentials()): boolean {
  return texts.some(value => known.some(secret => value.includes(secret)) || CREDENTIAL_SHAPES.some(shape => shape.test(value)));
}
