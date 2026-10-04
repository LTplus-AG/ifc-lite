/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CSSProperties } from 'react';
import { BLOCK_TITLE_HEIGHT, BLOCK_TITLE_SIZE_DEFAULT, blockTitleStyle, type BlockHeaderStyleFields } from '@/lib/document/block-title';
import { BLOCK_TITLE_PAD } from '@/lib/document/compose-block-title';

export interface BlockHeadingProps {
  block: BlockHeaderStyleFields;
  text: string;
  /** Browser pixels per point of the sheet. */
  pointScale: number;
  /** 1, or a chart's text-size factor: the heading's default size follows it (see `blockTitleStyle`). */
  unit?: number;
  /** The kind's own classes and inline style, kept exactly while no heading style is authored. */
  className: string;
  style?: CSSProperties;
  title?: string;
}

/**
 * The preview's one block heading (#6632). It reads `blockTitleStyle`, the same function every PDF
 * composer reads through `blockTitleItems`, so the size, ink, strip height and background cannot
 * differ between the two.
 */
export function BlockHeading({ block, text, pointScale, unit = 1, className, style, title }: BlockHeadingProps) {
  const heading = blockTitleStyle(block, BLOCK_TITLE_SIZE_DEFAULT * unit);
  const authored = heading.size !== BLOCK_TITLE_SIZE_DEFAULT * unit || heading.textColor !== undefined || heading.backgroundColor !== undefined;
  if (!authored) return <div className={className} style={style} title={title}>{text}</div>;
  const strip = (BLOCK_TITLE_HEIGHT * unit + heading.extra) * pointScale;
  const authoredStyle: CSSProperties = {
    ...style,
    fontSize: heading.size * pointScale,
    lineHeight: `${strip}px`,
    height: strip,
    ...(heading.textColor ? { color: heading.textColor } : {}),
    ...(heading.backgroundColor ? { backgroundColor: heading.backgroundColor, paddingLeft: BLOCK_TITLE_PAD * pointScale, paddingRight: BLOCK_TITLE_PAD * pointScale } : {}),
  };
  return <div className={className} style={authoredStyle} title={title}>{text}</div>;
}
