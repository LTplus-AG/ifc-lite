/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Trust-focused BYOK API key entry modal.
 *
 * Replaces the inline password-style strip in ChatPanel. Renders one tab per
 * supported provider; each tab pairs the request-flow SVG with concrete,
 * DevTools-verifiable trust claims, a clipboard-detect shortcut, and an
 * "Open Console → Create Key → return" walkthrough.
 *
 * The web build ships this. Desktop also uses it (the /settings page is
 * desktop-only and not deployed on Vercel).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronUp, ClipboardPaste, ExternalLink, Eye, EyeOff, Key, Trash2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/components/ui/toast';
import { ByokTrustDiagram } from './ByokTrustDiagram';
import { getByokModelsForSource } from '@/lib/llm/models';
import {
  getApiKeys,
  updateApiKeys,
  subscribeApiKeys,
  type ApiKeyConfig,
} from '@/services/api-keys';
import {
  looksLikeProviderKey,
  maskKey,
  readClipboardKey,
  type BYOKProvider,
} from '@/lib/llm/clipboard-detect';

const REPO_BLOB = 'https://github.com/louistrue/ifc-lite/blob/main';

const PROVIDER_META: Record<BYOKProvider, {
  label: string;
  apiHost: string;
  keyPrefix: string;
  placeholder: string;
  consoleUrl: string;
  consoleLabel: string;
  pricingHint: string;
}> = {
  anthropic: {
    label: 'Anthropic',
    apiHost: 'api.anthropic.com',
    keyPrefix: 'sk-ant-api03-',
    placeholder: 'sk-ant-api03-...',
    consoleUrl: 'https://console.anthropic.com/settings/keys',
    consoleLabel: 'console.anthropic.com',
    pricingHint: 'Pay-as-you-go on Anthropic billing. New accounts get $5 free credit.',
  },
  openai: {
    label: 'OpenAI',
    apiHost: 'api.openai.com',
    keyPrefix: 'sk-',
    placeholder: 'sk-...',
    consoleUrl: 'https://platform.openai.com/api-keys',
    consoleLabel: 'platform.openai.com',
    pricingHint: 'OpenAI requires prepaid credits or a payment method on your OpenAI account.',
  },
};

interface ByokKeyModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialProvider?: BYOKProvider;
}

export function ByokKeyModal({ open, onOpenChange, initialProvider = 'anthropic' }: ByokKeyModalProps) {
  const [provider, setProvider] = useState<BYOKProvider>(initialProvider);
  const [apiKeys, setApiKeys] = useState<ApiKeyConfig>(() => getApiKeys());

  // Re-sync the controlled tab whenever the modal re-opens with a (possibly new) initial provider.
  useEffect(() => {
    if (open) setProvider(initialProvider);
  }, [open, initialProvider]);

  // Keep saved-state badges in sync across open/save/clear.
  useEffect(() => {
    setApiKeys(getApiKeys());
    return subscribeApiKeys(() => setApiKeys(getApiKeys()));
  }, []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Key className="h-4 w-4" />
            Use your own API key
          </DialogTitle>
          <DialogDescription>
            Unlocks frontier models. Your key stays in this browser and goes
            straight to the provider — never through our servers.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={provider} onValueChange={(v) => setProvider(v as BYOKProvider)}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger
              value="anthropic"
              className="flex items-center gap-1.5 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm data-[state=active]:font-semibold"
            >
              Anthropic
              {apiKeys.anthropicKey && <Check className="h-3 w-3 text-emerald-500" />}
            </TabsTrigger>
            <TabsTrigger
              value="openai"
              className="flex items-center gap-1.5 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm data-[state=active]:font-semibold"
            >
              OpenAI
              {apiKeys.openaiKey && <Check className="h-3 w-3 text-emerald-500" />}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="anthropic" className="mt-4">
            <ProviderTab provider="anthropic" savedKey={apiKeys.anthropicKey} />
          </TabsContent>
          <TabsContent value="openai" className="mt-4">
            <ProviderTab provider="openai" savedKey={apiKeys.openaiKey} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

// ── Per-provider tab body ──────────────────────────────────────────────────

function ProviderTab({ provider, savedKey }: { provider: BYOKProvider; savedKey: string }) {
  const meta = PROVIDER_META[provider];

  const [value, setValue] = useState('');
  const [show, setShow] = useState(false);
  const [clipboardCandidate, setClipboardCandidate] = useState<string | null>(null);
  const [walkthroughOpen, setWalkthroughOpen] = useState(false);
  // Set when the user clicks "Open Console" so we re-poll the clipboard on tab return.
  const [awaitingClipboard, setAwaitingClipboard] = useState(false);

  const unlockedModels = useMemo(() => getByokModelsForSource(provider), [provider]);

  // NOTE: we deliberately do NOT call `readClipboardKey` on mount or tab switch.
  // On macOS Chromium, a background `clipboard.readText()` triggers the native
  // "Paste" affordance even when no user gesture is in play — surprising users
  // with an OS prompt the moment they open the modal.
  //
  // Instead, clipboard detection runs in three explicit, user-gestured paths:
  //   1. user pastes into the input (handled by the onPaste handler below)
  //   2. user clicks the "Detect from clipboard" button (also below)
  //   3. user returns from "Open Console" — we armed `awaitingClipboard` on
  //      that click, so the visibilitychange/focus listener below is allowed
  //      to call readText() with the expectation set by the walkthrough.
  useEffect(() => {
    if (!awaitingClipboard) return;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      void readClipboardKey(provider).then((match) => {
        if (match && match !== savedKey) {
          setClipboardCandidate(match);
          setAwaitingClipboard(false);
        }
      });
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [awaitingClipboard, provider, savedKey]);

  const handleSave = useCallback((next: string) => {
    const trimmed = next.trim();
    if (!trimmed) return;
    const field = provider === 'anthropic' ? 'anthropicKey' : 'openaiKey';
    updateApiKeys({ [field]: trimmed });
    setValue('');
    setClipboardCandidate(null);
    toast.success(`${PROVIDER_META[provider].label} key saved`);
  }, [provider]);

  const handleClear = useCallback(() => {
    const field = provider === 'anthropic' ? 'anthropicKey' : 'openaiKey';
    updateApiKeys({ [field]: '' });
    toast.success(`${PROVIDER_META[provider].label} key removed`);
  }, [provider]);

  const handleOpenConsole = useCallback(() => {
    setAwaitingClipboard(true);
    window.open(meta.consoleUrl, '_blank', 'noopener,noreferrer');
  }, [meta.consoleUrl]);

  // Paste into the input → if the pasted text matches the provider shape, we
  // promote it to the "Use it" candidate banner so the user is one click away
  // (instead of two: paste, then click Save). For non-matching content we let
  // the normal paste behaviour happen so the input still works as expected.
  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData('text').trim();
    if (looksLikeProviderKey(provider, pasted) && pasted !== savedKey) {
      e.preventDefault();
      setValue('');
      setClipboardCandidate(pasted);
    }
  }, [provider, savedKey]);

  // Explicit "Detect from clipboard" — the button click is a fresh user gesture,
  // so the OS paste prompt that may appear on macOS Chromium is expected by the
  // user rather than surprise-shown on mount.
  const handleManualClipboardCheck = useCallback(async () => {
    const match = await readClipboardKey(provider);
    if (match && match !== savedKey) {
      setClipboardCandidate(match);
    } else {
      toast.info(`No ${meta.label} key found on clipboard`);
    }
  }, [provider, savedKey, meta.label]);

  const inputIsValid = value.trim().length === 0 || looksLikeProviderKey(provider, value);

  return (
    <div className="space-y-4">
      {/* Models unlocked */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted-foreground">Unlocks:</span>
        {unlockedModels.map((m) => (
          <Badge key={m.id} variant="outline" className="text-[10px] font-mono">
            {m.name}
          </Badge>
        ))}
      </div>

      {/* The diagram — single most important trust element */}
      <div className="rounded-lg border bg-card/40 p-4">
        <ByokTrustDiagram apiHost={meta.apiHost} />
      </div>

      {/* DevTools-verifiable trust claims */}
      <ul className="space-y-2 text-xs">
        <TrustBullet>
          Key stored only in this browser&apos;s <code className="bg-muted px-1 rounded">localStorage</code>.{' '}
          Inspect any time in DevTools.
        </TrustBullet>
        <TrustBullet>
          Every request goes to <code className="bg-muted px-1 rounded">{meta.apiHost}</code>. Verify in DevTools →
          Network → filter <code className="bg-muted px-1 rounded">{meta.apiHost.split('.').slice(-2).join('.')}</code>.
        </TrustBullet>
        <TrustBullet>
          The whole BYOK code path is ~60 lines.{' '}
          <a
            href={`${REPO_BLOB}/apps/viewer/src/lib/llm/stream-direct.ts`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline inline-flex items-center gap-0.5 hover:text-foreground"
          >
            Read it on GitHub <ExternalLink className="h-2.5 w-2.5" />
          </a>
        </TrustBullet>
      </ul>

      {/* Clipboard candidate — the friction killer */}
      {clipboardCandidate && (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs">
            <ClipboardPaste className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
            <span>
              {meta.label} key on your clipboard:{' '}
              <code className="font-mono">{maskKey(clipboardCandidate)}</code>
            </span>
          </div>
          <Button size="sm" className="h-7 px-3 text-xs" onClick={() => handleSave(clipboardCandidate)}>
            Use it
          </Button>
        </div>
      )}

      {/* Manual paste */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <label className="text-xs font-medium" htmlFor={`byok-${provider}-input`}>
            {savedKey ? 'Replace existing key' : 'Paste your key'}
          </label>
          <button
            type="button"
            onClick={handleManualClipboardCheck}
            className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1 transition-colors"
            title={`Read clipboard and detect a ${meta.label} key`}
          >
            <ClipboardPaste className="h-3 w-3" />
            Detect from clipboard
          </button>
        </div>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              id={`byok-${provider}-input`}
              type={show ? 'text' : 'password'}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onPaste={handlePaste}
              onKeyDown={(e) => { if (e.key === 'Enter' && inputIsValid) handleSave(value); }}
              placeholder={meta.placeholder}
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-ring pr-8"
            />
            <button
              type="button"
              onClick={() => setShow(!show)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label={show ? 'Hide key' : 'Show key'}
            >
              {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
          </div>
          <Button size="sm" onClick={() => handleSave(value)} disabled={!inputIsValid || value.trim().length === 0}>
            Save
          </Button>
        </div>
        {!inputIsValid && (
          <p className="text-[11px] text-destructive">
            That doesn&apos;t look like a {meta.label} key (expected prefix{' '}
            <code className="font-mono">{meta.keyPrefix}</code>).
          </p>
        )}
      </div>

      {/* Currently configured key + remove */}
      {savedKey && (
        <div className="flex items-center justify-between gap-3 rounded-md border p-3 text-xs">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Check className="h-3.5 w-3.5 text-emerald-500" />
            Configured: <code className="font-mono text-foreground">{maskKey(savedKey)}</code>
          </div>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={handleClear}>
            <Trash2 className="mr-1 h-3 w-3" />
            Remove
          </Button>
        </div>
      )}

      {/* Walkthrough */}
      <div className="rounded-md border bg-muted/20">
        <button
          type="button"
          onClick={() => setWalkthroughOpen((v) => !v)}
          className="w-full flex items-center justify-between gap-2 p-3 text-xs hover:bg-muted/30 transition-colors"
        >
          <span className="font-medium">Don&apos;t have a key? 60-second walkthrough</span>
          {walkthroughOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>
        {walkthroughOpen && (
          <div className="border-t p-3 space-y-2.5 text-xs">
            <ol className="space-y-2 list-decimal list-inside text-muted-foreground">
              <li>
                Open the {meta.label} console — we&apos;ll watch for the key on your clipboard when you return.
              </li>
              <li>
                Click <strong>Create Key</strong>, name it <code className="bg-muted px-1 rounded">ifc-lite</code>.
              </li>
              <li>
                Set a spending limit (e.g.&nbsp;$10/month) so a leaked key can&apos;t burn you. The provider enforces it.
              </li>
              <li>
                Copy the key, return here — we&apos;ll detect it automatically.
              </li>
            </ol>
            <p className="text-[11px] text-muted-foreground/80">{meta.pricingHint}</p>
            <Button size="sm" variant="outline" className="text-xs" onClick={handleOpenConsole}>
              <ExternalLink className="mr-1.5 h-3 w-3" />
              Open {meta.consoleLabel}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function TrustBullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-muted-foreground">
      <Check className="h-3.5 w-3.5 mt-0.5 flex-shrink-0 text-emerald-500" />
      <span>{children}</span>
    </li>
  );
}
