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
  const [tabs, setTabs] = useState<Record<string, string>>({});
  const [received, setReceived] = useState(false);
  useEffect(() => {
    const connection = openModelTabPort();
    if (!connection) return;
    port.current = connection;
    connection.onmessage = ({ data }) => {
      if (data.type === 'offer') setTabs((prev) => ({ ...prev, [data.from]: data.name }));
      if (data.type === 'received') setReceived(true);
    };
    connection.postMessage({ type: 'discover' });
    return () => { connection.postMessage({ type: 'leave' }); connection.close(); };
  }, []);
  if (received) return <output>{t('agentBridge.dialog.confirmInTab')}</output>;
  return <>{Object.entries(tabs).map(([id, name]) => (
    <Button key={id} variant="outline" onClick={() => port.current?.postMessage({ type: 'deliver', to: id, fragment })}>
      {t('agentBridge.dialog.useModelTab', { name })}
    </Button>
  ))}</>;
}
