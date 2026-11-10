/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ReactNode } from 'react';
import { KeyRound } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import type { getByokModelsForSource } from '@/lib/llm/models';

// ── header / key entry + model picker ─────────────────────────────────────

export function PlaygroundHeader({
  hasKey,
  maskedKey,
  onOpenKeyModal,
  selectedModel,
  anthropicModels,
  onChangeModel,
}: {
  hasKey: boolean;
  maskedKey: string;
  onOpenKeyModal: () => void;
  selectedModel: string;
  anthropicModels: ReturnType<typeof getByokModelsForSource>;
  onChangeModel: (modelId: string) => void;
}): ReactNode {
  const { t } = useTranslation(); return (
    <div className="flex items-center justify-between gap-2 border-b border-white/10 px-4 py-2.5">
      <div className="flex items-center gap-2">
        <span
          className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[#d6ff3f]"
          aria-hidden
        />
        <span
          className="text-2xs uppercase tracking-[0.22em] text-white/60"
          style={{ fontFamily: '"JetBrains Mono", monospace' }}
        >
          {t('mcp.playgroundChat.brand')}
        </span>
      </div>

      <div className="flex items-center gap-2">
        {/* Model picker — Anthropic-only because the playground driver uses
            Anthropic's native tools API. The dropdown's styling mirrors the
            key-status pill so the two affordances read as a single cluster. */}
        <label
          className="inline-flex items-center gap-1 rounded border border-white/15 bg-white/[0.03] px-1.5 py-1 text-2xs text-white/70"
          style={{ fontFamily: '"JetBrains Mono", monospace' }}
          title={t('mcp.playgroundChat.modelTooltip')}
        >
          <span className="text-white/40">{t('mcp.playgroundChat.modelLabel')}</span>
          <select
            value={selectedModel}
            onChange={(e) => onChangeModel(e.target.value)}
            className="bg-transparent text-2xs outline-none [&>option]:bg-[#0a0a0c] [&>option]:text-white"
            style={{ fontFamily: '"JetBrains Mono", monospace' }}
            aria-label={t('mcp.playgroundChat.selectModelAria')}
          >
            {anthropicModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>

        {/* Key-status pill — opens the shared BYOK modal so the playground
            and the viewer chat share one trust-focused entry surface. */}
        <button
          onClick={onOpenKeyModal}
          className={cn(
            'inline-flex items-center gap-1.5 rounded border px-2 py-1 text-2xs',
            hasKey
              ? 'border-[#d6ff3f]/40 text-[#d6ff3f] hover:bg-[#d6ff3f]/5'
              : 'border-orange-400/40 text-orange-300 hover:bg-orange-400/5',
          )}
          style={{ fontFamily: '"JetBrains Mono", monospace' }}
          aria-label={hasKey ? t('mcp.playgroundChat.manageKeyAria') : t('mcp.playgroundChat.addKeyAria')}
        >
          <KeyRound size={11} />
          {hasKey ? t('mcp.playgroundChat.keySetLabel', { masked: maskedKey }) : t('mcp.playgroundChat.setKeyLabel')}
        </button>
      </div>
    </div>
  );
}

