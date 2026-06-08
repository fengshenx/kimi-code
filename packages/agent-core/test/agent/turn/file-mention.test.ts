import { describe, expect, it } from 'vitest';

import { extractFileMentions, readFileForMention } from '../../../src/agent/turn/file-mention';
import type { WorkspaceConfig } from '../../../src/tools/support/workspace';

describe('extractFileMentions', () => {
  it('extracts a single bare @path', () => {
    const input = [{ type: 'text' as const, text: '@src/main.ts explain this' }];
    expect(extractFileMentions(input)).toEqual(['src/main.ts']);
  });

  it('extracts multiple @paths', () => {
    const input = [{ type: 'text' as const, text: '@src/a.ts and @src/b.ts' }];
    expect(extractFileMentions(input)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('extracts quoted paths with spaces', () => {
    const input = [{ type: 'text' as const, text: '@"path with spaces/file.ts" hello' }];
    expect(extractFileMentions(input)).toEqual(['path with spaces/file.ts']);
  });

  it('deduplicates repeated mentions', () => {
    const input = [{ type: 'text' as const, text: '@src/a.ts and @src/a.ts again' }];
    expect(extractFileMentions(input)).toEqual(['src/a.ts']);
  });

  it('caps at 5 mentions', () => {
    const input = [
      { type: 'text' as const, text: '@a.ts @b.ts @c.ts @d.ts @e.ts @f.ts @g.ts' },
    ];
    expect(extractFileMentions(input)).toHaveLength(5);
  });

  it('ignores non-text content parts', () => {
    const input = [
      { type: 'image_url' as const, imageUrl: { url: 'data:...' } },
      { type: 'text' as const, text: '@src/main.ts' },
    ];
    expect(extractFileMentions(input)).toEqual(['src/main.ts']);
  });

  it('returns empty array when no mentions', () => {
    const input = [{ type: 'text' as const, text: 'no mentions here' }];
    expect(extractFileMentions(input)).toEqual([]);
  });

  it('handles @path at start of text', () => {
    const input = [{ type: 'text' as const, text: '@package.json' }];
    expect(extractFileMentions(input)).toEqual(['package.json']);
  });

  it('handles @path after delimiter characters', () => {
    const input = [{ type: 'text' as const, text: 'check\t@foo.ts and "@bar.ts"' }];
    const result = extractFileMentions(input);
    expect(result).toContain('foo.ts');
  });

  it('skips empty @ with no path', () => {
    const input = [{ type: 'text' as const, text: '@ nothing' }];
    expect(extractFileMentions(input)).toEqual([]);
  });

  it('does not match email addresses', () => {
    const input = [{ type: 'text' as const, text: 'send to user@example.com' }];
    expect(extractFileMentions(input)).toEqual([]);
  });

  it('does not match version pins like pkg@2.3.4', () => {
    const input = [{ type: 'text' as const, text: 'install react@18.2.0' }];
    expect(extractFileMentions(input)).toEqual([]);
  });

  it('does not match bare tokens without path separator or extension', () => {
    const input = [{ type: 'text' as const, text: '@commitHash and @username' }];
    expect(extractFileMentions(input)).toEqual([]);
  });

  it('matches @Makefile-like paths without extension if they have /', () => {
    const input = [{ type: 'text' as const, text: '@src/Makefile' }];
    expect(extractFileMentions(input)).toEqual(['src/Makefile']);
  });

  it('matches bare filenames with extensions', () => {
    const input = [{ type: 'text' as const, text: '@Makefile.txt' }];
    expect(extractFileMentions(input)).toEqual(['Makefile.txt']);
  });

  it('matches known extensionless files like Makefile, Dockerfile, LICENSE', () => {
    const input = [{ type: 'text' as const, text: '@Makefile @Dockerfile @LICENSE' }];
    expect(extractFileMentions(input)).toEqual(['Makefile', 'Dockerfile', 'LICENSE']);
  });

  it('accumulates mentions across multiple content parts', () => {
    const input = [
      { type: 'text' as const, text: '@src/a.ts' },
      { type: 'text' as const, text: '@src/b.ts' },
    ];
    expect(extractFileMentions(input)).toEqual(['src/a.ts', 'src/b.ts']);
  });
});

describe('readFileForMention', () => {
  function mockKaos(files: Record<string, string>) {
    return {
      stat: async (path: string) => {
        if (!(path in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return { stMode: 0o100644 };
      },
      readText: async (path: string) => {
        if (!(path in files)) throw new Error('ENOENT');
        return files[path]!;
      },
      readBytes: async (path: string, n: number) => {
        if (!(path in files)) throw new Error('ENOENT');
        return Buffer.from(files[path]!.slice(0, n));
      },
      readLines: async function* (path: string) {
        if (!(path in files)) throw new Error('ENOENT');
        const lines = files[path]!.split('\n');
        for (const line of lines) {
          yield line + '\n';
        }
      },
      pathClass: () => 'posix' as const,
      gethome: () => '/home/user',
    };
  }

  const workspace: WorkspaceConfig = { workspaceDir: '/work', additionalDirs: [] };
  const signal = AbortSignal.timeout(5000);

  it('returns null for non-existent file', async () => {
    const kaos = mockKaos({});
    const result = await readFileForMention(kaos as any, workspace, 'missing.ts', signal);
    expect(result).toBeNull();
  });

  it('returns assistant + tool messages for a valid file', async () => {
    const kaos = mockKaos({ '/work/hello.ts': 'const x = 1;\n' });
    const result = await readFileForMention(kaos as any, workspace, 'hello.ts', signal);
    expect(result).not.toBeNull();
    expect(result!.assistantMessage.role).toBe('assistant');
    expect(result!.assistantMessage.toolCalls).toHaveLength(1);
    expect(result!.assistantMessage.toolCalls[0]!.name).toBe('Read');
    expect(result!.toolMessage.role).toBe('tool');
    expect(result!.toolMessage.toolCallId).toBe(result!.assistantMessage.toolCalls[0]!.id);
  });

  it('formats output with line numbers', async () => {
    const kaos = mockKaos({ '/work/f.ts': 'line1\nline2\nline3\n' });
    const result = await readFileForMention(kaos as any, workspace, 'f.ts', signal);
    expect(result).not.toBeNull();
    const output = result!.toolMessage.content[0]!;
    expect(output).toHaveProperty('type', 'text');
    const text = (output as { type: 'text'; text: string }).text;
    expect(text).toContain('1\tline1');
    expect(text).toContain('2\tline2');
    expect(text).toContain('3\tline3');
    expect(text).toContain('<system>');
  });

  it('returns null for directories', async () => {
    const kaos = {
      ...mockKaos({}),
      stat: async () => ({ stMode: 0o040755 }),
    };
    const result = await readFileForMention(kaos as any, workspace, 'some-dir', signal);
    expect(result).toBeNull();
  });

  it('resolves relative paths against workspace dir', async () => {
    const ws: WorkspaceConfig = { workspaceDir: '/project', additionalDirs: [] };
    const kaos = mockKaos({ '/project/src/foo.ts': 'content\n' });
    const result = await readFileForMention(kaos as any, ws, 'src/foo.ts', signal);
    expect(result).not.toBeNull();
  });

  it('handles absolute paths directly', async () => {
    const ws: WorkspaceConfig = { workspaceDir: '/work', additionalDirs: ['/abs'] };
    const kaos = mockKaos({ '/abs/path.ts': 'content\n' });
    const result = await readFileForMention(kaos as any, ws, '/abs/path.ts', signal);
    expect(result).not.toBeNull();
  });
});
