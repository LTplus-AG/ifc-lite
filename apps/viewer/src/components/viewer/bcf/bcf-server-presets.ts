/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Known BCF API servers, offered as a dropdown in the connect form. Every
 * fixed URL below answered `GET {baseUrl}/versions` and `GET
 * {baseUrl}/2.1/auth` when the list was compiled (2026-08-25); entries with
 * an empty URL are tenant-hosted (the user supplies their instance).
 *
 * A preset pre-fills the server URL and narrows the auth methods to what
 * the server's `/auth` discovery document advertises; "Custom" leaves
 * everything open. Vendors advertise `authorization_code_grant`, so their
 * default is 'oauth' — the in-browser sign-in popup — with 'token' (paste
 * an access token) as the fallback.
 */

export type BcfAuthMethod = 'password' | 'oauth' | 'token' | 'clientCredentials';

export interface BcfServerPreset {
  id: string;
  label: string;
  /** Pre-filled base URL; empty when the user must supply their own. */
  baseUrl: string;
  /** Auth methods this server is known to support, first one is default. */
  authMethods: readonly BcfAuthMethod[];
  /** OAuth `scope` this server's authorization endpoint expects, if any. */
  oauthScope?: string;
  /** Short hint rendered under the server picker. */
  note?: string;
}

export const CUSTOM_PRESET_ID = 'custom';

const VENDOR_NOTE =
  'Sign in with your vendor account in the browser (needs the client id of an OAuth app registered with the vendor), or paste an access token.';

export const BCF_SERVER_PRESETS: readonly BcfServerPreset[] = [
  {
    id: CUSTOM_PRESET_ID,
    label: 'Custom BCF server…',
    baseUrl: '',
    authMethods: ['password', 'oauth', 'token', 'clientCredentials'],
    note: 'Any BCF API 2.1 server, e.g. https://example.com/bcf.',
  },
  {
    id: 'aconex-americas',
    label: 'Aconex – Americas',
    baseUrl: 'https://us1.aconex.com/bcf',
    authMethods: ['oauth', 'token'],
    note: VENDOR_NOTE,
  },
  {
    id: 'aconex-asia',
    label: 'Aconex – Asia',
    baseUrl: 'https://asia1.aconex.com/bcf',
    authMethods: ['oauth', 'token'],
    note: VENDOR_NOTE,
  },
  {
    id: 'aconex-aunz',
    label: 'Aconex – Australia/NZ',
    baseUrl: 'https://au1.aconex.com/bcf',
    authMethods: ['oauth', 'token'],
    note: VENDOR_NOTE,
  },
  {
    id: 'aconex-europe',
    label: 'Aconex – Europe',
    baseUrl: 'https://eu1.aconex.com/bcf',
    authMethods: ['oauth', 'token'],
    note: VENDOR_NOTE,
  },
  {
    id: 'aconex-hongkong',
    label: 'Aconex – Hong Kong',
    baseUrl: 'https://hk1.aconex.com/bcf',
    authMethods: ['oauth', 'token'],
    note: VENDOR_NOTE,
  },
  {
    id: 'aconex-china',
    label: 'Aconex – Mainland China',
    baseUrl: 'https://cn1.aconexasia.com/bcf',
    authMethods: ['oauth', 'token'],
    note: VENDOR_NOTE,
  },
  {
    id: 'aconex-saudi',
    label: 'Aconex – Saudi Arabia',
    baseUrl: 'https://ksa1.aconex.com/bcf',
    authMethods: ['oauth', 'token'],
    note: VENDOR_NOTE,
  },
  {
    id: 'aconex-uk',
    label: 'Aconex – United Kingdom',
    baseUrl: 'https://uk1.aconex.co.uk/bcf',
    authMethods: ['oauth', 'token'],
    note: VENDOR_NOTE,
  },
  {
    id: 'bimcollab',
    label: 'BIMcollab',
    baseUrl: '',
    authMethods: ['oauth', 'token'],
    note: 'Your space URL plus /bcf, e.g. https://myspace.bimcollab.com/bcf.',
  },
  {
    id: 'bimdata',
    label: 'BIMData.io',
    baseUrl: 'https://api.bimdata.io/bcf',
    authMethods: ['oauth', 'token'],
    note: 'Paste an access token from your BIMData account (developers.bimdata.io).',
  },
  {
    id: 'bimtrack',
    label: 'BIM Track (Newforma Konekt)',
    baseUrl: 'https://bcfrestapi.bimtrackapp.co/bcf',
    authMethods: ['oauth', 'token'],
    note: VENDOR_NOTE,
  },
  {
    id: 'catenda',
    label: 'Catenda Hub (Bimsync)',
    baseUrl: 'https://api.catenda.com/opencde/bcf',
    authMethods: ['oauth', 'token'],
    note: 'Paste an access token from a Catenda OAuth application.',
  },
  {
    id: 'dalux',
    label: 'Dalux Field',
    baseUrl: 'https://field.dalux.com/service/bcf',
    authMethods: ['oauth', 'token'],
    note: VENDOR_NOTE,
  },
  {
    id: 'openproject',
    label: 'OpenProject',
    baseUrl: '',
    authMethods: ['oauth', 'clientCredentials', 'token'],
    note: 'Your instance URL plus /api/bcf, e.g. https://project.example.com/api/bcf. Create an OAuth application with client credentials in the OpenProject admin settings.',
  },
  {
    id: 'streambim',
    label: 'StreamBIM',
    baseUrl: 'https://app.streambim.com/bcf',
    authMethods: ['oauth', 'token'],
    // StreamBIM's authorization endpoint (AWS Cognito) rejects requests
    // without an explicit scope; 'openid' is what its own integrations send.
    oauthScope: 'openid',
    note: VENDOR_NOTE,
  },
];

export function findBcfServerPreset(id: string): BcfServerPreset {
  return BCF_SERVER_PRESETS.find((preset) => preset.id === id) ?? BCF_SERVER_PRESETS[0];
}

/** Preset whose pre-filled URL matches a saved connection, else custom. */
export function presetForServerUrl(serverUrl: string): BcfServerPreset {
  const match = BCF_SERVER_PRESETS.find(
    (preset) => preset.baseUrl !== '' && preset.baseUrl === serverUrl,
  );
  return match ?? findBcfServerPreset(CUSTOM_PRESET_ID);
}

export const AUTH_METHOD_LABELS: Record<BcfAuthMethod, string> = {
  password: 'Email & password',
  oauth: 'Sign in via browser',
  token: 'Access token',
  clientCredentials: 'Client ID & secret',
};
