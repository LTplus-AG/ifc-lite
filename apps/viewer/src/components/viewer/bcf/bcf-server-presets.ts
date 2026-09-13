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
  /**
   * Set when the vendor issues OAuth client ids to application vendors only,
   * never to the people who administer a space. Without a deployment-held
   * app (see `vendorAppForPreset`) the browser sign-in cannot start, and the
   * form says so instead of asking the user to register an app they cannot.
   */
  vendorIssuedClientsOnly?: boolean;
  /** Short hint rendered under the server picker. */
  note?: string;
}

/**
 * OAuth public client this deployment holds with a named vendor, so its users
 * sign in without ever seeing a client id. Read from the allowlisted build env:
 *
 *   VITE_BCF_APP_<PRESET>_CLIENT_ID      required; absent = no app
 *   VITE_BCF_APP_<PRESET>_REDIRECT_URI   only when the vendor registered a
 *                                        different callback than this
 *                                        origin's `/oauth/bcf/callback`
 *
 * `<PRESET>` is the preset id upper-cased with `-` as `_`, e.g.
 * `VITE_BCF_APP_BIMCOLLAB_CLIENT_ID`. Vendor apps are OAuth public clients:
 * no client secret is read from `VITE_*` or sent from the browser. PKCE and
 * the registered redirect URI protect the authorization code. Confidential
 * clients require a server-side token exchange and are not supported here.
 */
export interface BcfVendorApp {
  clientId: string;
  /** Absolute redirect URI registered with the vendor; empty = the default. */
  redirectUri: string;
}

function publicVendorEnv(presetId: string): readonly [string | undefined, string | undefined] | null {
  switch (presetId) {
    case 'aconex-americas':
      return [
        import.meta.env.VITE_BCF_APP_ACONEX_AMERICAS_CLIENT_ID,
        import.meta.env.VITE_BCF_APP_ACONEX_AMERICAS_REDIRECT_URI,
      ];
    case 'aconex-asia':
      return [
        import.meta.env.VITE_BCF_APP_ACONEX_ASIA_CLIENT_ID,
        import.meta.env.VITE_BCF_APP_ACONEX_ASIA_REDIRECT_URI,
      ];
    case 'aconex-aunz':
      return [
        import.meta.env.VITE_BCF_APP_ACONEX_AUNZ_CLIENT_ID,
        import.meta.env.VITE_BCF_APP_ACONEX_AUNZ_REDIRECT_URI,
      ];
    case 'aconex-europe':
      return [
        import.meta.env.VITE_BCF_APP_ACONEX_EUROPE_CLIENT_ID,
        import.meta.env.VITE_BCF_APP_ACONEX_EUROPE_REDIRECT_URI,
      ];
    case 'aconex-hongkong':
      return [
        import.meta.env.VITE_BCF_APP_ACONEX_HONGKONG_CLIENT_ID,
        import.meta.env.VITE_BCF_APP_ACONEX_HONGKONG_REDIRECT_URI,
      ];
    case 'aconex-china':
      return [
        import.meta.env.VITE_BCF_APP_ACONEX_CHINA_CLIENT_ID,
        import.meta.env.VITE_BCF_APP_ACONEX_CHINA_REDIRECT_URI,
      ];
    case 'aconex-saudi':
      return [
        import.meta.env.VITE_BCF_APP_ACONEX_SAUDI_CLIENT_ID,
        import.meta.env.VITE_BCF_APP_ACONEX_SAUDI_REDIRECT_URI,
      ];
    case 'aconex-uk':
      return [
        import.meta.env.VITE_BCF_APP_ACONEX_UK_CLIENT_ID,
        import.meta.env.VITE_BCF_APP_ACONEX_UK_REDIRECT_URI,
      ];
    case 'bimcollab':
      return [
        import.meta.env.VITE_BCF_APP_BIMCOLLAB_CLIENT_ID,
        import.meta.env.VITE_BCF_APP_BIMCOLLAB_REDIRECT_URI,
      ];
    case 'bimdata':
      return [
        import.meta.env.VITE_BCF_APP_BIMDATA_CLIENT_ID,
        import.meta.env.VITE_BCF_APP_BIMDATA_REDIRECT_URI,
      ];
    case 'bimtrack':
      return [
        import.meta.env.VITE_BCF_APP_BIMTRACK_CLIENT_ID,
        import.meta.env.VITE_BCF_APP_BIMTRACK_REDIRECT_URI,
      ];
    case 'catenda':
      return [
        import.meta.env.VITE_BCF_APP_CATENDA_CLIENT_ID,
        import.meta.env.VITE_BCF_APP_CATENDA_REDIRECT_URI,
      ];
    case 'dalux':
      return [
        import.meta.env.VITE_BCF_APP_DALUX_CLIENT_ID,
        import.meta.env.VITE_BCF_APP_DALUX_REDIRECT_URI,
      ];
    case 'openproject':
      return [
        import.meta.env.VITE_BCF_APP_OPENPROJECT_CLIENT_ID,
        import.meta.env.VITE_BCF_APP_OPENPROJECT_REDIRECT_URI,
      ];
    case 'streambim':
      return [
        import.meta.env.VITE_BCF_APP_STREAMBIM_CLIENT_ID,
        import.meta.env.VITE_BCF_APP_STREAMBIM_REDIRECT_URI,
      ];
    default:
      return null;
  }
}

export function vendorAppEnvPrefix(presetId: string): string {
  return `VITE_BCF_APP_${presetId.toUpperCase().replace(/-/g, '_')}`;
}

export function vendorAppForPreset(presetId: string): BcfVendorApp | null {
  // Static property reads are deliberate. Vite replaces them individually;
  // aliasing the whole import.meta.env object would serialize every VITE_*
  // value into the browser bundle, including a mistakenly configured secret.
  const values = publicVendorEnv(presetId);
  if (!values) return null;
  const clientId = (values[0] ?? '').trim();
  if (!clientId) return null;
  return {
    clientId,
    redirectUri: (values[1] ?? '').trim(),
  };
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
    // BIMcollab's IdentityServer rejects a scope-less authorize request with
    // `invalid_request`; measured on playground.bimcollab.com against a valid
    // client, two requests differing only in this parameter. These three are
    // what the Connection API implementation guide documents.
    oauthScope: 'openid offline_access bcf',
    // BIMcollab issues a client id to an application once it has been
    // demonstrated to them (Connection API implementation guide, §
    // Authentication); a space administrator cannot create one. Their
    // IdentityServer also refuses the password and client-credentials grants
    // for such a client (`unauthorized_client`, measured on
    // playground.bimcollab.com against the published playground client), so
    // the browser's PKCE public-client flow through a deployment-held app is
    // the only sign-in that can work — and the reason for
    // `vendorAppForPreset`.
    vendorIssuedClientsOnly: true,
    note: 'Your space URL, e.g. https://myspace.bimcollab.com. The same address you give Solibri or a BCF manager.',
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
