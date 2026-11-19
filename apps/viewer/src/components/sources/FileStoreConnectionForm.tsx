/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useId, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTranslation } from '@/i18n';
import { saveRegistryConnection, type RegistryConnection } from '@/lib/registry/handoff-contract';

export function FileStoreConnectionForm({ connection, onSaved, onCancel }: {
  connection?: RegistryConnection;
  onSaved: (result: ReturnType<typeof saveRegistryConnection>) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [error, setError] = useState('');
  const exchange = connection?.token_exchange;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const read = (key: string) => String(form.get(key) ?? '').trim();
    const settings = {
      endpoint: read('endpoint'),
      authorization_resource: read('resource'),
      read_scope: read('read-scope'),
      write_scope: read('write-scope'),
    };
    try {
      onSaved(saveRegistryConnection({
        registry: connection?.registry ?? read('registry'),
        authorization_server: read('issuer'),
        client_id: read('client'),
        name: connection?.name,
        token_exchange: Object.values(settings).some(Boolean) ? settings : undefined,
      }, Boolean(connection)));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('registry.failed'));
    }
  }

  return <form className="grid gap-3" aria-labelledby={`${id}-title`} onSubmit={submit}>
    <h3 id={`${id}-title`} className="text-sm font-medium">{t(connection ? 'registry.connections.edit' : 'registry.connections.add')}</h3>
    <Label htmlFor={`${id}-registry`}>{t('registry.address')}</Label>
    <Input id={`${id}-registry`} name="registry" type="url" defaultValue={connection?.registry} readOnly={Boolean(connection)}
      autoComplete="off" required />
    <Label htmlFor={`${id}-issuer`}>{t('registry.connections.issuer')}</Label>
    <Input id={`${id}-issuer`} name="issuer" type="url" defaultValue={connection?.authorization_server} autoComplete="off" required />
    <Label htmlFor={`${id}-client`}>{t('registry.connections.clientId')}</Label>
    <Input id={`${id}-client`} name="client" defaultValue={connection?.client_id} autoComplete="off" required />
    <details open={exchange ? true : undefined}>
      <summary className="cursor-pointer text-sm">{t('registry.connections.tokenExchange')}</summary>
      <div className="mt-2 grid gap-2">
        <Label htmlFor={`${id}-endpoint`}>{t('registry.connections.exchangeEndpoint')}</Label>
        <Input id={`${id}-endpoint`} name="endpoint" type="url" defaultValue={exchange?.endpoint} autoComplete="off" />
        <Label htmlFor={`${id}-resource`}>{t('registry.connections.exchangeResource')}</Label>
        <Input id={`${id}-resource`} name="resource" type="url" defaultValue={exchange?.authorization_resource} autoComplete="off" />
        <Label htmlFor={`${id}-read-scope`}>{t('registry.connections.readScope')}</Label>
        <Input id={`${id}-read-scope`} name="read-scope" defaultValue={exchange?.read_scope} autoComplete="off" />
        <Label htmlFor={`${id}-write-scope`}>{t('registry.connections.writeScope')}</Label>
        <Input id={`${id}-write-scope`} name="write-scope" defaultValue={exchange?.write_scope} autoComplete="off" />
      </div>
    </details>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex flex-wrap gap-2">
      <Button type="submit">{t('registry.connections.save')}</Button>
      <Button type="button" variant="outline" onClick={onCancel}>{t('registry.connections.cancel')}</Button>
    </div>
  </form>;
}
