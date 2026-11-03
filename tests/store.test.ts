import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/server/store.js';
import type { Draft, Video } from '../src/shared.js';

const stores: Store[] = [];
const dirs: string[] = [];
const video = (id = 'abcdefghijk'): Video => ({
  id,
  title: '약속을 지키는 태도',
  channel: 'test',
  publishedAt: '',
  thumbnail: '',
  duration: '',
  viewCount: 2000,
  source: 'latest',
});
const draft: Draft = {
  id: 'fixture',
  videoId: 'abcdefghijk',
  concern: '연애 고민',
  evidence: { source: 'title', quote: '약속' },
  comment: '운명원에서 약속을 지키는 인연이 궁금하네요.',
  createdAt: '',
  model: 'fixture',
  source: 'latest',
  validation: [],
  context: {
    title: '약속',
    description: '',
    transcript: '',
    topComments: [],
    transcriptStatus: 'unavailable',
    warnings: [],
  },
};
function make(max = 10, now?: () => Date) {
  const s = new Store(':memory:', max, now);
  stores.push(s);
  s.setProfile('youtube1', true, 'UCtest1', 'test');
  return s;
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
describe('durable posting rules', () => {
  it('does not round growth below 150 up into an eligible video', () => {
    let now = new Date('2026-11-03T00:00:00Z');
    const s = make(10, () => now);
    const v = video();
    s.observe(v.id, 2000);
    now = new Date('2026-11-03T01:00:01Z');
    expect(s.discovery({ ...v, viewCount: 2150 })).toMatchObject({
      hourlyGrowth: 149,
      eligible: false,
    });
  });
  it('blocks reuse of an edited comment on another video', () => {
    const s = make();
    const j = s.reserve(video(), draft, draft.comment, 'youtube1');
    s.updateJob(j.id, { status: 'success' });
    expect(() =>
      s.reserve(
        video('different01'),
        draft,
        '  ' + draft.comment + '  ',
        'youtube1',
      ),
    ).toThrow(/이미 사용/);
    expect(s.commentUsed(draft.comment)).toBe(true);
  });
  it('limits draft requests per video and Korean day without consuming posting quota', () => {
    let now = new Date('2026-11-03T14:59:00Z');
    const s = make(10, () => now);
    for (let i = 0; i < 5; i++) s.claimDraftGeneration('abcdefghijk');
    expect(() => s.claimDraftGeneration('abcdefghijk')).toThrow(/5회/);
    expect(() => s.claimDraftGeneration('different01')).not.toThrow();
    expect(s.quota().used).toBe(0);
    now = new Date('2026-11-03T15:00:00Z');
    expect(() => s.claimDraftGeneration('abcdefghijk')).not.toThrow();
  });
  it('serializes deletion with posting, keeps quota and duplicate restrictions, and binds authors', () => {
    const s = make();
    const j = s.reserve(video(), draft, draft.comment, 'youtube1');
    expect(j.authorChannelId).toBe('UCtest1');
    s.updateJob(j.id, {
      status: 'success',
      commentUrl:
        'https://www.youtube.com/watch?v=abcdefghijk&lc=Ugx_fixture001',
    });
    s.beginDeletion(j.id);
    expect(() => s.beginDeletion(j.id)).toThrow();
    expect(() =>
      s.reserve(video('different01'), draft, draft.comment, 'youtube1'),
    ).toThrow(/진행/);
    s.markDeleting(j.id);
    s.updateDeletion(j.id, 'deleted', 'confirmed');
    expect(s.quota().used).toBe(1);
    expect(s.blockedVideos()).toContain('abcdefghijk');
    expect(() => s.reserve(video(), draft, draft.comment, 'youtube1')).toThrow(
      /이미/,
    );
    expect(() => s.beginDeletion(j.id)).toThrow();
    expect(
      s.reserve(
        video('different01'),
        draft,
        draft.comment + ' 다른 영상의 근거.',
        'youtube1',
      ).id,
    ).not.toBe(j.id);
  });
  it('preserves unconfirmed deletion across restart without changing the posting result', () => {
    const dir = mkdtempSync(join(tmpdir(), 'studio-delete-restart-'));
    dirs.push(dir);
    const path = join(dir, 'db.sqlite');
    const s = new Store(path);
    s.setProfile('youtube1', true, 'UCtest1');
    const j = s.reserve(video(), draft, draft.comment, 'youtube1');
    s.updateJob(j.id, {
      status: 'success',
      commentUrl:
        'https://www.youtube.com/watch?v=abcdefghijk&lc=Ugx_fixture001',
    });
    s.beginDeletion(j.id);
    s.markDeleting(j.id);
    s.close();
    const next = new Store(path);
    stores.push(next);
    expect(next.job(j.id)).toMatchObject({
      status: 'success',
      deletion: { state: 'uncertain' },
    });
    expect(next.activeJobs()).toHaveLength(0);
    expect(() => next.beginDeletion(j.id)).toThrow();
    expect(next.quota().used).toBe(1);
  });
  it('reserves atomically, blocking both duplicate clicks and different profiles', () => {
    const s = make();
    s.setProfile('youtube2', true, 'UCtest2');
    const j = s.reserve(video(), draft, draft.comment, 'youtube1');
    expect(() => s.reserve(video(), draft, draft.comment, 'youtube2')).toThrow(
      /이미/,
    );
    s.updateJob(j.id, { status: 'success' });
    expect(() => s.reserve(video(), draft, draft.comment, 'auto')).toThrow(
      /이미/,
    );
  });
  it('lets only one browser post run at a time', () => {
    const s = make();
    s.reserve(video(), draft, draft.comment, 'auto');
    expect(() =>
      s.reserve(video('different01'), draft, draft.comment, 'auto'),
    ).toThrow(/진행 중/);
  });
  it('counts all profiles against the same daily limit, including uncertain posts', () => {
    const s = make(1);
    const j = s.reserve(video(), draft, draft.comment, 'auto');
    s.markSubmitting(j.id);
    s.updateJob(j.id, { status: 'uncertain' });
    expect(s.quota().used).toBe(1);
    expect(() =>
      s.reserve(video('different01'), draft, draft.comment, 'auto'),
    ).toThrow(/상한/);
  });
  it('releases only failures before submission', () => {
    const s = make();
    const j = s.reserve(video(), draft, draft.comment, 'auto');
    s.updateJob(j.id, { status: 'failed' });
    expect(s.quota().used).toBe(0);
    expect(s.reserve(video(), draft, draft.comment, 'auto').id).not.toBe(j.id);
  });
  it('rotates only ready distinct channels', () => {
    const s = make();
    s.setProfile('youtube2', true, 'UCtest2');
    const a = s.reserve(video(), draft, draft.comment, 'auto');
    s.updateJob(a.id, { status: 'success' });
    const b = s.reserve(
      video('different01'),
      draft,
      draft.comment + ' 다른 영상의 근거.',
      'auto',
    );
    expect([a.profileId, b.profileId]).toEqual(['youtube1', 'youtube2']);
    expect(() => s.setProfile('youtube3', true, 'UCtest1')).toThrow(/같은/);
  });
  it('blocks posting discovery drafts even if video source later changes', () => {
    const s = make();
    expect(() =>
      s.reserve(
        video(),
        { ...draft, source: 'discovery' },
        draft.comment,
        'auto',
      ),
    ).toThrow(/초안/);
  });
  it('preserves uncertain submissions across restart and releases pre-submit jobs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'studio-test-'));
    dirs.push(dir);
    const path = join(dir, 'data.sqlite');
    const first = new Store(path);
    first.setProfile('youtube1', true, 'UCtest');
    const j = first.reserve(video(), draft, draft.comment, 'auto');
    first.markSubmitting(j.id);
    first.close();
    const next = new Store(path);
    stores.push(next);
    expect(next.job(j.id)?.status).toBe('uncertain');
    expect(() => next.reserve(video(), draft, draft.comment, 'auto')).toThrow(
      /이미/,
    );
  });
  it('checks the quota again if midnight passes between reserve and submit', () => {
    let now = new Date('2026-10-23T14:59:58Z');
    const s = make(1, () => now);
    const j = s.reserve(video(), draft, draft.comment, 'auto');
    now = new Date('2026-10-23T15:00:01Z');
    s.markSubmitting(j.id);
    expect(s.quota().day).toBe('2026-10-24');
    expect(s.quota().used).toBe(1);
  });
  it('never infers growth from cumulative views or unobserved data', () => {
    let now = new Date('2026-10-23T00:00:00Z');
    const s = make(10, () => now);
    const v = video();
    s.observe(v.id, 2000);
    expect(s.discovery(v).hourlyGrowth).toBeNull();
    now = new Date('2026-10-23T00:30:00Z');
    expect(s.discovery({ ...v, viewCount: 2300 }).eligible).toBe(false);
    now = new Date('2026-10-23T01:00:00Z');
    expect(s.discovery({ ...v, viewCount: 2200 })).toMatchObject({
      hourlyGrowth: 200,
      eligible: true,
    });
    expect(s.discovery({ ...v, viewCount: 6000 }).eligible).toBe(false);
  });
});
