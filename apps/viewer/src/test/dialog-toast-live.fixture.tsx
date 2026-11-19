/* SPDX-License-Identifier: MPL-2.0 */
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Toaster, toast } from '@/components/ui/toast';
import { Popover, PopoverContent, PopoverPortal, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export type Layout = 'grid' | 'below' | 'gridTall' | 'scrollBody' | 'viewportBounds' | 'phoneCap' | 'portalControls';

export function mountDialog(layout: Layout): void {
  const container = document.getElementById('live-dialog-fixture');
  if (!container) throw new Error('Missing fixture container');
  const portals = layout === 'portalControls';
  const root = createRoot(container);
  flushSync(() => root.render(<React.Fragment><Toaster /><Dialog defaultOpen>
    <DialogContent scrollBody={layout === 'scrollBody' || layout === 'viewportBounds' || layout === 'phoneCap'}
      viewportBounds={layout === 'viewportBounds' ? 'height' : undefined}
      style={layout === 'below' ? { top: 32, translate: '-50% 0', transform: 'none' }
        : portals ? { height: 200, maxHeight: 200 } : undefined}>
      <DialogHeader><DialogTitle>Settings</DialogTitle><DialogDescription>Preferences</DialogDescription></DialogHeader>
      <label>File name<input aria-label="File name" defaultValue="Model.ifc" /></label>
      {!portals && <div style={{ height: layout === 'grid' || layout === 'below' ? 100 : 1000 }}>Performance</div>}
      {portals && <>
        <Select defaultValue="a"><SelectTrigger aria-label="Portal select"><SelectValue /></SelectTrigger>
          <SelectContent position="popper" side="bottom" sideOffset={8}>
            <SelectItem value="a">Portal option A</SelectItem><SelectItem value="b">Portal option B</SelectItem>
          </SelectContent>
        </Select>
        <Popover><PopoverTrigger>Portal popover</PopoverTrigger><PopoverPortal>
          <PopoverContent side="bottom" data-portal-popover><button>Popover action</button></PopoverContent>
        </PopoverPortal></Popover>
      </>}
      <DialogFooter><button>Reset Geometry workers</button></DialogFooter>
    </DialogContent>
  </Dialog></React.Fragment>));
}

export function raiseNotices(): void {
  flushSync(() => {
    toast.error('Unable to save preferences.');
    toast.info('IFClite stores an action log in this browser.');
  });
}
