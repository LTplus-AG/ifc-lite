/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState } from 'react';
import { draftCustomizationPlanFromPrompt, validateCustomizationPlan } from '@ifc-lite/customization';
import { Button } from '@/components/ui/button';
import { previewWorkbenchPatch } from './WorkbenchPatchDialog';

export function AiCustomizationPanel({ onPreview }: { onPreview?: () => void }) {
  const [prompt, setPrompt] = useState('Make me a fire safety review workspace');
  const plan = draftCustomizationPlanFromPrompt(prompt);
  const errors = validateCustomizationPlan(plan);
  return (
    <div className="space-y-3">
      <textarea
        value={prompt}
        onChange={(event) => setPrompt(event.currentTarget.value)}
        rows={4}
        className="w-full rounded border bg-background px-3 py-2 text-sm"
      />
      <div className="rounded border bg-muted/30 p-3">
        <div className="font-medium">{plan.summary}</div>
        <div className="mt-1 text-xs text-muted-foreground">
          Intent: {plan.intent} · Capabilities: {plan.requiredCapabilities.length || 'none'}
        </div>
        {plan.risks.map((risk, index) => (
          <div key={index} className="mt-2 rounded bg-background px-2 py-1 text-xs">
            {risk.tier}: {risk.message}
          </div>
        ))}
        {errors.length > 0 && <div className="mt-2 text-xs text-destructive">{errors.join(' ')}</div>}
      </div>
      <Button
        type="button"
        disabled={!plan.patch || errors.length > 0}
        onClick={() => {
          if (plan.patch) previewWorkbenchPatch(plan.patch);
          onPreview?.();
        }}
      >
        Preview AI plan
      </Button>
    </div>
  );
}
