import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changedLines, instructionPaths, validateReviewDraft } from './preview-model.ts';

const patch = '@@ -4,3 +4,4 @@\n context\n-old\n+new\n+extra\n context\n@@ -20 +21 @@\n-before\n+after';
const files = [{ filename: 'src/api/index.ts', status: 'modified', patch }];
test('inline locations refer to additions, including multiple diff hunks', () => {
  assert.deepEqual([...changedLines(patch)], [5, 6, 21]);
  const result = validateReviewDraft({ summary: 'Needs review', comments: [{ path: 'src/api/index.ts', line: 21, body: 'Explain defect' }] }, files);
  assert.equal(result.comments[0].line, 21);
});
test('rejects invented paths and unchanged lines rather than misplacing comments', () => {
  for (const comment of [{ path: 'other.ts', line: 5, body: 'Issue' }, { path: 'src/api/index.ts', line: 4, body: 'Issue' }]) {
    assert.throws(() => validateReviewDraft({ summary: '', comments: [comment] }, files), /not on an added line/);
  }
});
test('allows deleting all comments and editing summary', () => {
  assert.deepEqual(validateReviewDraft({ summary: 'My edited conclusion', comments: [] }, files), { summary: 'My edited conclusion', comments: [] });
});
test('collects applicable root and nested instructions once', () => {
  assert.deepEqual(instructionPaths([...files, { filename: 'src/api/other.ts', status: 'modified' }]), ['AGENTS.md', 'src/AGENTS.md', 'src/api/AGENTS.md']);
});
