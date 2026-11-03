import { describe, expect, it } from 'vitest';
import { commentTarget } from '../src/server/comment-target.js';
import type { Draft, PostJob, Status } from '../src/shared.js';
import { postingBlockReason } from '../src/web/post-availability.js';

const job = {
  videoId: 'abcdefghijk',
  commentUrl: 'https://www.youtube.com/watch?v=abcdefghijk&lc=Ugx_fixture001',
} as PostJob;
describe('exact comment target', () => {
  it('rebuilds only the approved YouTube comment URL', () => {
    expect(commentTarget(job)).toEqual({
      commentId: 'Ugx_fixture001',
      url: 'https://www.youtube.com/watch?v=abcdefghijk&lc=Ugx_fixture001&hl=ko',
    });
  });
  it.each([
    'https://evil.test/watch?v=abcdefghijk&lc=Ugx_fixture001',
    'https://www.youtube.com@evil.test/watch?v=abcdefghijk&lc=Ugx_fixture001',
    'https://www.youtube.com/watch?v=otherVideo1&lc=Ugx_fixture001',
    'https://www.youtube.com/watch?v=abcdefghijk',
    'https://www.youtube.com/watch?v=abcdefghijk&lc=../../file',
    'https://www.youtube.com:8443/watch?v=abcdefghijk&lc=Ugx_fixture001',
  ])('refuses a wrong or ambiguous deletion target', (commentUrl) => {
    expect(() => commentTarget({ ...job, commentUrl })).toThrow();
  });
});

describe('posting button explanations', () => {
  const status = {
    profiles: [
      { id: 'youtube1', ready: true },
      { id: 'youtube2', ready: true },
      { id: 'youtube3', ready: false },
    ],
    browser: { automation: true },
    quota: { used: 1, max: 10 },
    activeJobs: [],
  } as unknown as Status;
  const input = {
    status,
    draft: { source: 'latest' } as Draft,
    selectedVideoId: 'abcdefghijk',
    profileId: 'youtube1',
    blocked: ['abcdefghijk'],
    validation: [],
    length: 70,
    generating: false,
  };
  it('keeps a posted video blocked after changing account and regenerating the draft', () => {
    expect(postingBlockReason(input)).toMatch(/다른 영상/);
    expect(
      postingBlockReason({
        ...input,
        profileId: 'youtube2',
        draft: { ...input.draft, id: 'regenerated' },
      }),
    ).toMatch(/다시 게시할 수 없습니다/);
  });
  it('allows a different video with another connected account, but explains disconnected selections', () => {
    expect(
      postingBlockReason({
        ...input,
        selectedVideoId: 'different01',
        profileId: 'youtube2',
      }),
    ).toBeNull();
    expect(
      postingBlockReason({
        ...input,
        selectedVideoId: 'different01',
        profileId: 'youtube3',
      }),
    ).toMatch(/선택한 게시 프로필/);
  });
});
