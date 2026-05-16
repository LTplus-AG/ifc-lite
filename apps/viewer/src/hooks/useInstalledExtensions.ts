/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react';
import type { InstalledExtensionRecord } from '@ifc-lite/extensions';
import { useOptionalExtensionHost } from '@/sdk/ExtensionHostProvider.js';

/**
 * Live list of installed extensions. Refreshes whenever the host
 * service's "anything changed" signal fires (install/uninstall/
 * enable/disable).
 */
export function useInstalledExtensions(): InstalledExtensionRecord[] {
  const host = useOptionalExtensionHost();
  const [records, setRecords] = useState<InstalledExtensionRecord[]>([]);

  useEffect(() => {
    if (!host) {
      setRecords([]);
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      const next = await host.listInstalled();
      if (!cancelled) setRecords(next);
    };
    void refresh();
    const off = host.onChange(() => {
      void refresh();
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [host]);

  return records;
}
