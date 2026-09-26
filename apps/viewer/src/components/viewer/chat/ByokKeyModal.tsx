/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Trust-focused BYOK API key entry modal.
 *
 * Replaces the inline password-style strip in ChatPanel. Renders one tab per
 * supported provider; each tab pairs the request-flow SVG with concrete,
 * DevTools-verifiable trust claims and an "Open Console → Create Key →
 * paste here" walkthrough.
 *
 * Clipboard handling: we deliberately do NOT do background `clipboard.readText()`
 * polling. Modern browsers gate that behind either transient user activation
 * or an explicit clipboard-read permission we can't request a prompt for —
 * and on macOS Chromium, every silent read triggers the native Paste affordance
 * even though we silently swallow the result. Instead, the input is autofocused
 * on open so the user's Cmd+V lands directly in the field, and a green inline
 * confirmation appears the moment the pasted value matches the provider shape.
 *
 * The web build ships this. Desktop also uses it (the /settings page is
 * desktop-only and not deployed on Vercel).
 */

import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronUp, ExternalLink, Key } from 'lucide-react';
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
import { useTranslation } from '@/i18n';
import { ByokTrustDiagram } from './ByokTrustDiagram';
import { ByokCredentialForm } from './ByokCredentialForm';
import { CLIENT_FILES, DEFAULT_REQUEST_SOURCE } from './byok-audit-sources';
import { getByokModelsForSource } from '@/lib/llm/models';
import { getApiKeys, subscribeApiKeys, type ApiKeyConfig } from '@/services/api-keys';
import { type BYOKProvider } from '@/lib/llm/clipboard-detect';

const REPO_BLOB = 'https://github.com/LTplus-AG/ifc-lite/blob/main';

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
  /**
   * Per provider, the file that sends that provider's key on this surface,
   * relative to `apps/viewer/src`. The audit link is this modal's whole point,
   * so it has to name the code that actually runs — and a surface can differ
   * for one provider and not another: the MCP playground drives its own
   * Anthropic loop but never issues an OpenAI request at all, so its OpenAI tab
   * must keep the default. Unlisted providers fall back to `stream-direct.ts`.
   */
  requestSource?: Partial<Record<BYOKProvider, string>>;
}

export function ByokKeyModal({
  open,
  onOpenChange,
  initialProvider = 'anthropic',
  requestSource,
}: ByokKeyModalProps) {
  const { t } = useTranslation();
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
            {t('chatByok.keyModal.title')}
          </DialogTitle>
          <DialogDescription>
            {t('chatByok.keyModal.description')}
          </DialogDescription>
        </DialogHeader>

        <Tabs value={provider} onValueChange={(v) => setProvider(v as BYOKProvider)}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger
              value="anthropic"
              className="flex items-center gap-1.5 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm data-[state=active]:font-semibold"
            >
              {t('chatByok.provider.anthropic')}
              {apiKeys.anthropicKey && <Check className="h-3 w-3 text-emerald-500" />}
            </TabsTrigger>
            <TabsTrigger
              value="openai"
              className="flex items-center gap-1.5 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm data-[state=active]:font-semibold"
            >
              {t('chatByok.provider.openai')}
              {apiKeys.openaiKey && <Check className="h-3 w-3 text-emerald-500" />}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="anthropic" className="mt-4">
            <ProviderTab
              provider="anthropic"
              savedKey={apiKeys.anthropicKey}
              savedWorkspaceId={apiKeys.anthropicWorkspaceId}
              requestSource={requestSource?.anthropic ?? DEFAULT_REQUEST_SOURCE}
            />
          </TabsContent>
          <TabsContent value="openai" className="mt-4">
            <ProviderTab
              provider="openai"
              savedKey={apiKeys.openaiKey}
              requestSource={requestSource?.openai ?? DEFAULT_REQUEST_SOURCE}
            />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

// ── Per-provider tab body ──────────────────────────────────────────────────

function ProviderTab({ provider, savedKey, savedWorkspaceId = '', requestSource }: {
  provider: BYOKProvider;
  savedKey: string;
  savedWorkspaceId?: string;
  requestSource: string;
}) {
  const { t } = useTranslation();
  const meta = PROVIDER_META[provider];

  const unlockedModels = useMemo(() => getByokModelsForSource(provider), [provider]);
  const [walkthroughOpen, setWalkthroughOpen] = useState(false);

  const handleOpenConsole = () => {
    window.open(meta.consoleUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="space-y-4">
      {/* Models unlocked */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted-foreground">{t('chatByok.keyModal.unlocksLabel')}</span>
        {unlockedModels.map((m) => (
          <Badge key={m.id} variant="outline" className="text-2xs font-mono">
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
          {t('chatByok.keyModal.trustBullet1Prefix')}{' '}
          <code className="bg-muted px-1 rounded">{t('chatByok.keyModal.trustBulletLocalStorage')}</code>.{' '}
          {t('chatByok.keyModal.trustBullet1Suffix')}
        </TrustBullet>
        <TrustBullet>
          {t('chatByok.keyModal.trustBullet2Prefix')} <code className="bg-muted px-1 rounded">{meta.apiHost}</code>
          {t('chatByok.keyModal.trustBullet2Suffix')}{' '}
          <code className="bg-muted px-1 rounded">{meta.apiHost.split('.').slice(-2).join('.')}</code>.
        </TrustBullet>
        <TrustBullet>
          {t('chatByok.keyModal.trustBullet3Prefix')}{' '}
          {[...CLIENT_FILES[provider], requestSource].map((file, i) => (
            <span key={file}>
              {i > 0 && t('chatByok.keyModal.fileListSeparator')}
              <a
                href={`${REPO_BLOB}/apps/viewer/src/${file}`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline inline-flex items-center gap-0.5 hover:text-foreground"
              >
                {file.split('/').pop()} <ExternalLink className="h-2.5 w-2.5" />
              </a>
            </span>
          ))}
        </TrustBullet>
      </ul>

      <ByokCredentialForm
        provider={provider}
        meta={meta}
        savedKey={savedKey}
        savedWorkspaceId={savedWorkspaceId}
      />

      {/* Walkthrough */}
      <div className="rounded-md border bg-muted/20">
        <button
          type="button"
          onClick={() => setWalkthroughOpen((v) => !v)}
          aria-expanded={walkthroughOpen}
          aria-controls={`byok-walkthrough-${provider}`}
          className="w-full flex items-center justify-between gap-2 p-3 text-xs hover:bg-muted/30 transition-colors"
        >
          <span className="font-medium">{t('chatByok.keyModal.walkthroughToggle')}</span>
          {walkthroughOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>
        {walkthroughOpen && (
          <div id={`byok-walkthrough-${provider}`} className="border-t p-3 space-y-2.5 text-xs">
            <ol className="space-y-2 list-decimal list-inside text-muted-foreground">
              <li>
                {t('chatByok.keyModal.walkthroughStep1', { provider: meta.label })}
              </li>
              <li>
                {t('chatByok.keyModal.walkthroughStep2Prefix')} <strong>{t('chatByok.keyModal.walkthroughStep2CreateKey')}</strong>
                {t('chatByok.keyModal.walkthroughStep2Middle')}{' '}
                <code className="bg-muted px-1 rounded">{t('chatByok.keyModal.walkthroughStep2CodeName')}</code>.
                {provider === 'anthropic' && t('chatByok.keyModal.walkthroughStep2AnthropicNote')}
              </li>
              <li>
                {t('chatByok.keyModal.walkthroughStep3')}
              </li>
              <li>
                {t('chatByok.keyModal.walkthroughStep4')} <code className="bg-muted px-1 rounded">⌘V</code>).
              </li>
            </ol>
            <p className="text-2xs text-muted-foreground">{meta.pricingHint}</p>
            <Button size="sm" variant="outline" className="text-xs" onClick={handleOpenConsole}>
              <ExternalLink className="mr-1.5 h-3 w-3" />
              {t('chatByok.keyModal.openConsoleButton', { consoleLabel: meta.consoleLabel })}
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
