/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Connect a local agent" (#9523): the one place a pairing is confirmed.
 *
 * Opened from a pairing link (the code and port arrive prefilled) or from the
 * Sources panel and command palette (the user types them). Nothing connects
 * until the user presses Connect: the bridge client and the tool host are
 * imported then, not when the dialog opens. The dialog says plainly what the
 * agent can read, that it is read-only, where the connection goes, and what
 * the browser may ask.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot } from 'lucide-react';
import {
  BRIDGE_PROTOCOL_VERSION, DEFAULT_BRIDGE_PORT, normalizePairingCode, parsePairingFragment,
} from '@ifc-lite/mcp/bridge-protocol';
import type { BimContext } from '@ifc-lite/sdk';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { registerEnglish, useTranslation } from '@/i18n';
import { agentBridgeEn } from '@/i18n/catalogues/agent-bridge.en';
import { useBim } from '@/sdk/BimProvider';
import {
  updateAgentBridgeState, useAgentBridgeState, type AgentBridgeDialogRequest, type AgentBridgeStatus,
} from '@/lib/agent-bridge/state';
import { AgentBridgeOutcome, BridgeStartCommand } from './AgentBridgeOutcome';

registerEnglish(agentBridgeEn);

/** What the dialog needs from the session module, loaded only on Connect. */
export interface AgentBridgeSessionModule {
  connectAgentBridge(options: { port: number; code: string; bim: BimContext }): void;
  disconnectAgentBridge(): void;
}

const loadSession = (): Promise<AgentBridgeSessionModule> => import('@/lib/agent-bridge/session');

interface Prefill {
  port: string;
  code: string;
  /** A link that could not be used: unreadable, or for another protocol version. */
  linkProblem: AgentBridgeStatus | null;
}

function prefill(request: AgentBridgeDialogRequest): Prefill {
  const manual = { port: String(DEFAULT_BRIDGE_PORT), code: '', linkProblem: null };
  if (request.source !== 'link') return manual;
  const parsed = parsePairingFragment(request.fragment);
  if (!parsed) return { ...manual, linkProblem: { kind: 'error', code: 'invalid-link' } };
  if (parsed.protocol !== BRIDGE_PROTOCOL_VERSION) {
    return { port: String(parsed.port), code: '', linkProblem: { kind: 'error', code: 'protocol-mismatch', port: parsed.port } };
  }
  return { port: String(parsed.port), code: parsed.code, linkProblem: null };
}

function parsePort(text: string): number | null {
  const port = Number(text.trim());
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

export interface AgentBridgeDialogProps {
  request: AgentBridgeDialogRequest;
  onClose: () => void;
  /** Test seam for the lazily loaded session module. */
  load?: () => Promise<AgentBridgeSessionModule>;
}

export function AgentBridgeDialog({ request, onClose, load = loadSession }: AgentBridgeDialogProps) {
  const { t } = useTranslation();
  const bim = useBim();
  const initial = useMemo(() => prefill(request), [request]);
  const [port, setPort] = useState(initial.port);
  const [code, setCode] = useState(initial.code);
  const [validation, setValidation] = useState<{ code?: boolean; port?: boolean }>({});
  // Only outcomes of an attempt made in THIS dialog are shown here.
  const [attempted, setAttempted] = useState(false);
  const [loading, setLoading] = useState(false);
  const session = useRef<AgentBridgeSessionModule | null>(null);
  const { status } = useAgentBridgeState();
  const busy = loading || (attempted && status.kind === 'connecting');

  useEffect(() => {
    if (attempted && status.kind === 'connected') onClose();
  }, [attempted, status.kind, onClose]);

  const connect = async () => {
    const portNumber = parsePort(port);
    const codeMissing = normalizePairingCode(code).length === 0;
    setValidation({ code: codeMissing, port: portNumber === null });
    if (codeMissing || portNumber === null) return;
    setAttempted(true);
    setLoading(true);
    try {
      session.current ??= await load();
      session.current.connectAgentBridge({ port: portNumber, code, bim });
    } catch (err) {
      console.warn('[agent-bridge] the connection module failed to load', err);
      updateAgentBridgeState({ status: { kind: 'error', code: 'unreachable', port: portNumber } });
    } finally {
      setLoading(false);
    }
  };

  const cancel = () => {
    if (attempted && status.kind === 'connecting') session.current?.disconnectAgentBridge();
    // A failed attempt's outcome belongs to this dialog; closing it forgets it.
    if (attempted && status.kind === 'error') updateAgentBridgeState({ status: { kind: 'idle' } });
    onClose();
  };

  const shownProblem = attempted ? status : initial.linkProblem;
  const portForCommand = parsePort(port) ?? DEFAULT_BRIDGE_PORT;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) cancel(); }}>
      <DialogContent className="max-w-md" data-agent-bridge-dialog>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bot className="h-4 w-4" aria-hidden />
            {t('agentBridge.dialog.title')}
          </DialogTitle>
          <DialogDescription>
            {request.source === 'link' && <>{t('agentBridge.dialog.fromLink')} </>}
            {t('agentBridge.dialog.reads')}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-sm">
          <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            <li>{t('agentBridge.dialog.readOnly')}</li>
            <li>{t('agentBridge.dialog.localOnly', { port: portForCommand })}</li>
            <li>{t('agentBridge.dialog.browserPrompt')}</li>
          </ul>
          {request.source === 'manual' && (
            <div className="flex flex-col gap-1 text-xs">
              <span>{t('agentBridge.dialog.start')}</span>
              <BridgeStartCommand port={portForCommand} />
            </div>
          )}
          <div className="flex gap-2">
            <Field className="flex-1" label={t('agentBridge.dialog.code')} hint={t('agentBridge.dialog.codeHint')}
              error={validation.code ? t('agentBridge.dialog.codeRequired') : undefined}>
              <Input value={code} onChange={(event) => setCode(event.target.value)} autoComplete="off"
                spellCheck={false} className="font-mono" disabled={busy} />
            </Field>
            <Field className="w-24" label={t('agentBridge.dialog.port')}
              error={validation.port ? t('agentBridge.dialog.portInvalid') : undefined}>
              <Input value={port} onChange={(event) => setPort(event.target.value)} inputMode="numeric"
                autoComplete="off" disabled={busy} />
            </Field>
          </div>
          {busy && (
            <output className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner size="sm" />{t('agentBridge.dialog.connecting')}
            </output>
          )}
          {shownProblem && !busy && <AgentBridgeOutcome status={shownProblem} />}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={cancel}>{t('agentBridge.dialog.cancel')}</Button>
          <Button onClick={() => { void connect(); }} disabled={busy} data-agent-bridge-connect>
            {attempted && (status.kind === 'error' || status.kind === 'disconnected')
              ? t('agentBridge.dialog.tryAgain') : t('agentBridge.dialog.connect')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
