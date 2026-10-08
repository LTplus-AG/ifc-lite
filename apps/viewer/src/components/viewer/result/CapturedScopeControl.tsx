/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { CapturedEntityScope } from '@ifc-lite/rules';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { captureArtifactScope } from '@/lib/captured-artifact-scope';
import { useViewerStore } from '@/store';

/** Membership changes only on an explicit capture or clear action (#7186). */
export function CapturedScopeControl({ scope, onChange }: {
  scope?: CapturedEntityScope;
  onChange: (scope: CapturedEntityScope | undefined) => void;
}) {
  const { t } = useTranslation();
  const capture = (mode: CapturedEntityScope['mode']) => {
    try { onChange(captureArtifactScope(mode, useViewerStore.getState())); }
    catch (error) {
      console.warn('[Artifact scope] Capture refused:', error);
      toast.error(error instanceof Error ? error.message : t('capturedArtifacts.captureFailed'));
    }
  };
  return <fieldset className="space-y-2 rounded border border-border p-2 text-xs">
    <legend className="px-1 font-medium">{t('capturedArtifacts.population')}</legend>
    <p>{scope ? t(scope.mode === 'selected' ? 'capturedArtifacts.selectedCaption' : 'capturedArtifacts.visibleCaption', {
      count: scope.sources.reduce((count, source) => count + source.members.length, 0), files: t('capturedArtifacts.files', { count: scope.sources.length }),
    }) : t('capturedArtifacts.all')}</p>
    <div className="flex flex-wrap gap-1">
      <Button type="button" size="sm" variant="outline" onClick={() => capture('selected')}>{t('capturedArtifacts.captureSelected')}</Button>
      <Button type="button" size="sm" variant="outline" onClick={() => capture('visible')}>{t('capturedArtifacts.captureVisible')}</Button>
      {scope && <Button type="button" size="sm" variant="outline" onClick={() => onChange(undefined)}>{t('capturedArtifacts.clear')}</Button>}
    </div>
  </fieldset>;
}
