/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  ArrowLeft,
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  Clock3,
  Cloud,
  CreditCard,
  ExternalLink,
  Eye,
  EyeOff,
  FolderOpen,
  Key,
  LayoutPanelTop,
  Lock,
  Settings2,
  ShieldCheck,
  Trash2,
  WifiOff,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { useViewerStore } from '@/store';
import {
  buildDesktopUpgradeUrl,
  getDesktopFeatureCatalog,
  getDesktopPlanSummary,
  getDesktopPlanTier,
  hasDesktopPro,
  isDesktopBillingEnforced,
  type DesktopEntitlement,
} from '@/lib/desktop-product';
import { navigateToPath } from '@/services/app-navigation';
import {
  getDesktopPreferences,
  subscribeDesktopPreferences,
  updateDesktopPreferences,
} from '@/services/desktop-preferences';
import {
  getApiKeys,
  updateApiKeys,
  clearApiKeys,
  subscribeApiKeys,
  type ApiKeyConfig,
} from '@/services/api-keys';

export function SettingsPage() {
  const desktopEntitlement = useViewerStore((s) => s.desktopEntitlement);
  const chatUsage = useViewerStore((s) => s.chatUsage);
  const [preferences, setPreferences] = useState(() => getDesktopPreferences());
  const [apiKeys, setApiKeys] = useState(() => getApiKeys());
  const returnTo = (() => {
    const params = new URLSearchParams(window.location.search);
    const candidate = params.get('returnTo');
    return candidate && candidate.startsWith('/') ? candidate : '/';
  })();
  useEffect(() => subscribeDesktopPreferences(() => {
    setPreferences(getDesktopPreferences());
  }), []);
  useEffect(() => subscribeApiKeys(() => {
    setApiKeys(getApiKeys());
  }), []);

  const updatePreference = (updates: Partial<typeof preferences>) => {
    setPreferences(updateDesktopPreferences(updates));
  };
  const planTier = getDesktopPlanTier(desktopEntitlement);
  const planSummary = getDesktopPlanSummary(desktopEntitlement, chatUsage);
  const featureCatalog = getDesktopFeatureCatalog(desktopEntitlement);
  const canRestoreWorkspace = hasDesktopPro(desktopEntitlement);
  const usageSummary = useMemo(() => {
    if (!chatUsage) {
      return null;
    }
    const resetLabel = chatUsage.resetAt
      ? new Date(chatUsage.resetAt * 1000).toLocaleDateString()
      : 'Unknown';
    const unit = chatUsage.type === 'credits' ? 'credits' : 'requests';
    return `${chatUsage.used}/${chatUsage.limit} ${unit} used. Resets ${resetLabel}.`;
  }, [chatUsage]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto w-full max-w-4xl px-6 py-8">
        <div className="mb-6 flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={() => navigateToPath(returnTo, { replace: true })}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Viewer
          </Button>
        </div>

        <div className="space-y-6">
          {/* API Keys Section */}
          <ApiKeysSection apiKeys={apiKeys} />

          <section className="rounded-lg border bg-card p-6 shadow-sm">
            <div className="mb-5 flex items-center gap-3">
              <ShieldCheck className="h-5 w-5" />
              <div>
                <h1 className="text-2xl font-semibold">Desktop Account</h1>
                <p className="text-sm text-muted-foreground">
                  App-wide entitlement, trial state, offline grace, and AI usage limits.
                </p>
              </div>
            </div>

            <div className="mb-5 flex flex-wrap items-center gap-2">
              <StatusBadge entitlement={desktopEntitlement} />
              <Badge variant={hasDesktopPro(desktopEntitlement) ? 'default' : 'secondary'}>
                {planTier === 'pro' ? 'Desktop Pro' : 'Desktop Free'}
              </Badge>
              <Badge variant="outline">
                Source: {desktopEntitlement.source.replace('_', ' ')}
              </Badge>
            </div>

            <div className="mb-5 grid gap-3 md:grid-cols-2">
              <InfoCard
                title="Plan Summary"
                body={planSummary}
                icon={<CreditCard className="h-4 w-4" />}
              />
              <InfoCard
                title="AI Usage (Free Tier)"
                body={usageSummary ?? 'No AI usage data yet. Usage appears after the first chat message through the proxy.'}
                icon={<Bot className="h-4 w-4" />}
              />
              <InfoCard
                title="Last Validated"
                body={formatTimestamp(desktopEntitlement.validatedAt)}
                icon={<Clock3 className="h-4 w-4" />}
              />
              <InfoCard
                title="Offline Grace"
                body={formatOfflineGrace(desktopEntitlement)}
                icon={<WifiOff className="h-4 w-4" />}
              />
            </div>
          </section>

          <section className="rounded-lg border bg-card p-6 shadow-sm">
            <div className="mb-5 flex items-center gap-3">
              <Settings2 className="h-5 w-5" />
              <div>
                <h1 className="text-2xl font-semibold">Desktop Settings</h1>
                <p className="text-sm text-muted-foreground">
                  Local preferences for startup behavior and account access.
                </p>
              </div>
            </div>

            <div className="space-y-5">
              <div className="flex items-start justify-between gap-4 rounded-md border p-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2 font-medium">
                    <FolderOpen className="h-4 w-4" />
                    Reopen last model on launch
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Automatically load the most recently used IFC file when the desktop app starts.
                  </p>
                </div>
                <Switch
                  checked={preferences.reopenLastModelOnLaunch}
                  onCheckedChange={(checked) => updatePreference({ reopenLastModelOnLaunch: checked })}
                />
              </div>

              <div className="flex items-start justify-between gap-4 rounded-md border p-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2 font-medium">
                    <LayoutPanelTop className="h-4 w-4" />
                    Restore workspace layout
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Restore panel visibility, camera view, sectioning, and other saved workspace state on launch. Desktop Pro feature.
                  </p>
                </div>
                <Switch
                  checked={preferences.restoreWorkspaceLayoutOnLaunch}
                  disabled={!canRestoreWorkspace}
                  onCheckedChange={(checked) => updatePreference({ restoreWorkspaceLayoutOnLaunch: checked })}
                />
              </div>
              {!canRestoreWorkspace && (
                <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                  Workspace restore is included with Desktop Pro. Reopening the last model remains available on Free.
                  <div className="mt-3">
                    <Button size="sm" onClick={() => navigateToPath(buildDesktopUpgradeUrl('/settings'))}>
                      Upgrade to Desktop Pro
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </section>

          <section className="rounded-lg border bg-card p-6 shadow-sm">
            <div className="mb-5 flex items-center gap-3">
              <CreditCard className="h-5 w-5" />
              <div>
                <h2 className="text-xl font-semibold">Billing & Features</h2>
                <p className="text-sm text-muted-foreground">
                  Desktop billing is app-wide. The viewer stays available on Free, while Pro unlocks advanced desktop features.
                </p>
              </div>
            </div>

            <div className="mb-5 rounded-md border p-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="font-medium capitalize">{planTier} plan</div>
                  <p className="text-sm text-muted-foreground">{planSummary}</p>
                </div>
                {isDesktopBillingEnforced() && !hasDesktopPro(desktopEntitlement) && (
                  <Button onClick={() => navigateToPath(buildDesktopUpgradeUrl('/settings'))}>
                    Upgrade to Pro
                  </Button>
                )}
              </div>
            </div>

            <div className="mb-5 grid gap-3">
              {featureCatalog.map((feature) => (
                <div key={feature.key} className="flex items-start justify-between gap-4 rounded-md border p-4">
                  <div>
                    <div className="font-medium">{feature.label}</div>
                    <p className="text-sm text-muted-foreground">{feature.description}</p>
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    {feature.enabled ? (
                      <>
                        <Check className="h-4 w-4 text-emerald-500" />
                        Included
                      </>
                    ) : (
                      <>
                        <Lock className="h-4 w-4 text-amber-500" />
                        Pro
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-lg border bg-card p-6 shadow-sm">
            <div className="mb-5 flex items-center gap-3">
              <Cloud className="h-5 w-5" />
              <div>
                <h2 className="text-xl font-semibold">Privacy & Network</h2>
                <p className="text-sm text-muted-foreground">
                  Local IFC viewing remains available offline. Connected services degrade individually instead of blocking the desktop viewer.
                </p>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <InfoCard
                title="Always Local"
                body="Model loading, hierarchy, properties, navigation, measurement, and core viewing stay on your machine."
                icon={<ShieldCheck className="h-4 w-4" />}
              />
              <InfoCard
                title="Needs Network"
                body="AI assistant (free via proxy, or direct with your API key), live bSDD lookups, and billing sync require network access."
                icon={<Cloud className="h-4 w-4" />}
              />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

// ── API Keys Section ──────────────────────────────────────────────────────

function ApiKeyInput({
  id,
  value,
  onChange,
  onSave,
  placeholder,
  isSaved,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  placeholder: string;
  isSaved: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="flex gap-2">
      <div className="relative flex-1">
        <input
          id={id}
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !isSaved) onSave(); }}
          placeholder={placeholder}
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
      <Button size="sm" onClick={onSave} disabled={isSaved}>
        Save
      </Button>
    </div>
  );
}

function ApiKeysSection({ apiKeys }: { apiKeys: ApiKeyConfig }) {
  const [anthropicKey, setAnthropicKey] = useState(apiKeys.anthropicKey);
  const [openaiKey, setOpenaiKey] = useState(apiKeys.openaiKey);
  const [showHowTo, setShowHowTo] = useState<'anthropic' | 'openai' | null>(null);

  useEffect(() => {
    setAnthropicKey(apiKeys.anthropicKey);
    setOpenaiKey(apiKeys.openaiKey);
  }, [apiKeys.anthropicKey, apiKeys.openaiKey]);

  const saveAnthropicKey = useCallback(() => {
    updateApiKeys({ anthropicKey: anthropicKey.trim() });
    toast.success(anthropicKey.trim() ? 'Anthropic API key saved' : 'Anthropic API key removed');
  }, [anthropicKey]);

  const saveOpenaiKey = useCallback(() => {
    updateApiKeys({ openaiKey: openaiKey.trim() });
    toast.success(openaiKey.trim() ? 'OpenAI API key saved' : 'OpenAI API key removed');
  }, [openaiKey]);

  const handleClearAll = useCallback(() => {
    clearApiKeys();
    setAnthropicKey('');
    setOpenaiKey('');
    toast.success('All API keys removed');
  }, []);

  const hasAnyKey = apiKeys.anthropicKey.length > 0 || apiKeys.openaiKey.length > 0;

  return (
    <section className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="mb-5 flex items-center gap-3">
        <Key className="h-5 w-5" />
        <div>
          <h1 className="text-2xl font-semibold">API Keys</h1>
          <p className="text-sm text-muted-foreground">
            Bring your own Anthropic or OpenAI API key to unlock additional models.
            You can configure one or both providers independently.
          </p>
        </div>
      </div>

      <div className="space-y-4">
        {/* Anthropic */}
        <div className="rounded-md border p-4">
          <div className="mb-2 flex items-center justify-between">
            <label className="text-sm font-medium" htmlFor="anthropic-key">Anthropic API Key</label>
            {apiKeys.anthropicKey ? (
              <Badge variant="default" className="text-[10px]">
                <Check className="mr-1 h-3 w-3" />
                Configured
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[10px]">Not set</Badge>
            )}
          </div>
          <p className="mb-2 text-xs text-muted-foreground">
            Unlocks <strong>Claude Opus 4.6</strong>, <strong>Claude Sonnet 4.6</strong>, and <strong>Claude Haiku 4.5</strong>.
          </p>
          <button
            type="button"
            onClick={() => setShowHowTo(showHowTo === 'anthropic' ? null : 'anthropic')}
            className="mb-3 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {showHowTo === 'anthropic' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            How to get an Anthropic API key
          </button>
          {showHowTo === 'anthropic' && (
            <div className="mb-3 rounded-md bg-muted/50 p-3 text-xs text-muted-foreground space-y-1.5">
              <p>1. Go to{' '}
                <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer" className="underline inline-flex items-center gap-0.5">
                  console.anthropic.com/settings/keys <ExternalLink className="h-2.5 w-2.5" />
                </a>
              </p>
              <p>2. Sign in or create an Anthropic account</p>
              <p>3. Click <strong>Create Key</strong>, name it (e.g. &quot;ifc-lite&quot;)</p>
              <p>4. Copy the key (starts with <code className="bg-muted px-1 rounded">sk-ant-api03-...</code>)</p>
              <p>5. Paste it below and click Save</p>
              <p className="pt-1 text-muted-foreground/70">Anthropic offers $5 free credit on new accounts. After that, usage is pay-as-you-go on your Anthropic billing.</p>
            </div>
          )}
          <ApiKeyInput
            id="anthropic-key"
            value={anthropicKey}
            onChange={setAnthropicKey}
            onSave={saveAnthropicKey}
            placeholder="sk-ant-api03-..."
            isSaved={anthropicKey.trim() === apiKeys.anthropicKey}
          />
        </div>

        {/* OpenAI */}
        <div className="rounded-md border p-4">
          <div className="mb-2 flex items-center justify-between">
            <label className="text-sm font-medium" htmlFor="openai-key">OpenAI API Key</label>
            {apiKeys.openaiKey ? (
              <Badge variant="default" className="text-[10px]">
                <Check className="mr-1 h-3 w-3" />
                Configured
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[10px]">Not set</Badge>
            )}
          </div>
          <p className="mb-2 text-xs text-muted-foreground">
            Unlocks <strong>GPT-5.4</strong>, <strong>GPT-5.3 Codex</strong>, and <strong>GPT-5.4 Mini</strong>.
          </p>
          <button
            type="button"
            onClick={() => setShowHowTo(showHowTo === 'openai' ? null : 'openai')}
            className="mb-3 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {showHowTo === 'openai' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            How to get an OpenAI API key
          </button>
          {showHowTo === 'openai' && (
            <div className="mb-3 rounded-md bg-muted/50 p-3 text-xs text-muted-foreground space-y-1.5">
              <p>1. Go to{' '}
                <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" className="underline inline-flex items-center gap-0.5">
                  platform.openai.com/api-keys <ExternalLink className="h-2.5 w-2.5" />
                </a>
              </p>
              <p>2. Sign in or create an OpenAI account</p>
              <p>3. Click <strong>Create new secret key</strong>, name it (e.g. &quot;ifc-lite&quot;)</p>
              <p>4. Copy the key (starts with <code className="bg-muted px-1 rounded">sk-...</code>)</p>
              <p>5. Paste it below and click Save</p>
              <p className="pt-1 text-muted-foreground/70">OpenAI requires prepaid credits or a payment method. Usage is billed to your OpenAI account.</p>
            </div>
          )}
          <ApiKeyInput
            id="openai-key"
            value={openaiKey}
            onChange={setOpenaiKey}
            onSave={saveOpenaiKey}
            placeholder="sk-..."
            isSaved={openaiKey.trim() === apiKeys.openaiKey}
          />
        </div>

        {hasAnyKey && (
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={handleClearAll}>
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              Remove all keys
            </Button>
          </div>
        )}

        {/* Security & Privacy notice */}
        <div className="rounded-md border border-dashed p-4 text-xs space-y-2">
          <p className="font-medium text-foreground">Your API keys never leave your machine.</p>
          <ul className="list-disc pl-4 space-y-1 text-muted-foreground">
            <li>Keys are stored in your browser&apos;s <code className="bg-muted px-1 rounded">localStorage</code> and persist across page reloads.</li>
            <li>When you use a BYOK model, requests go <strong>directly from your browser to the provider</strong> (Anthropic or OpenAI). They never pass through our servers.</li>
            <li>Free models use our server proxy and do not require any API key.</li>
            <li>Clearing your browser data or clicking &quot;Remove all keys&quot; above permanently deletes them.</li>
          </ul>
          <p className="text-muted-foreground pt-1">
            <strong>Verify in your browser console:</strong> open DevTools (F12), go to the Console tab, and run:
          </p>
          <pre className="bg-muted rounded px-2 py-1.5 font-mono text-[11px] overflow-x-auto text-foreground">
            {`JSON.parse(localStorage.getItem('ifc-lite:api-keys:v1') ?? '{}')`}
          </pre>
          <p className="text-muted-foreground">
            This shows exactly what is stored. Only you can see it. To delete everything:
          </p>
          <pre className="bg-muted rounded px-2 py-1.5 font-mono text-[11px] overflow-x-auto text-foreground">
            {`localStorage.removeItem('ifc-lite:api-keys:v1')`}
          </pre>
        </div>
      </div>
    </section>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

function formatTimestamp(value: number | null): string {
  if (!value) {
    return 'Not validated yet';
  }
  return new Date(value).toLocaleString();
}

function formatOfflineGrace(entitlement: DesktopEntitlement): string {
  if (!entitlement.graceUntil) {
    return 'No offline grace cached yet';
  }
  const remainingDays = Math.max(0, Math.ceil((entitlement.graceUntil - Date.now()) / (24 * 60 * 60 * 1000)));
  return `${new Date(entitlement.graceUntil).toLocaleString()}${remainingDays > 0 ? ` (${remainingDays} day${remainingDays === 1 ? '' : 's'} left)` : ''}`;
}

function describeDesktopStatus(entitlement: DesktopEntitlement): string {
  switch (entitlement.status) {
    case 'trial':
      return entitlement.trialEndsAt
        ? `Trial active until ${new Date(entitlement.trialEndsAt).toLocaleDateString()}`
        : 'Trial active';
    case 'grace_offline':
      return entitlement.graceUntil
        ? `Offline grace until ${new Date(entitlement.graceUntil).toLocaleDateString()}`
        : 'Offline grace active';
    case 'expired':
      return 'Subscription expired';
    case 'active':
      return 'Subscription active';
    case 'signed_out':
      return 'Signed out';
    case 'anonymous':
      return 'No account configured';
    default:
      return entitlement.status;
  }
}

function getStatusBadgeVariant(entitlement: DesktopEntitlement): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (entitlement.status) {
    case 'active':
    case 'trial':
      return 'default';
    case 'grace_offline':
      return 'secondary';
    case 'expired':
      return 'destructive';
    default:
      return 'outline';
  }
}

function StatusBadge({ entitlement }: { entitlement: DesktopEntitlement }) {
  return (
    <Badge variant={getStatusBadgeVariant(entitlement)}>
      {describeDesktopStatus(entitlement)}
    </Badge>
  );
}

function InfoCard({ title, body, icon }: { title: string; body: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-md border p-4">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        {icon}
        {title}
      </div>
      <p className="text-sm text-muted-foreground">{body}</p>
    </div>
  );
}
