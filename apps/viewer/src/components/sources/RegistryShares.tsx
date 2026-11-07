/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useId, useState } from 'react';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { localRegistryAddress } from '@/lib/registry/connection';
import { RegistryError } from '@/lib/registry/protocol';
import type { RegistryTransport } from '@/lib/registry/transport';

interface Share { id: string; expires_at: number; revoked: boolean }
function shareList(value: unknown): Share[] {
  if (!value || typeof value !== 'object' || !('shares' in value) || !Array.isArray(value.shares)) throw new RegistryError('Invalid share list.');
  return value.shares.map((item: unknown) => {
    if (!item || typeof item !== 'object' || !('id' in item) || typeof item.id !== 'string' || !/^[a-f0-9-]+$/.test(item.id) ||
      !('expires_at' in item) || typeof item.expires_at !== 'number' || !Number.isSafeInteger(item.expires_at) || !('revoked' in item) || typeof item.revoked !== 'boolean') throw new RegistryError('Invalid share record.');
    return { id: item.id, expires_at: item.expires_at, revoked: item.revoked };
  });
}

/** Explicit TTL and live publishing consent; links stay in component memory. */
export function RegistryShares({ transport, repository, tag, busy, run }: {
  transport: RegistryTransport; repository: string; tag: string; busy: boolean; run: (operation: () => Promise<void>) => void;
}) {
  const { t } = useTranslation();
  const id = useId(); const [opened, setOpened] = useState(false); const [hours, setHours] = useState('24');
  const [mode, setMode] = useState('snapshot'); const [link, setLink] = useState(''); const [shares, setShares] = useState<Share[]>([]);
  if (transport.session?.authorizationType !== 'session') return null;
  const load = async () => setShares(shareList(await transport.shareRequest('/shares')));
  return <div className="grid gap-2 border-t pt-3">
    <Button variant="ghost" disabled={busy} onClick={() => { setOpened(!opened); if (!opened) run(load); }}>{t('registry.share.manage')}</Button>
    {opened && <>
      <p className="text-xs text-muted-foreground">{t('registry.share.notice')}</p>
      <Label htmlFor={`${id}-mode`}>{t('registry.share.access')}</Label>
      <select id={`${id}-mode`} value={mode} onChange={e => { setMode(e.target.value); setLink(''); }} disabled={busy} className="h-9 rounded-md border bg-background px-2 text-sm">
        <option value="snapshot">{t('registry.share.snapshot')}</option><option value="live">{t('registry.share.live')}</option>
        {transport.can('push', repository) && <option value="publish">{t('registry.share.publish')}</option>}
      </select>
      <Label htmlFor={`${id}-ttl`}>{t('registry.share.hours')}</Label>
      <Input id={`${id}-ttl`} type="number" min="1" max="720" step="1" value={hours} disabled={busy} onChange={e => { setHours(e.target.value); setLink(''); }} />
      <Button disabled={busy || !repository || (mode === 'snapshot' && (!tag || tag.startsWith('sha256:')))} onClick={() => run(async () => {
        const ttl = Number(hours) * 3600;
        if (!Number.isSafeInteger(ttl) || ttl < 3600 || ttl > 30 * 86400) throw new RegistryError('Choose between 1 and 720 hours.');
        const result = await transport.shareRequest('/shares', { method: 'POST', body: JSON.stringify({ version: 1, registry: new URL(localRegistryAddress).host,
          grants: [{ repositories: [repository], ...(mode === 'snapshot' ? { tags: [tag] } : {}), actions: mode === 'publish' ? ['pull', 'push'] : ['pull'] }], ttl, binding: mode === 'snapshot' ? 'snapshot' : 'live' }) });
        if (!result || typeof result !== 'object' || !('url' in result) || typeof result.url !== 'string') throw new RegistryError('Invalid share link.');
        const url = new URL(result.url);
        if (url.origin !== new URL(localRegistryAddress).origin || url.pathname !== '/share' || url.search || !/^#secret=[a-f0-9]{64}$/.test(url.hash)) throw new RegistryError('Invalid share link.');
        setLink(url.href); await load();
      })}>{t('registry.share.create')}</Button>
      {link && <><Label htmlFor={`${id}-link`}>{t('registry.share.link')}</Label><Input id={`${id}-link`} readOnly value={link} /><Button variant="outline" disabled={busy} onClick={() => run(() => navigator.clipboard.writeText(link))}>{t('registry.share.copy')}</Button></>}
      {shares.filter(s => !s.revoked && s.expires_at * 1000 > Date.now()).map(s => <div key={s.id} className="flex items-center justify-between gap-2"><span className="text-xs">{s.id.slice(0, 8)} · {new Date(s.expires_at * 1000).toLocaleString()}</span>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => run(async () => { await transport.shareRequest(`/shares/${s.id}/revoke`, { method: 'POST' }); setLink(''); await load(); })}>{t('registry.share.revoke')}</Button></div>)}
    </>}
  </div>;
}
