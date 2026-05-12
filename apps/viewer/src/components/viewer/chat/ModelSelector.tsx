/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ModelSelector — dropdown to pick the LLM model.
 * Free models available to everyone via server proxy.
 * BYOK models selectable always — greyed out with lock icon when key is missing,
 * fully styled when key is configured. Selecting a locked model triggers the
 * inline key prompt in ChatPanel.
 */

import { useCallback, useEffect, useState } from 'react';
import { Check, Key } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useViewerStore } from '@/store';
import { FREE_MODELS, getModelById, getByokModelsForSource } from '@/lib/llm/models';
import type { LLMModel } from '@/lib/llm/types';
import { hasAnthropicKey, hasOpenaiKey, subscribeApiKeys } from '@/services/api-keys';

function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(0)}M`;
  return `${(tokens / 1_000).toFixed(0)}K`;
}

function CostBadge({ cost }: { cost?: LLMModel['cost'] }) {
  if (!cost) return null;
  const color = cost === '$$$' ? 'text-amber-500' : cost === '$$' ? 'text-blue-500' : 'text-emerald-500';
  return <span className={`text-[10px] font-mono ${color}`}>{cost}</span>;
}

export function ModelSelector() {
  const activeModel = useViewerStore((s) => s.chatActiveModel);
  const setActiveModel = useViewerStore((s) => s.setChatActiveModel);

  const [hasAnthropic, setHasAnthropic] = useState(hasAnthropicKey);
  const [hasOpenai, setHasOpenai] = useState(hasOpenaiKey);

  useEffect(() => {
    const refresh = () => {
      setHasAnthropic(hasAnthropicKey());
      setHasOpenai(hasOpenaiKey());
    };
    return subscribeApiKeys(refresh);
  }, []);

  const handleChange = useCallback((value: string) => {
    setActiveModel(value);
  }, [setActiveModel]);

  const current = getModelById(activeModel);
  const anthropicModels = getByokModelsForSource('anthropic');
  const openaiModels = getByokModelsForSource('openai');

  return (
    <Select value={activeModel} onValueChange={handleChange}>
      <SelectTrigger className="h-6 text-xs w-auto min-w-[140px] gap-1 border-0 bg-transparent hover:bg-muted/50">
        <SelectValue>
          <span className="truncate flex items-center gap-1">
            {current?.name ?? activeModel}
            <CostBadge cost={current?.cost} />
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {/* Free tier */}
        {FREE_MODELS.length > 0 && (
          <>
            <div className="px-2 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
              Free
            </div>
            {FREE_MODELS.map((m) => (
              <SelectItem key={m.id} value={m.id} className="text-xs">
                <span className="flex items-center gap-1.5">
                  <span>{m.name}</span>
                  <span className="text-muted-foreground text-[10px]">{m.provider}</span>
                  <span className="text-muted-foreground/50 text-[10px]">{formatContextWindow(m.contextWindow)}</span>
                </span>
              </SelectItem>
            ))}
          </>
        )}

        {/* Anthropic BYOK */}
        {anthropicModels.length > 0 && (
          <>
            <div className="px-2 py-1 mt-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
              Anthropic
              {hasAnthropic
                ? <Check className="h-2.5 w-2.5 text-emerald-500" />
                : <Key className="h-2.5 w-2.5" />
              }
            </div>
            {anthropicModels.map((m) => (
              <SelectItem key={m.id} value={m.id} className={`text-xs ${!hasAnthropic ? 'opacity-50' : ''}`}>
                <span className="flex items-center gap-1.5">
                  <span>{m.name}</span>
                  <CostBadge cost={m.cost} />
                  <span className="text-muted-foreground/50 text-[10px]">{formatContextWindow(m.contextWindow)}</span>
                  {!hasAnthropic && <Key className="h-3 w-3 text-muted-foreground/50" />}
                </span>
              </SelectItem>
            ))}
          </>
        )}

        {/* OpenAI BYOK */}
        {openaiModels.length > 0 && (
          <>
            <div className="px-2 py-1 mt-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
              OpenAI
              {hasOpenai
                ? <Check className="h-2.5 w-2.5 text-emerald-500" />
                : <Key className="h-2.5 w-2.5" />
              }
            </div>
            {openaiModels.map((m) => (
              <SelectItem key={m.id} value={m.id} className={`text-xs ${!hasOpenai ? 'opacity-50' : ''}`}>
                <span className="flex items-center gap-1.5">
                  <span>{m.name}</span>
                  <CostBadge cost={m.cost} />
                  <span className="text-muted-foreground/50 text-[10px]">{formatContextWindow(m.contextWindow)}</span>
                  {!hasOpenai && <Key className="h-3 w-3 text-muted-foreground/50" />}
                </span>
              </SelectItem>
            ))}
          </>
        )}
      </SelectContent>
    </Select>
  );
}
