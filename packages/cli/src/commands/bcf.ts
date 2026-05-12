/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-lite bcf <subcommand> [options]
 *
 * Work with BCF (BIM Collaboration Format) files.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { BCFNamespace } from '@ifc-lite/sdk';
import { printJson, getFlag, fatal } from '../output.js';

export async function bcfCommand(args: string[]): Promise<void> {
  const subcommand = args.find(a => !a.startsWith('-'));
  if (!subcommand) fatal('Usage: ifc-lite bcf <list|create|add-comment> [options]');

  const bcf = new BCFNamespace();

  switch (subcommand) {
    case 'create': {
      const title = getFlag(args, '--title');
      const description = getFlag(args, '--description');
      const author = getFlag(args, '--author') ?? 'cli@ifc-lite.com';
      const outPath = getFlag(args, '--out');
      if (!title) fatal('Usage: ifc-lite bcf create --title "Issue" [--description "..."] [--author email] --out file.bcf');
      if (!outPath) fatal('--out is required for BCF creation');

      const project = await bcf.createProject({ name: 'CLI Project' });
      const topic = await bcf.createTopic({ title, description, author });
      await bcf.addTopic(project, topic);

      const blob = await bcf.write(project);
      const buffer = Buffer.from(await (blob as Blob).arrayBuffer());
      await writeFile(outPath, buffer);
      process.stderr.write(`BCF written to ${outPath}\n`);
      break;
    }

    case 'list': {
      const bcfPath = args.find(a => !a.startsWith('-') && a !== 'list');
      if (!bcfPath) fatal('Usage: ifc-lite bcf list <file.bcf>');

      const data = await readFile(bcfPath);
      const project = await bcf.read(data.buffer as ArrayBuffer);
      printJson(project);
      break;
    }

    case 'add-comment': {
      const bcfPath = getFlag(args, '--file');
      const topicId = getFlag(args, '--topic');
      const text = getFlag(args, '--text');
      const author = getFlag(args, '--author') ?? 'cli@ifc-lite.com';
      const outPath = getFlag(args, '--out');
      if (!bcfPath || !text) fatal('Usage: ifc-lite bcf add-comment --file <file.bcf> --text "..." [--topic id] --out <file.bcf>');
      if (!outPath) fatal('--out is required');

      const data = await readFile(bcfPath);
      const project = await bcf.read(data.buffer as ArrayBuffer) as { topics?: Array<{ guid: string }> | Map<string, { guid: string }> };
      const comment = await bcf.createComment({ author, comment: text });

      // Add comment to first topic if no topic ID specified
      if (project.topics) {
        const topics = Array.isArray(project.topics) ? project.topics : [...project.topics.values()];
        const target = topicId
          ? topics.find((t: any) => t.guid === topicId)
          : topics[0];
        if (target) {
          await bcf.addComment(target, comment);
        }
      }

      const blob = await bcf.write(project);
      const buffer = Buffer.from(await (blob as Blob).arrayBuffer());
      await writeFile(outPath, buffer);
      process.stderr.write(`BCF updated and written to ${outPath}\n`);
      break;
    }

    default:
      fatal(`Unknown bcf subcommand: ${subcommand}. Supported: create, list, add-comment`);
  }
}
