/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useRef, useState } from 'react';
import type { ModelSelector } from '@ifc-lite/flow-nodes';
import { findModelTagByName } from '@/store/slices/modelTagsSlice';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { useViewerStore } from '@/store';
import { downloadBlob, sanitizeFilename } from '@/lib/export/download';
import { readComparisonRecipe, serializeComparisonRecipe } from '@/lib/compare/comparison-recipe-io';
import type { ComparisonRecipe } from '@/lib/compare/comparison-recipe';
import type { FederatedModel } from '@/store/types';

function filename(model: FederatedModel): string { return model.sourceFile?.name ?? model.name; }

function resolveSelector(selector: ModelSelector, state: ReturnType<typeof useViewerStore.getState>): string {
  if (selector.kind === 'slot') throw new Error('This setup uses workflow file slots. Open it in a Flow workflow.');
  const tag = selector.kind === 'tagName' ? findModelTagByName(state.modelTags, selector.tagName) : undefined;
  const matches = [...state.models.values()].filter((model) => selector.kind === 'filename'
    ? filename(model) === selector.filename
    : tag !== undefined && state.modelTagAssignments.get(model.id)?.has(tag.id));
  if (matches.length !== 1) throw new Error('The comparison setup must resolve exactly one loaded model for each side.');
  return matches[0].id;
}

export function CompareSetupControls() {
  const { t } = useTranslation();
  const [opened, setOpened] = useState<{ recipe: ComparisonRecipe; baseId: string; headId: string } | null>(null);
  const running = useViewerStore((s) => s.compareRunning);
  const input = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  const save = () => {
    try {
      const state = useViewerStore.getState();
      const base = state.models.get(state.compareBaseModelId ?? '');
      const head = state.models.get(state.compareHeadModelId ?? '');
      if (!base || !head || base.id === head.id) throw new Error('Select two different models before saving a setup.');
      const recipe: ComparisonRecipe = {
        kind: 'ifc-lite-comparison-recipe', version: 1, id: opened?.recipe.id ?? crypto.randomUUID(), name: `${base.name} vs ${head.name}`,
        base: opened?.baseId === base.id ? opened.recipe.base : { kind: 'filename', filename: filename(base) },
        head: opened?.headId === head.id ? opened.recipe.head : { kind: 'filename', filename: filename(head) },
        options: { scope: state.compareScope, excludedTypes: [...state.compareExcludedTypes],
          matchByContent: state.compareMatchByContent, keyProperty: state.compareKeyProperty },
      };
      downloadBlob(new Blob([serializeComparisonRecipe(recipe)], { type: 'application/json' }),
        `${sanitizeFilename(recipe.name)}.comparison.json`);
      setMessage(null);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };
  const open = async (file: File) => {
    try {
      if (file.size > 1_000_000) throw new Error('Comparison recipe exceeds 1 MB.');
      const recipe = readComparisonRecipe(await file.text());
      const state = useViewerStore.getState();
      if (state.compareRunning) throw new Error('Cancel the active comparison before opening a setup.');
      const baseId = resolveSelector(recipe.base, state), headId = resolveSelector(recipe.head, state);
      if (baseId === headId) throw new Error('Comparison setup must select two different models.');
      state.clearCompare();
      state.setCompareBaseModelId(baseId); state.setCompareHeadModelId(headId);
      state.setCompareScope(recipe.options.scope); state.setCompareExcludedTypes(recipe.options.excludedTypes);
      state.setCompareMatchByContent(recipe.options.matchByContent); state.setCompareKeyProperty(recipe.options.keyProperty);
      setOpened({ recipe, baseId, headId });
      setMessage(t('comparePanel.setup.opened'));
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };
  return <div className="border-b border-border px-3 py-2 text-xs">
    <div className="flex gap-2">
      <Button variant="outline" size="sm" disabled={running} onClick={save}>{t('comparePanel.setup.save')}</Button>
      <Button variant="outline" size="sm" disabled={running} onClick={() => input.current?.click()}>{t('comparePanel.setup.open')}</Button>
      <input ref={input} className="hidden" type="file" accept=".comparison.json,application/json"
        aria-label={t('comparePanel.setup.open')} onChange={(event) => {
          const file = event.target.files?.[0]; event.target.value = ''; if (file) void open(file);
        }} />
    </div>
    {message && <output className="block pt-2 break-words">{message}</output>}
  </div>;
}
