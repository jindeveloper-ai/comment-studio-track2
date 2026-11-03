export type SourceKind = 'latest' | 'direct' | 'discovery';
export interface Video {
  id: string;
  title: string;
  channel: string;
  thumbnail: string;
  publishedAt: string;
  viewCount: number | null;
  duration: string;
  source: SourceKind;
}
export interface Evidence {
  source: 'transcript' | 'title' | 'description';
  quote: string;
  timestamp?: string;
}
export interface VideoContext {
  title: string;
  description: string;
  transcript: string;
  topComments: string[];
  transcriptStatus: 'available' | 'unavailable' | 'failed';
  warnings: string[];
}
export interface Draft {
  id: string;
  videoId: string;
  concern: string;
  evidence: Evidence;
  comment: string;
  createdAt: string;
  model: string;
  source: SourceKind;
  validation: string[];
  context: VideoContext;
}
export type JobStatus =
  | 'reserved'
  | 'opening'
  | 'typing'
  | 'submitting'
  | 'verifying'
  | 'success'
  | 'failed'
  | 'uncertain';
export interface PostJob {
  id: string;
  videoId: string;
  videoTitle: string;
  profileId: string;
  comment: string;
  status: JobStatus;
  message: string;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  commentUrl: string | null;
  screenshot: string | null;
  authorChannelId?: string | null;
  deletion?: {
    state: 'deleting' | 'deleted' | 'absent' | 'failed' | 'uncertain';
    message: string;
    updatedAt: string;
    submittedAt: string | null;
  };
}

export function jobLabel(job: PostJob): string {
  if (job.deletion)
    return {
      deleting: '댓글 삭제 중',
      deleted: '댓글 삭제 완료',
      absent: '댓글 없음 확인',
      failed: '댓글 삭제 실패',
      uncertain: '삭제 확인 필요',
    }[job.deletion.state];
  return statusLabels[job.status];
}
export interface Profile {
  id: string;
  name: string;
  ready: boolean;
  channelId: string | null;
  channelName: string | null;
  channelHandle?: string | null;
}
export interface DiscoveryVideo extends Video {
  observedAt: string;
  hourlyGrowth: number | null;
  eligible: boolean;
}
export interface Status {
  browser: DefaultBrowserStatus;
  vertex: { configured: boolean; model: string; state: string };
  profiles: Profile[];
  quota: { used: number; max: number; day: string };
  activeJobs: PostJob[];
  reviewApproved: boolean;
}
export interface DefaultBrowserStatus {
  name: string;
  platform: string;
  automation: boolean;
  checkedAt: string | null;
  message: string;
}
export const statusLabels: Record<JobStatus, string> = {
  reserved: '게시 준비',
  opening: '프로필 여는 중',
  typing: '입력 중',
  submitting: '게시 중',
  verifying: '댓글 확인 중',
  success: '게시 완료',
  failed: '실패',
  uncertain: '확인 필요',
};
