import { type Browser, chromium, type Page } from 'playwright';
import type { SourceKind, Video, VideoContext } from '../shared.js';
import { defaultBrowser, requireAutomation } from './default-browser.js';
import { AppError } from './safety.js';

type Obj = Record<string, unknown>;
function object(value: unknown): Obj {
  return value && typeof value === 'object' ? (value as Obj) : {};
}
export function textOf(value: unknown): string {
  const o = object(value);
  if (typeof o.simpleText === 'string') return o.simpleText;
  if (typeof o.content === 'string') return o.content;
  return Array.isArray(o.runs)
    ? o.runs.map((r) => String(object(r).text || '')).join('')
    : '';
}
export function* walk(value: unknown): Generator<Obj> {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) yield* walk(item);
  } else {
    yield value as Obj;
    for (const v of Object.values(value)) yield* walk(v);
  }
}
export function extractJson(html: string, variable: string): Obj {
  const re = new RegExp(
    `(?:var\\s+${variable}\\s*=|window\\["${variable}"\\]\\s*=|${variable}\\s*=)\\s*`,
  );
  const match = re.exec(html);
  if (!match) return {};
  const start = match.index + match[0].length;
  let depth = 0,
    quoted = false,
    escaped = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, i + 1));
      } catch {
        return {};
      }
    }
  }
  return {};
}
export function parseViews(text: string): number | null {
  const s = text.replace(/조회수|회|views?|,/gi, '').trim();
  const m = s.match(/([\d.]+)\s*(만|천|억|K|M|B)?/i);
  if (!m) return null;
  const factor =
    (
      {
        만: 10000,
        천: 1000,
        억: 100000000,
        K: 1000,
        M: 1000000,
        B: 1000000000,
      } as Record<string, number>
    )[(m[2] || '').toUpperCase()] || 1;
  return Math.round(Number(m[1]) * factor);
}
export function videosFromData(data: Obj, source: SourceKind): Video[] {
  const seen = new Set<string>();
  const videos: Video[] = [];
  for (const node of walk(data)) {
    const v = object(node.videoRenderer);
    if (
      typeof v.videoId !== 'string' ||
      !/^[\w-]{11}$/.test(v.videoId) ||
      seen.has(v.videoId)
    )
      continue;
    seen.add(v.videoId);
    videos.push({
      id: v.videoId,
      title: textOf(v.title),
      channel: textOf(v.ownerText || v.longBylineText),
      thumbnail: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
      publishedAt: textOf(v.publishedTimeText),
      viewCount: parseViews(textOf(v.viewCountText)),
      duration: textOf(v.lengthText),
      source,
    });
  }
  return videos;
}
const headers = {
  'User-Agent': 'Mozilla/5.0',
  'Accept-Language': 'ko-KR,ko;q=0.9',
};
async function publicHtml(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(25_000),
      redirect: 'error',
    });
    if (!res.ok) throw new Error();
    const text = await res.text();
    if (text.length > 12_000_000) throw new Error();
    return text;
  } catch {
    throw new AppError(
      'YOUTUBE_FETCH',
      'YouTube 공개 화면에 연결하지 못했습니다. 잠시 뒤 다시 불러와 주세요.',
      502,
    );
  }
}
export async function searchVideos(
  source: SourceKind = 'latest',
  limit = 20,
): Promise<Video[]> {
  const url = new URL('https://www.youtube.com/results');
  url.searchParams.set('search_query', '연애');
  // Current public search exposes upload-date windows rather than a date-sort control.
  // Filter to today, then sort actual watch-page publication timestamps ourselves.
  url.searchParams.set('sp', 'EgIIAg%3D%3D');
  url.searchParams.set('hl', 'ko');
  const data = extractJson(await publicHtml(url.href), 'ytInitialData');
  let videos = videosFromData(data, source).slice(0, limit * 2);
  if (videos.length < limit * 2) {
    url.searchParams.set('sp', 'EgIIAw%3D%3D');
    const week = videosFromData(
      extractJson(await publicHtml(url.href), 'ytInitialData'),
      source,
    );
    const ids = new Set(videos.map((v) => v.id));
    videos = [...videos, ...week.filter((v) => !ids.has(v.id))].slice(
      0,
      limit * 2,
    );
  }
  if (!videos.length)
    throw new AppError(
      'YOUTUBE_STRUCTURE',
      'YouTube 영상 목록을 읽지 못했습니다. 공개 화면 변경 또는 일시적인 제한일 수 있습니다.',
      502,
    );
  const detailed: Video[] = [];
  for (let i = 0; i < videos.length; i += 5) {
    const batch = await Promise.allSettled(
      videos.slice(i, i + 5).map((v) => videoDetails(v.id, source)),
    );
    for (const item of batch)
      if (item.status === 'fulfilled') detailed.push(item.value.video);
    if (detailed.length >= limit) break;
  }
  if (!detailed.length)
    throw new AppError(
      'YOUTUBE_METADATA',
      '영상의 실제 게시 날짜를 확인하지 못했습니다. 다시 불러와 주세요.',
      502,
    );
  return detailed
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .slice(0, limit);
}
export async function videoDetails(
  id: string,
  source: SourceKind,
): Promise<{ video: Video; description: string }> {
  const html = await publicHtml(
    `https://www.youtube.com/watch?v=${encodeURIComponent(id)}&hl=ko`,
  );
  const player = extractJson(html, 'ytInitialPlayerResponse');
  const d = object(player.videoDetails);
  if (!d.title)
    throw new AppError(
      'VIDEO_UNAVAILABLE',
      '영상을 읽을 수 없습니다. 공개 영상인지 확인해 주세요.',
    );
  const micro = object(object(player.microformat).playerMicroformatRenderer);
  return {
    video: {
      id,
      title: String(d.title),
      channel: String(d.author || ''),
      thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
      publishedAt: String(micro.publishDate || micro.uploadDate || ''),
      viewCount: d.viewCount ? Number(d.viewCount) : null,
      duration: d.lengthSeconds
        ? `${Math.floor(Number(d.lengthSeconds) / 60)}:${String(Number(d.lengthSeconds) % 60).padStart(2, '0')}`
        : '',
      source,
    },
    description: String(d.shortDescription || '').slice(0, 12000),
  };
}
let collector: Browser | undefined;
async function collectorPage(): Promise<Page> {
  if (!collector?.isConnected())
    collector = await chromium.launch({
      executablePath: requireAutomation(await defaultBrowser.resolve()),
      headless: true,
    });
  const context = await collector.newContext({ locale: 'ko-KR' });
  return context.newPage();
}
async function publicTranscript(id: string): Promise<string> {
  try {
    const player = extractJson(
      await publicHtml(`https://www.youtube.com/watch?v=${id}&hl=ko`),
      'ytInitialPlayerResponse',
    );
    const renderer = object(
      object(player.captions).playerCaptionsTracklistRenderer,
    );
    const tracks = Array.isArray(renderer.captionTracks)
      ? renderer.captionTracks.map(object)
      : [];
    const track = tracks.find((t) => t.languageCode === 'ko') || tracks[0];
    if (typeof track?.baseUrl !== 'string') return '';
    const url = new URL(track.baseUrl);
    if (
      url.protocol !== 'https:' ||
      !['www.youtube.com', 'youtube.com'].includes(url.hostname)
    )
      return '';
    url.searchParams.set('fmt', 'json3');
    const res = await fetch(url, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return '';
    const data = object(await res.json());
    if (!Array.isArray(data.events)) return '';
    return data.events
      .map((event) => {
        const e = object(event);
        const text = Array.isArray(e.segs)
          ? e.segs.map((s) => String(object(s).utf8 || '')).join('')
          : '';
        const seconds = Math.floor(Number(e.tStartMs || 0) / 1000);
        return text.trim()
          ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} ${text.trim()}`
          : '';
      })
      .filter(Boolean)
      .join('\n')
      .slice(0, 35000);
  } catch {
    return '';
  }
}
export async function collectContext(video: Video): Promise<VideoContext> {
  const detail = await videoDetails(video.id, video.source);
  const result: VideoContext = {
    title: detail.video.title,
    description: detail.description,
    transcript: '',
    topComments: [],
    transcriptStatus: 'unavailable',
    warnings: [],
  };
  let page: Page | undefined;
  result.transcript = await publicTranscript(video.id);
  if (result.transcript) result.transcriptStatus = 'available';
  try {
    page = await collectorPage();
    await page.goto(`https://www.youtube.com/watch?v=${video.id}&hl=ko`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    await page.locator('#comments').scrollIntoViewIfNeeded({ timeout: 12_000 });
    await page
      .locator('ytd-comment-thread-renderer')
      .first()
      .waitFor({ timeout: 12_000 })
      .catch(() => {});
    // YouTube's default comment order is relevance. Explicitly select it when available.
    const sort = page.locator('#comments yt-sort-filter-sub-menu-renderer');
    if (await sort.count()) {
      await sort.click({ timeout: 3000 }).catch(() => {});
      await page
        .getByText('인기 댓글순', { exact: true })
        .last()
        .click({ timeout: 3000 })
        .catch(() => {});
    }
    result.topComments = (
      await page
        .locator('ytd-comment-thread-renderer #content-text')
        .allTextContents()
    )
      .map((s) => s.trim().slice(0, 600))
      .filter(Boolean)
      .slice(0, 12);
    await page
      .locator(
        '#description-inline-expander #expand, tp-yt-paper-button#expand',
      )
      .first()
      .click({ timeout: 3000 })
      .catch(() => {});
    const transcriptButton = page
      .getByRole('button', {
        name: /스크립트 표시|스크립트 보기|Show transcript/i,
      })
      .first();
    if (!result.transcript && (await transcriptButton.count())) {
      await transcriptButton.click({ timeout: 5000 });
      await page
        .locator(
          'ytd-transcript-segment-renderer, transcript-segment-view-model',
        )
        .first()
        .waitFor({ timeout: 8000 });
      result.transcript = (
        await page
          .locator(
            'ytd-transcript-segment-renderer, transcript-segment-view-model',
          )
          .allTextContents()
      )
        .map((x) => x.replace(/\s+/g, ' ').trim())
        .join('\n')
        .slice(0, 35000);
      if (result.transcript) result.transcriptStatus = 'available';
    }
  } catch {
    if (!result.transcript) result.transcriptStatus = 'failed';
    if (!result.transcript)
      result.warnings.push('자막 수집을 완료하지 못해 제목·설명을 사용합니다.');
  } finally {
    await page
      ?.context()
      .close()
      .catch(() => {});
  }
  if (!result.topComments.length)
    result.warnings.push(
      '인기 댓글을 읽지 못했습니다. 댓글 제한 또는 로딩 상태를 확인해 주세요.',
    );
  if (!result.transcript && result.transcriptStatus === 'unavailable')
    result.warnings.push('공개 스크립트가 없어 제목·설명을 사용합니다.');
  return result;
}
export async function closeCollector() {
  await collector?.close();
}
