/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { getLocale } from '@/i18n/registry';
import type { RegistryRelease } from '@/lib/registry/artifacts';

export function RegistryPublication({ release }: { release: RegistryRelease }) {
  const { t } = useTranslation();
  return <div className="space-y-1 rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
    <p className="font-medium text-foreground">{release.title}</p>
    <p>{release.publisher ? t('registry.publisher', { name: release.publisher }) : t('registry.publisherUnknown')}</p>
    {release.pushedAt ? <time dateTime={new Date(release.pushedAt * 1000).toISOString()}>{new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(release.pushedAt * 1000)}</time> : <p>{t('registry.timeUnknown')}</p>}
  </div>;
}

export function RegistryReleaseDetails({ address, repository, release, fingerprint, onCopy }: {
  address: string; repository: string; release?: RegistryRelease; fingerprint: string; onCopy: () => void;
}) {
  const { t } = useTranslation();
  return <details className="min-w-0 border-t pt-2 text-xs text-muted-foreground">
    <summary className="cursor-pointer">{t('registry.details')}</summary>
    <dl className="mt-2 grid min-w-0 gap-1">
      <dt>{t('registry.address')}</dt><dd className="break-all">{address}</dd>
      <dt>{t('registry.location')}</dt><dd className="break-all">{repository}</dd>
      {fingerprint && <><dt>{t('registry.fingerprint')}</dt><dd className="break-all font-mono">{fingerprint}</dd></>}
      {release?.declaredAuthors && <><dt>{t('registry.declaredAuthor')}</dt><dd>{release.declaredAuthors}</dd></>}
      {release?.createdAt && <><dt>{t('registry.declaredCreated')}</dt><dd>{release.createdAt}</dd></>}
    </dl>
    {fingerprint && <Button type="button" variant="ghost" size="sm" onClick={onCopy}>{t('registry.copyFingerprint')}</Button>}
  </details>;
}
