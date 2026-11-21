/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { addTopicToProject, addViewpointToTopic, createBCFProject, createBCFTopic, writeBCF, type BCFViewpoint } from '@ifc-lite/bcf';
import type { RegistryReviewSummary } from './registry-client';
import { bcfExportFilename } from '@/lib/export/download';
/** The native Layers review ZIP writer, shared by the download button and host artifacts. */
export async function layerReviewArtifact(review: RegistryReviewSummary) {
  if (!review.topics?.length) throw new Error('The native layer review has no topics to export.');
  const project = createBCFProject({ name: `review-${review.id.slice(0, 8)}` });
  for (const item of review.topics) {
    const topic = createBCFTopic({ title: item.title, ...(item.description !== undefined ? { description: item.description } : {}), author: item.author ?? 'anonymous' });
    topic.guid = item.guid; topic.creationDate = item.createdAt; addTopicToProject(project, topic);
    if (item.viewpoint) addViewpointToTopic(topic, item.viewpoint as unknown as BCFViewpoint);
  }
  return { data: await writeBCF(project), filename: bcfExportFilename(`review-${review.id.slice(0, 8)}`) };
}
