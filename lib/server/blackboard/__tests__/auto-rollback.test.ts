import { describe, expect, it } from 'vitest';
import { rollbackEditedFiles } from '../auto-rollback';

describe('rollbackEditedFiles', () => {
  it('returns empty for no edited paths', async () => {
    const result = await rollbackEditedFiles({
      workspace: process.cwd(),
      editedPaths: [],
    });
    expect(result.rolledBack).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it('returns failures for non-existent workspace', async () => {
    const result = await rollbackEditedFiles({
      workspace: '/nonexistent/path',
      editedPaths: ['fake-file.ts'],
    });
    expect(result.failed.length).toBe(1);
    expect(result.rolledBack).toEqual([]);
  });
});