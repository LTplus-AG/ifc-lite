/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react';
import { Analytics } from '@vercel/analytics/react';
import { BimProvider } from '@/sdk/BimProvider';
import { ExtensionHostProvider } from '@/sdk/ExtensionHostProvider';
import { SourceHostProvider } from '@/services/sources/SourceHostProvider';
import type { FileSourceProviderFactory } from '@/services/sources/source-host';
import { ErrorReportHost } from '@/components/error-report/ErrorReportHost';
import { StaleDeploymentNotice } from '@/components/StaleDeploymentNotice';
import { LensRuntimeHost } from './LensRuntimeHost';
import { ViewerLayout } from './ViewerLayout';

/** Shared viewer providers; receiving a registry version still uses the ordinary viewer and loader. */
export function ViewerRoot({ sourceProviders, children }: { sourceProviders?: readonly FileSourceProviderFactory[]; children?: ReactNode }) {
  return <>
    {import.meta.env.VITE_MODEL_REPORTS_ENABLED === 'true' && <ErrorReportHost />}
    <BimProvider>
      <ExtensionHostProvider>
        <SourceHostProvider additionalProviders={sourceProviders}>
          {children}
          <LensRuntimeHost />
          {/* Toasts mount inside ViewportContainer, anchored to the viewport (#5504). */}
          <ViewerLayout />
          <StaleDeploymentNotice />
          <Analytics />
        </SourceHostProvider>
      </ExtensionHostProvider>
    </BimProvider>
  </>;
}
