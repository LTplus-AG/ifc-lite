/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `scanToBim.*`: the scan-to-BIM section of the point cloud panel (#6894):
 * the Detect elements action and its progress, and the review list of
 * proposed IFC elements with accept / reject, filters and the overlay legend.
 * Lengths arrive formatted in metres; `{value}` carries the locale's digits.
 */

import type { TranslationValue } from '../types';

export const scanToBimEn = {
  'scanToBim.title': 'Scan to BIM',
  'scanToBim.intro': 'Detect walls, slabs, columns and pipes in the scan and review them as proposed IFC elements.',
  'scanToBim.scanLabel': 'Scan',
  'scanToBim.target': 'Proposals for {model} ({schema})',
  'scanToBim.noTarget': 'No IFC model loaded: the pipe class defaults to IFC4.',
  'scanToBim.cropped': 'Only points inside the section box are used.',
  'scanToBim.whole': 'The whole retained scan sample is used. Turn on a section box to detect a region.',
  'scanToBim.detect': 'Detect elements',
  'scanToBim.detectAgain': 'Detect again',
  'scanToBim.cancel': 'Cancel',
  'scanToBim.stage.starting': 'Starting detection…',
  'scanToBim.stage.segmenting': 'Finding planes and cylinders…',
  'scanToBim.stage.proposing': 'Proposing elements…',
  'scanToBim.error.noSample': 'This scan has no retained points to detect on yet.',
  'scanToBim.error.failed': 'Detection failed: {message}',
  'scanToBim.summary': {
    one: '{count} proposal from {planes} planes and {cylinders} cylinders ({points} points)',
    other: '{count} proposals from {planes} planes and {cylinders} cylinders ({points} points)',
  },
  'scanToBim.summaryCropped': 'Section box crop.',
  'scanToBim.decided': '{accepted} accepted, {rejected} rejected, {pending} to review',
  'scanToBim.filter.legend': 'Show',
  'scanToBim.filter.class': '{label} ({count})',
  'scanToBim.filter.minConfidence': 'Minimum confidence',
  'scanToBim.filter.minConfidenceValue': '{value} %',
  'scanToBim.acceptShown': 'Accept all shown',
  'scanToBim.rejectShown': 'Reject all shown',
  'scanToBim.resetShown': 'Reset shown',
  'scanToBim.listLabel': 'Proposed elements',
  'scanToBim.empty': 'No proposals match the filter.',
  'scanToBim.accept': 'Accept',
  'scanToBim.reject': 'Reject',
  'scanToBim.acceptOne': 'Accept {id}',
  'scanToBim.rejectOne': 'Reject {id}',
  'scanToBim.confidence': '{value} %',
  'scanToBim.class.IfcWall': 'Walls',
  'scanToBim.class.IfcSlab': 'Slabs',
  'scanToBim.class.IfcColumn': 'Columns',
  'scanToBim.class.IfcPipeSegment': 'Pipes',
  'scanToBim.class.IfcFlowSegment': 'Pipes (flow segments)',
  'scanToBim.basis.pairedFaces': 'two faces, measured thickness',
  'scanToBim.basis.singleFace': 'one face, default thickness',
  'scanToBim.basis.floorCeilingPair': 'floor and ceiling, measured thickness',
  'scanToBim.basis.floor': 'floor, default thickness',
  'scanToBim.basis.ceiling': 'ceiling, default thickness',
  'scanToBim.basis.cylinder': 'cylinder fit',
  'scanToBim.size.wall': '{length} m long, {thickness} m thick, {height} m high',
  'scanToBim.size.slab': '{area} m², {thickness} m thick',
  'scanToBim.size.column': 'Ø {diameter} m, {height} m high',
  'scanToBim.size.pipe': 'Ø {diameter} m, {length} m long',
  'scanToBim.create': 'Create accepted elements',
  'scanToBim.createCount': {
    one: 'Create {count} accepted element in {model}',
    other: 'Create {count} accepted elements in {model}',
  },
  'scanToBim.createNone': 'Accept proposals to create them as IFC elements.',
  'scanToBim.acceptedHidden': {
    one: '{count} accepted proposal is hidden by the filter and will not be created.',
    other: '{count} accepted proposals are hidden by the filter and will not be created.',
  },
  'scanToBim.createdEarlier': {
    one: '{count} element created from {scan} earlier in this session is in {model}; creating again may duplicate it.',
    other: '{count} elements created from {scan} earlier in this session are in {model}; creating again may duplicate them.',
  },
  'scanToBim.needsModel': 'Creating elements needs an IFC model to hold them.',
  'scanToBim.createBlank': 'Create a blank IFC model',
  'scanToBim.creatingBlank': 'Creating a blank IFC model…',
  'scanToBim.blankFailed': 'The blank IFC model could not be created.',
  'scanToBim.created': {
    one: '{count} element created in {model}, one undo step.',
    other: '{count} elements created in {model}, one undo step.',
  },
  'scanToBim.createFailed': 'Could not create the elements: {message}',
  'scanToBim.frameMoved': 'The scan has moved since it was detected, so the proposals no longer sit on it. Detect again, then create.',
  'scanToBim.createdBadge': 'Created',
  'scanToBim.fit': 'RMS {rms} mm, {points} points',
} as const satisfies Record<string, TranslationValue>;
