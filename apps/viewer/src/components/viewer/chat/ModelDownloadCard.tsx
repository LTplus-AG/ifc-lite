/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Inline progress card shown in the chat panel while a local (WebLLM) model
 * is downloading on first use. Subscribes to {@link onWebLLMProgress} and
 * unmounts itself once the active model id matches the engine's loaded id.
 *
 * The actual download is kicked off by {@link streamWebLLMChat} on the first
 * send; this card just renders the side-effect.
 */

import { useCallback, useEffect, useState } from 'react';
import { Cpu, Loader2, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import {
  ensureWebLLMEngine,
  getActiveWebLLMModelId,
  onWebLLMProgress,
  type WebLLMProgress,
} from '@/lib/llm/webllm-engine';
import { getLocalModelMeta, getModelById } from '@/lib/llm/models';
import {
  grantWebLLMConsent,
  hasWebLLMConsent,
  subscribeWebLLMConsent,
} from '@/lib/llm/webllm-consent';

interface Props {
  /** The model the user has selected. Card hides if this isn't a local model. */
  modelId: string;
}

function formatSize(approxMB: number): string {
  return approxMB >= 1000 ? `${(approxMB / 1000).toFixed(1)} GB` : `${approxMB} MB`;
}

export function ModelDownloadCard({ modelId }: Props) {
  const model = getModelById(modelId);
  const meta = getLocalModelMeta(modelId);
  const [progress, setProgress] = useState<WebLLMProgress | null>(null);
  const [loaded, setLoaded] = useState<boolean>(getActiveWebLLMModelId() === modelId);
  const [consented, setConsented] = useState<boolean>(() => hasWebLLMConsent(modelId));
  const [starting, setStarting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    setLoaded(getActiveWebLLMModelId() === modelId);
    setProgress(null);
    setConsented(hasWebLLMConsent(modelId));
    setErrorMsg(null);
    const offProgress = onWebLLMProgress((event) => {
      if (event.modelId !== modelId) return;
      setProgress(event);
      if ((event.progress ?? 0) >= 1) setLoaded(true);
    });
    const offConsent = subscribeWebLLMConsent(() => {
      setConsented(hasWebLLMConsent(modelId));
    });
    return () => { offProgress(); offConsent(); };
  }, [modelId]);

  const startDownload = useCallback(async () => {
    if (starting) return;
    setStarting(true);
    setErrorMsg(null);
    grantWebLLMConsent(modelId);
    try {
      await ensureWebLLMEngine(modelId);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }, [modelId, starting]);

  if (!model || model.source !== 'webllm') return null;

  const downloading = progress != null && (progress.progress ?? 0) < 1;
  const finished = loaded || (progress?.progress ?? 0) >= 1;

  if (finished && consented && !errorMsg) return null;

  const sizeLabel = meta ? formatSize(meta.approxSizeMB) : null;
  const pct = Math.round((progress?.progress ?? 0) * 100);

  // ── Consent state: user picked a local model but hasn't agreed to the download yet
  if (!consented && !downloading) {
    return (
      <div className="mx-2 my-1 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs">
        <div className="flex items-start gap-2">
          <Cpu className="h-3.5 w-3.5 mt-0.5 text-emerald-500 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">{model.name}</div>
            {meta && (
              <p className="mt-0.5 text-[11px] text-muted-foreground leading-snug">
                Download <strong>{sizeLabel}</strong> once. Then runs entirely in your browser —
                free, private, works offline. Your IFC data never leaves your device.
              </p>
            )}
            <div className="mt-2 flex items-center gap-2">
              <Button size="sm" className="h-6 text-[11px]" onClick={startDownload} disabled={starting}>
                <Download className="h-3 w-3 mr-1" />
                Download {sizeLabel}
              </Button>
              {meta && (
                <span className="text-[10px] text-muted-foreground">
                  Cached for next time · {meta.vramRequirementGB} GB VRAM
                </span>
              )}
            </div>
            {errorMsg && (
              <p className="mt-1.5 text-[11px] text-destructive">{errorMsg}</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Downloading or loading-into-memory
  return (
    <div className="mx-2 my-1 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        {!finished ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-500" />
        ) : (
          <Cpu className="h-3.5 w-3.5 text-emerald-500" />
        )}
        <span className="font-medium">{model.name}</span>
        {sizeLabel && <span className="text-muted-foreground">· {sizeLabel}</span>}
        {progress?.progress != null && (
          <span className="ml-auto font-mono text-muted-foreground">{pct}%</span>
        )}
      </div>
      <Progress value={pct} className="mt-1.5 h-1" />
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        {progress?.text ?? 'Preparing model — runs entirely in your browser, no data leaves your device.'}
      </p>
      {errorMsg && <p className="mt-1.5 text-[11px] text-destructive">{errorMsg}</p>}
    </div>
  );
}
