import { describe, expect, it } from 'vitest';
import {
  charCount,
  koreanDay,
  parseVideoId,
  safeError,
  validateComment,
} from '../src/server/safety.js';

describe('comment safeguards', () => {
  it.each([39, 40, 120, 121])('enforces inclusive length %i', (n) => {
    const s = `운명원${'가'.repeat(n - 3)}`;
    expect(validateComment(s).some((e) => e.includes('40~120'))).toBe(
      n < 40 || n > 120,
    );
  });
  it('counts visible Unicode graphemes including spaces', () =>
    expect(charCount('가 나👨‍👩‍👧‍👦')).toBe(4));
  it.each([
    'https://example.com',
    '#연애',
    '＃연애',
    '운명원에서 상담받고 왔는데',
  ])('rejects prohibited content: %s', (s) =>
    expect(
      validateComment(`운명원 ${'연락 '.repeat(15)}${s}`).length,
    ).toBeGreaterThan(0),
  );
  it('requires a real source quote and its reflection in the comment', () => {
    const context = {
      title: '약속을 지키는 태도가 중요한 연애',
      description: '',
      transcript: '',
      topComments: [],
      transcriptStatus: 'unavailable' as const,
      warnings: [],
    };
    const comment =
      '약속을 지키는 태도가 중요하다는 말이 공감돼요. 운명원에서 서로 잘 맞는 인연인지 연애 사주 한번 보고 싶네요.';
    expect(
      validateComment(
        comment,
        { source: 'title', quote: '약속을 지키는 태도' },
        context,
      ),
    ).toEqual([]);
    expect(
      validateComment(
        comment,
        { source: 'title', quote: '없는 대사' },
        context,
      ),
    ).toHaveLength(2);
  });
  it('never reflects raw SDK errors', () =>
    expect(safeError(new Error('sensitive upstream response'))).not.toContain(
      'upstream',
    ));
});
describe('video URL boundary', () => {
  it.each([
    'https://youtu.be/abcdefghijk?t=3',
    'https://www.youtube.com/watch?v=abcdefghijk',
    'https://youtube.com/shorts/abcdefghijk',
  ])('accepts video URL %s', (s) =>
    expect(parseVideoId(s)).toBe('abcdefghijk'),
  );
  it.each([
    'http://youtube.com/watch?v=abcdefghijk',
    'https://youtube.com.evil.test/watch?v=abcdefghijk',
    'https://user:pass@youtube.com/watch?v=abcdefghijk',
    'https://127.0.0.1/watch?v=abcdefghijk',
    'https://youtube.com:444/watch?v=abcdefghijk',
  ])('rejects untrusted URL %s', (s) =>
    expect(() => parseVideoId(s)).toThrow(),
  );
  it('uses the Korean date at midnight', () => {
    expect(koreanDay(new Date('2026-10-23T14:59:59Z'))).toBe('2026-10-23');
    expect(koreanDay(new Date('2026-10-23T15:00:00Z'))).toBe('2026-10-24');
  });
});
