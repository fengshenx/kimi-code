import { randomUUID } from 'node:crypto';

import { createToolMessage, type ContentPart, type Message } from '@moonshot-ai/kosong';

import { ReadTool } from '../../tools/builtin/file/read';
import type { ExecutableToolResult } from '../../loop/types';
import type { WorkspaceConfig } from '../../tools/support/workspace';
import type { Kaos } from '@moonshot-ai/kaos';

const MAX_FILE_MENTIONS = 5;

/**
 * Matches @path tokens. A valid mention must contain a path separator or
 * a file extension to avoid false positives on email addresses, version
 * pins (pkg@2.3.4), and short commit hashes.
 */
const AT_MENTION_REGEX = /(?:^|(?<=[\s\t"'=]))@("(?:[^"\\]|\\.)+"|[^\s"'=]+)/g;

export interface FileMentionResult {
  readonly assistantMessage: Message;
  readonly toolMessage: Message;
  readonly output: string;
}

export function extractFileMentions(input: readonly ContentPart[]): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();

  for (const part of input) {
    if (part.type !== 'text') continue;
    for (const match of part.text.matchAll(AT_MENTION_REGEX)) {
      if (paths.length >= MAX_FILE_MENTIONS) break;
      let rawPath = match[1]!;
      if (rawPath.startsWith('"') && rawPath.endsWith('"')) {
        rawPath = rawPath.slice(1, -1).replace(/\\"/g, '"');
      }
      if (rawPath.length === 0) continue;
      if (!looksLikeFilePath(rawPath)) continue;
      if (seen.has(rawPath)) continue;
      seen.add(rawPath);
      paths.push(rawPath);
    }
  }

  return paths;
}

function looksLikeFilePath(token: string): boolean {
  if (token.includes('/')) return true;
  if (token.includes('.') && !token.includes('@')) return true;
  if (KNOWN_EXTENSIONLESS_FILES.has(token)) return true;
  return false;
}

const KNOWN_EXTENSIONLESS_FILES = new Set([
  'Makefile',
  'Dockerfile',
  'LICENSE',
  'Procfile',
  'Gemfile',
  'Rakefile',
  'Vagrantfile',
  'Brewfile',
  'Justfile',
  'CHANGELOG',
  'README',
  'AUTHORS',
  'CONTRIBUTORS',
  'CODEOWNERS',
]);

export async function readFileForMention(
  kaos: Kaos,
  workspace: WorkspaceConfig,
  relativePath: string,
  signal: AbortSignal,
): Promise<FileMentionResult | null> {
  const readTool = new ReadTool(kaos, workspace);
  let execution;
  try {
    execution = readTool.resolveExecution({ path: relativePath });
  } catch {
    return null;
  }

  if (execution.isError) return null;

  const toolCallId = `preread_${randomUUID()}`;
  let result: ExecutableToolResult;
  try {
    result = await execution.execute({ turnId: '0', toolCallId, signal });
  } catch {
    return null;
  }
  if (result.isError) return null;

  const output = typeof result.output === 'string' ? result.output : '';
  if (output.length === 0) return null;

  const assistantMessage: Message = {
    role: 'assistant',
    content: [],
    toolCalls: [
      {
        type: 'function',
        id: toolCallId,
        name: 'Read',
        arguments: JSON.stringify({ file_path: relativePath }),
      },
    ],
  };

  const toolMessage = createToolMessage(toolCallId, output);

  return { assistantMessage, toolMessage, output };
}
