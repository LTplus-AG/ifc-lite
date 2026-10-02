/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The page frame and the block sizes derived from it (#4940, #6548): the rules the PDF composer lays a
 * block out by and the on-screen preview sizes it by, kept in one module so the two cannot drift. Units
 * are PDF points.
 */
import { chartFontScale } from '@ifc-lite/charts';
import { REPORT_MARGIN } from '../export/report/compose.js';
import { FOOTER_HEIGHT, HEADER_HEIGHT } from './compose-scale.js';
import { blockTitle, blockTitleStyle, BLOCK_TITLE_HEIGHT, type BlockHeaderStyleFields } from './block-title.js';

export const BLOCK_GAP = 10;
const SNAPSHOT_HEIGHT = 180;

export interface DocumentChartSizingInput {
  requestedHeight: number;
  pageHeight: number;
  boxWidth: number;
  snapshot: boolean;
  hasData: boolean;
  fontSize?: number;
  headingExtraHeight?: number;
  /** Virtual printable body height after measuring repeated page bands (#6610). */
  printableHeight?: number;
  /** Extra height of an enlarged block heading (`blockTitleStyle(...).extra`), #6632. */
  titleExtraHeight?: number;
  /**
   * The block's size factor (#6548). `boxWidth` is the column the chart is laid out in, which is the
   * real column divided by this factor, so the side-by-side threshold is read against the real
   * column (`boxWidth * layoutScale`): the arrangement a block has at 100 % is the one it keeps at
   * every size, instead of flipping to stacked, and overflowing the frame, as the factor grows.
   */
  layoutScale?: number;
}

/** One chart-height rule shared by PDF composition and the browser preview (#4940). */
export function documentChartSizing(input: DocumentChartSizingInput): { height: number; sideBySide: boolean; stacked: boolean; snapshotHeight: number } {
  const sideBySide = input.snapshot && input.hasData && input.boxWidth * (input.layoutScale ?? 1) >= 640;
  const stacked = input.snapshot && input.hasData && !sideBySide;
  const printableHeight = input.printableHeight ?? input.pageHeight - (REPORT_MARGIN + HEADER_HEIGHT + (input.headingExtraHeight ?? 0)) - (REPORT_MARGIN + FOOTER_HEIGHT);
  // What the frame leaves below the title strip. A snapshot keeps its 180pt unless that would push the
  // block past the frame, as it does in the short frame of a block drawn at twice its size on a landscape
  // page: it then gives way, and a stacked chart keeps at least 40pt of plot.
  const room = printableHeight - 32 * chartFontScale(input.fontSize) - (input.titleExtraHeight ?? 0);
  const minimumPlotHeight = Math.min(40, Math.max(0, room));
  const snapshotHeight = sideBySide ? Math.min(SNAPSHOT_HEIGHT, Math.max(0, room))
    : stacked ? Math.min(SNAPSHOT_HEIGHT, Math.max(0, room - BLOCK_GAP - minimumPlotHeight))
      : 0;
  return {
    height: Math.max(minimumPlotHeight, Math.min(input.requestedHeight, room - (stacked && snapshotHeight > 0 ? snapshotHeight + BLOCK_GAP : 0))),
    sideBySide,
    stacked,
    snapshotHeight,
  };
}

/** A chart block's title strip, chart and, for a snapshot, its snapshot: the one height the composer reserves and the preview pairs by. */
export function documentChartLayout(input: DocumentChartSizingInput): { height: number; sideBySide: boolean; stacked: boolean; snapshotHeight: number; totalHeight: number } {
  const sizing = documentChartSizing(input);
  const totalHeight = 32 * chartFontScale(input.fontSize) + (input.titleExtraHeight ?? 0)
    + (sizing.sideBySide ? Math.max(sizing.height, sizing.snapshotHeight) : sizing.height + (sizing.stacked && sizing.snapshotHeight > 0 ? sizing.snapshotHeight + BLOCK_GAP : 0));
  return { ...sizing, totalHeight };
}

/** Heights derived from one frame by different arithmetic differ by rounding noise; this is the tolerance for comparing them. */
const FRAME_EPSILON = 1e-6;

/** Whether a row of `rowHeight` fits a printable frame of `frameHeight`, equal heights fitting at every scale. */
export function rowFitsFrame(rowHeight: number, frameHeight: number): boolean {
  return rowHeight <= frameHeight + FRAME_EPSILON;
}

/** Height of the printable frame (between header and footer) of a page `pageHeight` tall. */
export function pageFrameHeight(pageHeight: number, headingExtraHeight = 0): number {
  return pageHeight - 2 * REPORT_MARGIN - HEADER_HEIGHT - FOOTER_HEIGHT - headingExtraHeight;
}

/** The image and its optional heading/caption fit inside the printable frame. */
export function documentImageHeight(block: BlockHeaderStyleFields & { height: number; title?: string; caption?: string }, pageHeight: number, headingExtraHeight = 0, printableHeight?: number): number {
  return Math.max(0, Math.min(block.height, (printableHeight ?? pageFrameHeight(pageHeight, headingExtraHeight)) - (blockTitle(block) ? BLOCK_TITLE_HEIGHT + blockTitleStyle(block).extra : 0) - (block.caption ? 14 : 0)));
}
