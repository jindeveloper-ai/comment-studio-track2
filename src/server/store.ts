import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type {
  DiscoveryVideo,
  Draft,
  PostJob,
  Profile,
  SourceKind,
  Video,
} from '../shared.js';
import { commentTarget } from './comment-target.js';
import { AppError, koreanDay } from './safety.js';

type Row = Record<string, unknown>;
export class Store {
  readonly db: DatabaseSync;
  constructor(
    path: string,
    readonly dailyMax = 10,
    private now: () => Date = () => new Date(),
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS videos (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, video_id TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, ready INTEGER NOT NULL DEFAULT 0, channel_id TEXT UNIQUE, channel_name TEXT);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, video_id TEXT NOT NULL, status TEXT NOT NULL, quota_day TEXT NOT NULL, submitted_at TEXT, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_post_per_video ON jobs(video_id) WHERE status != 'failed';
      CREATE TABLE IF NOT EXISTS snapshots (video_id TEXT NOT NULL, observed_at TEXT NOT NULL, views INTEGER NOT NULL, PRIMARY KEY(video_id, observed_at));
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const columns = this.db
      .prepare('PRAGMA table_info(profiles)')
      .all() as Row[];
    if (!columns.some((c) => c.name === 'channel_handle'))
      this.db.exec('ALTER TABLE profiles ADD COLUMN channel_handle TEXT');
    for (const id of ['youtube1', 'youtube2', 'youtube3'])
      this.db.prepare('INSERT OR IGNORE INTO profiles(id) VALUES(?)').run(id);
    for (const job of this.activeJobs()) {
      if (job.deletion?.state === 'deleting') {
        this.updateDeletion(
          job.id,
          job.deletion.submittedAt ? 'uncertain' : 'failed',
          '프로그램이 종료되어 삭제 작업이 중단됐습니다. 댓글 보기를 통해 확인해 주세요.',
        );
        continue;
      }
      this.updateJob(job.id, {
        status: job.submittedAt ? 'uncertain' : 'failed',
        message: job.submittedAt
          ? '프로그램이 종료되어 게시 결과 확인이 필요합니다. 재게시하지 마세요.'
          : '프로그램 종료로 게시 전 작업이 취소되었습니다.',
      });
    }
  }
  close() {
    this.db.close();
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  saveVideos(videos: Video[]) {
    const stmt = this.db.prepare(
      'INSERT INTO videos(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
    );
    for (const video of videos) stmt.run(video.id, JSON.stringify(video));
  }
  video(id: string): Video | undefined {
    const row = this.db.prepare('SELECT data FROM videos WHERE id=?').get(id) as
      | Row
      | undefined;
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  saveDraft(draft: Draft) {
    this.db
      .prepare(
        'INSERT INTO drafts(id,video_id,source,created_at,data) VALUES(?,?,?,?,?)',
      )
      .run(
        draft.id,
        draft.videoId,
        draft.source,
        draft.createdAt,
        JSON.stringify(draft),
      );
  }
  draft(id: string): Draft | undefined {
    const row = this.db.prepare('SELECT data FROM drafts WHERE id=?').get(id) as
      | Row
      | undefined;
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  latestDraft(videoId: string, source: SourceKind): Draft | undefined {
    const row = this.db
      .prepare(
        'SELECT data FROM drafts WHERE video_id=? AND source=? ORDER BY created_at DESC LIMIT 1',
      )
      .get(videoId, source) as Row | undefined;
    if (!row) return undefined;
    const d = JSON.parse(String(row.data)) as Draft;
    return this.now().getTime() - Date.parse(d.createdAt) < 24 * 3600_000
      ? d
      : undefined;
  }
  recentComments(): string[] {
    return this.jobs(30).map((x) => x.comment);
  }
  commentUsed(comment: string): boolean {
    const normalize = (s: string) =>
      s.normalize('NFC').replace(/\s+/g, ' ').trim();
    const rows = this.db
      .prepare("SELECT data FROM jobs WHERE status != 'failed'")
      .all() as Row[];
    return rows.some(
      (r) =>
        normalize((JSON.parse(String(r.data)) as PostJob).comment) ===
        normalize(comment),
    );
  }
  claimDraftGeneration(videoId: string) {
    this.transaction(() => {
      const key = `draftRequests.${koreanDay(this.now())}.${videoId}`;
      const used = Number(this.setting(key) || 0);
      if (used >= 5)
        throw new AppError(
          'DRAFT_LIMIT',
          '이 영상의 오늘 초안 요청 상한(5회)에 도달했습니다. 저장된 초안을 사용하거나 다른 영상을 선택해 주세요.',
          429,
        );
      this.setSetting(key, String(used + 1));
    });
  }
  profiles(): Profile[] {
    return (
      this.db.prepare('SELECT * FROM profiles ORDER BY id').all() as Row[]
    ).map((r, i) => ({
      id: String(r.id),
      name: `유튜브${i + 1}`,
      ready: Boolean(r.ready),
      channelId: r.channel_id as string | null,
      channelName: r.channel_name as string | null,
      channelHandle: r.channel_handle as string | null,
    }));
  }
  setProfile(
    id: string,
    ready: boolean,
    channelId: string | null = null,
    channelName: string | null = null,
    channelHandle: string | null = null,
  ) {
    if (!this.profiles().some((x) => x.id === id))
      throw new AppError('PROFILE', '프로필을 찾을 수 없습니다.');
    if (ready && !channelId)
      throw new AppError('PROFILE', 'YouTube 채널을 확인하지 못했습니다.');
    if (
      channelId &&
      this.profiles().some((x) => x.id !== id && x.channelId === channelId)
    )
      throw new AppError(
        'DUPLICATE_ACCOUNT',
        '다른 프로필에 같은 YouTube 채널이 연결되어 있습니다. 다른 Google 계정으로 로그인해 주세요.',
      );
    this.db
      .prepare(
        'UPDATE profiles SET ready=?,channel_id=?,channel_name=?,channel_handle=? WHERE id=?',
      )
      .run(Number(ready), channelId, channelName, channelHandle, id);
  }
  setting(key: string): string | undefined {
    return (
      this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as
        | Row
        | undefined
    )?.value as string | undefined;
  }
  setSetting(key: string, value: string) {
    this.db
      .prepare(
        'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, value);
  }
  quota() {
    const day = koreanDay(this.now());
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM jobs WHERE quota_day=? AND status != 'failed'",
      )
      .get(day) as Row;
    return { used: Number(row.n), max: this.dailyMax, day };
  }
  reserve(
    video: Video,
    draft: Draft,
    comment: string,
    requestedProfile: string,
  ): PostJob {
    return this.transaction(() => {
      if (draft.source === 'discovery' || video.source === 'discovery')
        throw new AppError(
          'DRAFT_ONLY',
          '유망 영상 탐색은 초안 생성까지만 가능합니다.',
        );
      if (
        this.db
          .prepare(
            "SELECT id FROM jobs WHERE video_id=? AND status != 'failed'",
          )
          .get(video.id)
      )
        throw new AppError(
          'DUPLICATE',
          '이 영상은 이미 게시했거나 게시 결과를 확인 중입니다.',
          409,
        );
      if (this.activeJobs().length)
        throw new AppError(
          'BUSY',
          '진행 중인 게시가 끝난 뒤 다시 시도해 주세요.',
          409,
        );
      if (this.quota().used >= this.dailyMax)
        throw new AppError(
          'DAILY_LIMIT',
          '오늘 게시 상한에 도달했습니다.',
          409,
        );
      if (this.commentUsed(comment))
        throw new AppError(
          'DUPLICATE_COMMENT',
          '다른 영상에 이미 사용한 댓글입니다. 영상에 맞는 새 초안을 준비해 주세요.',
          409,
        );
      const ready = this.profiles().filter((x) => x.ready);
      if (!ready.length)
        throw new AppError(
          'LOGIN_REQUIRED',
          '먼저 유튜브1 프로필을 열어 로그인하고 연결을 확인해 주세요.',
        );
      const last = this.setting('lastProfile');
      const profile =
        requestedProfile === 'auto'
          ? ready[(ready.findIndex((x) => x.id === last) + 1) % ready.length]
          : ready.find((x) => x.id === requestedProfile);
      if (!profile)
        throw new AppError(
          'LOGIN_REQUIRED',
          '선택한 프로필의 로그인을 먼저 확인해 주세요.',
        );
      const at = this.now().toISOString();
      const job: PostJob = {
        id: randomUUID(),
        videoId: video.id,
        videoTitle: video.title,
        profileId: profile.id,
        comment,
        status: 'reserved',
        message: '게시 조건을 확인했습니다.',
        createdAt: at,
        updatedAt: at,
        submittedAt: null,
        commentUrl: null,
        screenshot: null,
        authorChannelId: profile.channelId,
      };
      this.db
        .prepare(
          'INSERT INTO jobs(id,video_id,status,quota_day,submitted_at,data) VALUES(?,?,?,?,?,?)',
        )
        .run(
          job.id,
          job.videoId,
          job.status,
          koreanDay(this.now()),
          null,
          JSON.stringify(job),
        );
      this.setSetting('lastProfile', profile.id);
      return job;
    });
  }
  markSubmitting(id: string): PostJob {
    return this.transaction(() => {
      const job = this.job(id);
      if (!job) throw new AppError('JOB', '작업을 찾을 수 없습니다.');
      const row = this.db
        .prepare('SELECT quota_day FROM jobs WHERE id=?')
        .get(id) as Row;
      const day = koreanDay(this.now());
      if (row.quota_day !== day && this.quota().used >= this.dailyMax)
        throw new AppError(
          'DAILY_LIMIT',
          '날짜 변경 후 게시 상한에 도달했습니다.',
        );
      this.db.prepare('UPDATE jobs SET quota_day=? WHERE id=?').run(day, id);
      return this.updateJob(id, {
        status: 'submitting',
        submittedAt: this.now().toISOString(),
        message: '댓글을 게시하고 있습니다.',
      });
    });
  }
  updateJob(id: string, patch: Partial<PostJob>): PostJob {
    const old = this.job(id);
    if (!old) throw new AppError('JOB', '작업을 찾을 수 없습니다.');
    const job = { ...old, ...patch, updatedAt: this.now().toISOString() };
    this.db
      .prepare('UPDATE jobs SET status=?,submitted_at=?,data=? WHERE id=?')
      .run(job.status, job.submittedAt, JSON.stringify(job), id);
    return job;
  }
  beginDeletion(id: string): PostJob {
    return this.transaction(() => {
      const job = this.job(id);
      if (!job) throw new AppError('JOB', '기록을 찾을 수 없습니다.', 404);
      if (job.status !== 'success')
        throw new AppError(
          'DELETE_STATE',
          '게시가 확인된 댓글만 삭제할 수 있습니다. 먼저 게시 결과를 재확인해 주세요.',
          409,
        );
      if (job.deletion && job.deletion.state !== 'failed')
        throw new AppError(
          'DELETE_STATE',
          '이미 삭제했거나 삭제 결과 확인이 필요한 댓글입니다. 자동으로 다시 삭제하지 않습니다.',
          409,
        );
      if (this.activeJobs().length)
        throw new AppError(
          'BUSY',
          '진행 중인 게시 또는 삭제가 끝난 뒤 다시 시도해 주세요.',
          409,
        );
      commentTarget(job);
      return this.updateJob(id, {
        deletion: {
          state: 'deleting',
          message: '작성 계정과 삭제할 댓글을 확인하고 있습니다.',
          updatedAt: this.now().toISOString(),
          submittedAt: null,
        },
      });
    });
  }
  markDeleting(id: string) {
    const job = this.job(id);
    if (job?.deletion?.state !== 'deleting')
      throw new AppError(
        'DELETE_STATE',
        '삭제 준비 상태를 확인할 수 없습니다.',
        409,
      );
    return this.updateJob(id, {
      deletion: { ...job.deletion, submittedAt: this.now().toISOString() },
    });
  }
  updateDeletion(
    id: string,
    state: NonNullable<PostJob['deletion']>['state'],
    message: string,
  ) {
    const job = this.job(id);
    if (!job?.deletion)
      throw new AppError('DELETE_STATE', '삭제 작업을 찾을 수 없습니다.', 409);
    return this.updateJob(id, {
      deletion: {
        ...job.deletion,
        state,
        message,
        updatedAt: this.now().toISOString(),
      },
    });
  }
  job(id: string): PostJob | undefined {
    const row = this.db.prepare('SELECT data FROM jobs WHERE id=?').get(id) as
      | Row
      | undefined;
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  jobs(limit = 100): PostJob[] {
    return (
      this.db
        .prepare('SELECT data FROM jobs ORDER BY rowid DESC LIMIT ?')
        .all(limit) as Row[]
    ).map((r) => JSON.parse(String(r.data)));
  }
  activeJobs(): PostJob[] {
    return (
      this.db
        .prepare(
          "SELECT data FROM jobs WHERE status IN ('reserved','opening','typing','submitting','verifying') OR json_extract(data,'$.deletion.state') = 'deleting'",
        )
        .all() as Row[]
    ).map((r) => JSON.parse(String(r.data)));
  }
  blockedVideos(): string[] {
    return (
      this.db
        .prepare("SELECT DISTINCT video_id FROM jobs WHERE status != 'failed'")
        .all() as Row[]
    ).map((r) => String(r.video_id));
  }
  observe(videoId: string, views: number) {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO snapshots(video_id,observed_at,views) VALUES(?,?,?)',
      )
      .run(videoId, this.now().toISOString(), views);
  }
  discovery(video: Video): DiscoveryVideo {
    const at = this.now();
    const old = this.db
      .prepare(
        'SELECT observed_at,views FROM snapshots WHERE video_id=? AND observed_at<=? AND observed_at>=? ORDER BY observed_at DESC LIMIT 1',
      )
      .get(
        video.id,
        new Date(at.getTime() - 3600_000).toISOString(),
        new Date(at.getTime() - 7200_000).toISOString(),
      ) as Row | undefined;
    const hours = old
      ? (at.getTime() - Date.parse(String(old.observed_at))) / 3600_000
      : 0;
    const growth =
      old && video.viewCount !== null
        ? Math.floor((video.viewCount - Number(old.views)) / hours)
        : null;
    return {
      ...video,
      source: 'discovery',
      observedAt: at.toISOString(),
      hourlyGrowth: growth,
      eligible:
        video.viewCount !== null &&
        video.viewCount >= 1000 &&
        video.viewCount <= 5000 &&
        growth !== null &&
        growth >= 150,
    };
  }
}
