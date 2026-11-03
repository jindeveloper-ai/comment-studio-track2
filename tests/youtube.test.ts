import { describe, expect, it } from 'vitest';
import {
  extractJson,
  parseViews,
  videosFromData,
} from '../src/server/youtube.js';

describe('YouTube public page parsers', () => {
  it('extracts JSON with braces inside quoted text', () =>
    expect(
      extractJson(
        '<script>var ytInitialData = {"a":"} {", "b":{"c":1}};</script>',
        'ytInitialData',
      ),
    ).toEqual({ a: '} {', b: { c: 1 } }));
  it.each([
    ['조회수 1,234회', 1234],
    ['조회수 1.2만회', 12000],
    ['3.4K views', 3400],
    ['조회수 없음', null],
  ])('parses %s', (s, n) => expect(parseViews(s as string)).toBe(n));
  it('deduplicates video renderers and ignores unrelated IDs', () => {
    const renderer = {
      videoRenderer: {
        videoId: 'abcdefghijk',
        title: { runs: [{ text: '테스트 영상' }] },
        viewCountText: { simpleText: '조회수 2,000회' },
      },
    };
    expect(
      videosFromData(
        { contents: [renderer, renderer, { id: 'unrelated' }] },
        'latest',
      ),
    ).toHaveLength(1);
  });
});
