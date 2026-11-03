import { type Draft, jobLabel, type Status } from '../shared';

export function postingBlockReason(input: {
  status: Status | null;
  draft: Draft | null;
  selectedVideoId?: string;
  profileId: string;
  blocked: string[];
  validation: string[];
  length: number;
  generating: boolean;
}): string | null {
  const { status, draft } = input;
  if (!status) return '서버 연결 상태를 확인하고 있습니다.';
  if (input.selectedVideoId && input.blocked.includes(input.selectedVideoId))
    return '이미 게시한 영상입니다. 전체 계정을 합쳐 영상당 댓글 1개만 허용하므로, 계정 변경·초안 재생성·댓글 삭제 후에도 이 영상에는 다시 게시할 수 없습니다. 다른 영상을 선택해 주세요.';
  if (status.activeJobs.length)
    return `${jobLabel(status.activeJobs[0])} 작업이 끝날 때까지 기다려 주세요.`;
  if (input.generating) return '영상의 맥락과 새 초안을 준비하고 있습니다.';
  if (!draft) return '영상을 선택해 댓글 초안을 먼저 준비해 주세요.';
  if (draft.source === 'discovery')
    return '유망 영상은 초안 전용이므로 게시할 수 없습니다.';
  if (!status.browser.automation)
    return '기본 브라우저의 게시 자동화 연결을 확인해 주세요.';
  const ready = status.profiles.filter((p) => p.ready);
  if (
    !ready.length ||
    (input.profileId !== 'auto' && !ready.some((p) => p.id === input.profileId))
  )
    return '선택한 게시 프로필의 YouTube 채널 연결을 먼저 확인해 주세요.';
  if (status.quota.used >= status.quota.max)
    return '전체 계정 합산 오늘의 게시 상한에 도달했습니다.';
  if (input.validation.length) return input.validation.join(' ');
  if (input.length < 40 || input.length > 120)
    return '댓글을 공백 포함 40~120자로 작성해 주세요.';
  return null;
}
