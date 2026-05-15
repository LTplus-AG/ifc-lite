/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Trust pill — small badge sitting near the model name in the chat header
 * that names the actual API host requests are going to when a BYOK route is
 * active. Always-on for BYOK models (not just during streaming) so users can
 * see at a glance where their data is going, without having to open DevTools.
 *
 * Returns null for proxy/free routes — the pill is a BYOK-specific trust
 * signal; we don't need a "→ our proxy" pill cluttering the UI for the
 * default tier.
 */

import { useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { resolveStreamRoute } from '@/lib/llm/byok-guard';
import { getApiKeys, subscribeApiKeys, type ApiKeyConfig } from '@/services/api-keys';

interface ByokStreamingPillProps {
  modelId: string;
  className?: string;
}

export function ByokStreamingPill({ modelId, className }: ByokStreamingPillProps) {
  const [apiKeys, setApiKeys] = useState<ApiKeyConfig>(() => getApiKeys());
  useEffect(() => subscribeApiKeys(() => setApiKeys(getApiKeys())), []);

  const route = resolveStreamRoute(modelId, apiKeys);
  if (route.kind !== 'anthropic' && route.kind !== 'openai') return null;

  const host = route.kind === 'anthropic' ? 'api.anthropic.com' : 'api.openai.com';
  const shortHost = route.kind === 'anthropic' ? 'anthropic.com' : 'openai.com';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-mono text-emerald-700 dark:text-emerald-400',
            className,
          )}
        >
          <Lock className="h-2.5 w-2.5" />
          {shortHost}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs leading-relaxed">
        Messages from this model go directly from your browser to{' '}
        <code className="font-mono">{host}</code>. To verify, open DevTools →
        Network and filter <code className="font-mono">{shortHost}</code>.
      </TooltipContent>
    </Tooltip>
  );
}
