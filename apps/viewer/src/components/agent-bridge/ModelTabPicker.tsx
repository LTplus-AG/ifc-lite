/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { openModelTabPort } from '@/lib/agent-bridge/model-tabs';

export function ModelTabPicker({ fragment }: { fragment: string }) {
  const { t } = useTranslation();
  const port = useRef<MessagePort | undefined>(undefined);
  const attempt = useRef<{ to: string; id: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [waiting, setWaiting] = useState(false);
  const [tabs, setTabs] = useState<Record<string, string>>({});
  const [available, setAvailable] = useState(false);
  const [received, setReceived] = useState(false);
  useEffect(() => {
    const connection = openModelTabPort();
    if (!connection) return;
    port.current = connection;
    setAvailable(true);
    connection.onmessage = ({ data }) => {
      if (data.type === 'offer') setTabs((prev) => ({ ...prev, [data.from]: data.name }));
      const pending = attempt.current;
      if (data.type === 'ready' && pending && data.from === pending.to && data.attemptId === pending.id) {
        clearTimeout(timer.current);
        attempt.current = null;
        connection.postMessage({ type: 'deliver', to: pending.to, fragment });
        setReceived(true);
      }
    };
    connection.postMessage({ type: 'discover' });
    return () => { clearTimeout(timer.current); connection.postMessage({ type: 'leave' }); connection.close(); };
  }, [fragment]);
  function deliver(to: string) {
    if (attempt.current || !port.current) return;
    const id = crypto.randomUUID();
    attempt.current = { to, id };
    setWaiting(true);
    port.current.postMessage({ type: 'prepare', to, attemptId: id });
    timer.current = setTimeout(() => {
      attempt.current = null;
      setWaiting(false);
      setTabs({});
      port.current?.postMessage({ type: 'discover' });
    }, 3000);
  }
  if (received) return <output>{t('agentBridge.dialog.confirmInTab')}</output>;
  return <>{Object.entries(tabs).map(([id, name]) => (
    <Button key={id} variant="outline" disabled={waiting} onClick={() => deliver(id)}>
      {t('agentBridge.dialog.useModelTab', { name })}
    </Button>
  ))}
    {available && <Button variant="ghost" disabled={waiting} onClick={() => {
      setTabs({});
      port.current?.postMessage({ type: 'discover' });
    }}>{t('agentBridge.dialog.refreshTabs')}</Button>}
  </>;
}
