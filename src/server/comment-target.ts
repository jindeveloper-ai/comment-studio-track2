import type { PostJob } from '../shared.js';
import { AppError } from './safety.js';

export function commentTarget(job: PostJob) {
  try {
    const url = new URL(job.commentUrl || '');
    const commentId = url.searchParams.get('lc') || '';
    if (
      url.protocol !== 'https:' ||
      !['www.youtube.com', 'youtube.com'].includes(url.hostname) ||
      url.port ||
      url.username ||
      url.password ||
      url.pathname !== '/watch' ||
      url.searchParams.get('v') !== job.videoId ||
      !/^[\w-]{11}$/.test(job.videoId) ||
      !/^[\w-]{8,200}$/.test(commentId)
    )
      throw new Error();
    const target = new URL('https://www.youtube.com/watch');
    target.searchParams.set('v', job.videoId);
    target.searchParams.set('lc', commentId);
    target.searchParams.set('hl', 'ko');
    return { url: target.href, commentId };
  } catch {
    throw new AppError(
      'COMMENT_TARGET',
      '정확한 댓글 링크를 확인할 수 없어 삭제를 중단했습니다. 댓글 보기를 통해 직접 확인해 주세요.',
      409,
    );
  }
}
