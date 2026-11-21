/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { coordinationSources } from '@/services/coordination-hosts';
import { loadResolvedSourcePrefs, saveSourcePrefs, clearSourcePrefs, isPrefsConfigured } from '@/lib/sources/preferences';
import { coordination, idSchema } from './coordination-common';
function provider(id: string) { const host = coordinationSources(), provider = host.get(id); if (!provider) throw new Error('Unknown source provider.'); return { host, provider }; }
export const coordinationSourceSettingsOperations = [
  coordination<{ provider: string; values: Array<{ name: string; value: string }> }>('sources.configure', 'Patch only manifest-declared provider preferences through native storage. Credential values are accepted for the selected provider but never returned.', ['configuration'], {
    type: 'object', properties: { provider: { type: 'string', minLength: 1, maxLength: 200 }, values: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 200 }, value: { type: 'string', maxLength: 10000 } }, required: ['name', 'value'], additionalProperties: false } } }, required: ['provider', 'values'], additionalProperties: false,
  }, (i, c) => {
    const { provider: source } = provider(i.provider), prefs = loadResolvedSourcePrefs(source.manifest), seen = new Set<string>();
    for (const item of i.values) {
      const declaration = source.manifest.preferences.find(pref => pref.name === item.name);
      if (!declaration || seen.has(item.name)) throw new Error('Every preference must have one exact manifest declaration.'); seen.add(item.name);
      if (declaration.type === 'checkbox' && !['true', 'false'].includes(item.value)) throw new Error('Checkbox preference expects true or false.');
      if (declaration.type === 'dropdown' && !declaration.options?.some(option => option.value === item.value)) throw new Error('Preference is not one of the native dropdown options.');
      prefs[item.name] = item.value;
    }
    // configured describes what was stored: unsaved values are not what the next browse reads.
    return c.commit(() => { const saved = saveSourcePrefs(i.provider, prefs); return { provider: i.provider, saved, configured: isPrefsConfigured(source.manifest, saved ? prefs : loadResolvedSourcePrefs(source.manifest)) }; });
  }),
  coordination('sources.forgetPreferences', 'Clear saved provider preferences and credentials through the native forget control. Does not delete remote files.', ['configuration'], idSchema, (i, c) => {
    provider(i.id); return c.commit(() => ({ provider: i.id, cleared: clearSourcePrefs(i.id) }));
  }),
  coordination('sources.testConnection', 'Run the selected provider native connection diagnostic with saved credentials and network sandbox.', ['network', 'read'], idSchema, async (i, c) => {
    const { host, provider: source } = provider(i.id); if (!source.testConnection) throw new Error('This provider does not implement a native connection test.');
    const prefs = loadResolvedSourcePrefs(source.manifest); c.checkpoint?.(); const result = await source.testConnection(host.createContext(source.manifest, prefs)); c.checkpoint?.();
    let message = result.message;
    for (const declaration of source.manifest.preferences.filter(pref => pref.type === 'password')) { const secret = prefs[declaration.name]; if (secret) message = message.split(secret).join('[redacted]'); }
    return { ...result, message };
  }),
  coordination('sources.signOut', 'Sign out through the selected native provider auth lifecycle; tokens remain private to that provider.', ['network', 'configuration'], idSchema, async (i, c) => {
    const { host, provider: source } = provider(i.id); if (!source.auth) throw new Error('This provider uses saved preferences rather than an interactive sign-in session.');
    const ctx = host.createContext(source.manifest, loadResolvedSourcePrefs(source.manifest));
    return c.commitAsync(async () => { await source.auth!.signOut(ctx); return { provider: i.id, signed_out: true }; });
  }),
];
