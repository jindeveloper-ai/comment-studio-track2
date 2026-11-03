import type { Evidence, VideoContext } from '../shared.js';

export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function safeError(error: unknown): string {
  if (error instanceof AppError) return error.message;
  return '작업을 완료하지 못했습니다. 연결 상태와 설정을 확인해 주세요.';
}
export function parseVideoId(input: string): string {
  if (/^[\w-]{11}$/.test(input)) return input;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new AppError(
      'INVALID_URL',
      '올바른 YouTube 영상 링크를 입력해 주세요.',
    );
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port)
    throw new AppError(
      'INVALID_URL',
      'https YouTube 영상 링크만 사용할 수 있습니다.',
    );
  const host = url.hostname.toLowerCase();
  let id: string | null = null;
  if (host === 'youtu.be') id = url.pathname.split('/')[1];
  else if (['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(host)) {
    id =
      url.pathname === '/watch'
        ? url.searchParams.get('v')
        : /^\/(shorts|live|embed)\//.test(url.pathname)
          ? url.pathname.split('/')[2]
          : null;
  }
  if (!id || !/^[\w-]{11}$/.test(id))
    throw new AppError(
      'INVALID_URL',
      'YouTube 영상 링크만 사용할 수 있습니다.',
    );
  return id;
}
export function charCount(text: string): number {
  return [
    ...new Intl.Segmenter('ko', { granularity: 'grapheme' }).segment(
      text.normalize('NFC'),
    ),
  ].length;
}
const segmenter = new Intl.Segmenter('ko', { granularity: 'word' });
export function validateComment(
  comment: string,
  evidence?: Evidence,
  context?: VideoContext,
): string[] {
  const errors: string[] = [];
  const n = charCount(comment);
  if (n < 40 || n > 120)
    errors.push('댓글은 공백 포함 40~120자로 작성해 주세요.');
  if (!comment.includes('운명원'))
    errors.push('운명원에 대한 자연스러운 관심을 포함해 주세요.');
  if (
    /(?:https?:\/\/|www\.|youtu\.be|youtube\.com|[\w-]+\.(?:com|kr|net|org)\b)/i.test(
      comment,
    )
  )
    errors.push('댓글에 링크를 넣을 수 없습니다.');
  if (/[#＃]/u.test(comment))
    errors.push('댓글에 해시태그를 넣을 수 없습니다.');
  if (
    /(?:운명원[\s\S]{0,25}(?:봤(?:는데|어요|더니)|보니|이용했|다녀|상담받|상담을?\s*받|맞혔|정확했|추천받아)|(?:봤(?:는데|어요)|다녀왔|상담받았)[\s\S]{0,15}운명원)/u.test(
      comment,
    )
  )
    errors.push('운명원을 직접 이용한 것처럼 쓴 후기는 사용할 수 없습니다.');
  if (
    /\b(?:api[_ -]?key|private[_ -]?key|bearer)\b|-----BEGIN|AIza[\w-]{20,}/i.test(
      comment,
    )
  )
    errors.push('비밀 값으로 의심되는 내용을 포함할 수 없습니다.');
  if (evidence && context) {
    const source = context[evidence.source];
    const normalize = (s: string) =>
      s.normalize('NFC').replace(/\s+/g, ' ').trim();
    if (
      !evidence.quote ||
      !normalize(source).includes(normalize(evidence.quote))
    )
      errors.push('근거 문구가 실제 수집한 영상 자료와 일치하지 않습니다.');
    const words = [...segmenter.segment(evidence.quote)]
      .filter((x) => x.isWordLike && x.segment.length >= 2)
      .map((x) => x.segment);
    if (!words.some((word) => comment.includes(word)))
      errors.push('댓글에 영상 근거의 구체적인 표현을 반영해 주세요.');
  }
  return [...new Set(errors)];
}
export function koreanDay(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}
