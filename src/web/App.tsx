import {
  ArrowDown,
  ArrowRight,
  Check,
  CheckCheck,
  ChevronRight,
  CircleHelp,
  ExternalLink,
  Film,
  History,
  Link2,
  LoaderCircle,
  MessageSquare,
  Moon,
  Play,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  TrendingUp,
  TriangleAlert,
  Users,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DefaultBrowserStatus,
  DiscoveryVideo,
  Draft,
  PostJob,
  Status,
  Video,
} from '../shared';
import { jobLabel, statusLabels } from '../shared';
import { postingBlockReason } from './post-availability';

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(
    `/api${path}`,
    body === undefined
      ? { signal: AbortSignal.timeout(120000) }
      : {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Studio-Request': 'local',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120000),
        },
  );
  const data = await response.json();
  if (!response.ok)
    throw Object.assign(
      new Error(data.error || '요청을 완료하지 못했습니다.'),
      { code: data.code },
    );
  return data as T;
}
const count = (text: string) =>
  [
    ...new Intl.Segmenter('ko', { granularity: 'grapheme' }).segment(
      text.normalize('NFC'),
    ),
  ].length;
const number = (n: number | null) =>
  n === null ? '조회수 확인 중' : `조회수 ${n.toLocaleString('ko-KR')}회`;
const time = (s: string) =>
  new Intl.DateTimeFormat('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Seoul',
  }).format(new Date(s));
const publishDate = (s: string) =>
  /^\d{4}-/.test(s) && !Number.isNaN(Date.parse(s))
    ? new Intl.DateTimeFormat('ko-KR', {
        month: 'long',
        day: 'numeric',
        timeZone: 'Asia/Seoul',
      }).format(new Date(s))
    : s;
const sourceLabels = {
  transcript: '영상 자막',
  title: '영상 제목',
  description: '영상 설명',
};
function Spinner() {
  return <LoaderCircle size={15} className="spin" aria-hidden="true" />;
}

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [videos, setVideos] = useState<Video[]>([]);
  const [discoveries, setDiscoveries] = useState<DiscoveryVideo[]>([]);
  const [blocked, setBlocked] = useState<string[]>([]);
  const [selected, setSelected] = useState<Video | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [comment, setComment] = useState('');
  const [profile, setProfile] = useState('auto');
  const [jobs, setJobs] = useState<PostJob[]>([]);
  const [tab, setTab] = useState<'studio' | 'discovery' | 'history'>('studio');
  const [panel, setPanel] = useState<'settings' | 'guide' | null>(null);
  const [loading, setLoading] = useState('');
  const [generating, setGenerating] = useState(false);
  const [input, setInput] = useState('');
  const [filter, setFilter] = useState('');
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(
    null,
  );
  const [validation, setValidation] = useState<string[]>([]);
  const [profileBusy, setProfileBusy] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<PostJob | null>(null);
  const [deletingId, setDeletingId] = useState('');
  const [nextDraftNotice, setNextDraftNotice] = useState('');
  const deleteDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (deleteTarget) deleteDialog.current?.showModal();
    else deleteDialog.current?.close();
  }, [deleteTarget]);
  const [profileFeedback, setProfileFeedback] = useState<
    Record<string, { text: string; error: boolean; code?: string }>
  >({});
  const [channelRequired, setChannelRequired] = useState<
    Record<string, boolean>
  >({});
  const sequence = useRef(0);
  const notify = useCallback(
    (text: string, error = false) => setToast({ text, error }),
    [],
  );
  const refreshJobs = useCallback(async () => {
    const records = await api<PostJob[]>('/jobs');
    setJobs(records);
    setBlocked(
      records.filter((j) => j.status !== 'failed').map((j) => j.videoId),
    );
  }, []);
  const loadVideos = useCallback(async () => {
    setLoading('videos');
    try {
      const data = await api<{ videos: Video[]; blockedIds: string[] }>(
        '/videos',
      );
      setVideos(data.videos);
      setBlocked(data.blockedIds);
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setLoading('');
    }
  }, [notify]);
  useEffect(() => {
    void loadVideos();
    void refreshJobs();
    const events = new EventSource('/api/events');
    events.onmessage = (e) => {
      setStatus(JSON.parse(e.data));
      void refreshJobs();
    };
    events.onerror = () => {
      /* EventSource reconnects automatically. */
    };
    return () => events.close();
  }, [loadVideos, refreshJobs]);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(null), 9000);
      return () => clearTimeout(t);
    }
  }, [toast]);
  useEffect(() => {
    if (!draft) {
      setValidation([]);
      return;
    }
    let current = true;
    const t = setTimeout(() => {
      void api<{ errors: string[] }>('/drafts/validate', {
        draftId: draft.id,
        comment,
      })
        .then((x) => {
          if (current) setValidation(x.errors);
        })
        .catch(() => {
          if (current) setValidation(['검증 서버에 연결하지 못했습니다.']);
        });
    }, 250);
    return () => {
      current = false;
      clearTimeout(t);
    };
  }, [comment, draft]);
  async function selectVideo(video: Video, regenerate = false) {
    setNextDraftNotice('');
    const seq = ++sequence.current;
    setSelected(video);
    setDraft(null);
    setComment('');
    setValidation([]);
    setGenerating(true);
    setTab('studio');
    try {
      const data = await api<Draft>('/drafts', {
        videoId: video.id,
        regenerate,
      });
      if (seq === sequence.current) {
        setDraft(data);
        setComment(data.comment);
        setValidation(data.validation);
      }
    } catch (e) {
      if (seq === sequence.current) notify((e as Error).message, true);
    } finally {
      if (seq === sequence.current) setGenerating(false);
    }
  }
  async function importVideo() {
    if (!input.trim()) return;
    setLoading('import');
    try {
      const video = await api<Video>('/videos/import', { url: input.trim() });
      setVideos((old) => [video, ...old.filter((v) => v.id !== video.id)]);
      setInput('');
      void selectVideo(video);
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setLoading('');
    }
  }
  async function post() {
    if (!draft) return;
    setLoading('post');
    try {
      await api<PostJob>('/posts', {
        draftId: draft.id,
        comment,
        profileId: profile,
      });
      await refreshJobs();
      notify(
        '기본 브라우저의 전용 창에서 게시를 시작합니다. 진행 상태를 확인해 주세요.',
      );
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setLoading('');
    }
  }
  async function profileAction(id: string, action: 'open' | 'check' | 'fresh') {
    setProfileBusy(`${id}-${action}`);
    const feedback = (text: string, error = false, code?: string) =>
      setProfileFeedback((previous) => ({
        ...previous,
        [id]: { text, error, code },
      }));
    feedback(
      action === 'check'
        ? '전용 로그인 창을 확인하고 YouTube 채널에 연결하고 있습니다…'
        : '기본 브라우저에서 전용 로그인 창을 표시하고 있습니다…',
    );
    try {
      const result = await api<{ browser?: DefaultBrowserStatus }>(
        `/profiles/${id}/${action === 'fresh' ? 'open' : action}`,
        action === 'fresh' ? { fresh: true } : {},
      );
      setStatus(await api<Status>('/status'));
      if (action === 'check')
        setChannelRequired((previous) => ({ ...previous, [id]: false }));
      const message =
        action === 'fresh'
          ? '기존 전용 프로필을 보존하고 새 로그인 창을 열었습니다. 이 새 창에서 직접 로그인해 주세요.'
          : action === 'open'
            ? result.browser?.automation
              ? `${result.browser.name} 전용 채널 선택 창을 열거나 다시 표시했습니다. 댓글을 작성할 채널을 준비한 뒤 로그인 완료 · 연결을 눌러 주세요.`
              : '기본 브라우저에서 YouTube를 열었습니다. 이 브라우저의 게시 자동화 연결은 지원하지 않습니다.'
            : 'YouTube 채널 연결을 완료했습니다.';
      feedback(message);
      notify(message);
    } catch (e) {
      const error = e as Error & { code?: string };
      if (error.code === 'YOUTUBE_CHANNEL_REQUIRED') {
        setChannelRequired((previous) => ({ ...previous, [id]: true }));
        setStatus((previous) =>
          previous
            ? {
                ...previous,
                profiles: previous.profiles.map((p) =>
                  p.id === id ? { ...p, ready: false } : p,
                ),
              }
            : previous,
        );
        setPanel('settings');
      }
      const message = ['TimeoutError', 'AbortError'].includes(error.name)
        ? '응답 시간이 초과되었습니다. 화면을 새로고침해 연결 상태를 확인한 뒤 다시 시도해 주세요.'
        : error.message;
      feedback(message, true, error.code);
      notify(message, true);
    } finally {
      setProfileBusy('');
    }
  }
  async function refreshBrowser() {
    setProfileBusy('browser');
    try {
      const result = await api<DefaultBrowserStatus>('/browser/refresh', {});
      setStatus(await api<Status>('/status'));
      notify(`${result.name} · ${result.message}`);
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setProfileBusy('');
    }
  }
  async function discover() {
    setLoading('discovery');
    try {
      const data = await api<{ videos: DiscoveryVideo[]; message: string }>(
        '/discovery',
        {},
      );
      setDiscoveries(data.videos);
      notify(data.message);
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setLoading('');
    }
  }
  const selectedJob = jobs.find((j) => j.videoId === selected?.id);
  const active = status?.activeJobs[0];
  const readyProfiles = status?.profiles.filter((p) => p.ready) || [];
  const chars = count(comment);
  const postBlockReason = postingBlockReason({
    status,
    draft,
    selectedVideoId: selected?.id,
    profileId: profile,
    blocked,
    validation,
    length: chars,
    generating,
  });
  const canPost = !postBlockReason;
  function prepareNextComment() {
    const previous = selectedJob?.profileId || profile;
    const next = readyProfiles.find((p) => p.id !== previous);
    setProfile(next?.id || 'auto');
    sequence.current++;
    setSelected(null);
    setDraft(null);
    setComment('');
    setValidation([]);
    setGenerating(false);
    setNextDraftNotice(
      `초안을 되돌렸습니다. 다른 영상을 선택해 다른 댓글을 준비해 주세요. ${next ? `게시 프로필은 ${next.name}로 변경했습니다. 게시 전에 계정을 확인해 주세요.` : '다른 계정으로 게시하려면 프로필을 연결하고 선택해 주세요.'} 이미 게시한 영상에는 다시 게시할 수 없습니다.`,
    );
  }
  async function deleteComment(job: PostJob) {
    setDeleteTarget(null);
    setDeletingId(job.id);
    try {
      const result = await api<PostJob>(`/jobs/${job.id}/delete`, {
        confirmed: true,
      });
      await refreshJobs();
      notify(
        result.deletion?.message || '삭제 상태를 확인해 주세요.',
        result.deletion?.state !== 'deleted',
      );
    } catch (error) {
      notify((error as Error).message, true);
      await refreshJobs().catch(() => {});
    } finally {
      setDeletingId('');
    }
  }
  function deleteButton(job: PostJob) {
    return job.status === 'success' &&
      (!job.deletion || job.deletion.state === 'failed') ? (
      <button
        type="button"
        className="text-button delete-comment-button"
        disabled={!!deletingId || !!active}
        onClick={() => setDeleteTarget(job)}
      >
        <Trash2 size={14} /> 댓글 삭제
      </button>
    ) : null;
  }
  function verifyDeletionButton(job: PostJob) {
    return job.deletion &&
      ['failed', 'uncertain'].includes(job.deletion.state) ? (
      <button
        type="button"
        className="text-button"
        disabled={!!active || !!deletingId}
        onClick={() => {
          setDeletingId(job.id);
          void api<PostJob>(`/jobs/${job.id}/verify-deletion`, {})
            .then((result) =>
              notify(result.deletion?.message || '삭제 결과를 확인했습니다.'),
            )
            .catch((e) => notify(e.message, true))
            .finally(() => {
              setDeletingId('');
              void refreshJobs();
            });
        }}
      >
        <RefreshCw size={14} /> 삭제 여부 확인
      </button>
    ) : null;
  }
  const shownVideos = videos.filter((v) =>
    `${v.title} ${v.channel}`.toLowerCase().includes(filter.toLowerCase()),
  );

  function jobTable(records: PostJob[]) {
    return records.length ? (
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>시간</th>
              <th>영상 / 게시한 댓글</th>
              <th>프로필</th>
              <th>상태</th>
              <th>확인</th>
            </tr>
          </thead>
          <tbody>
            {records.map((job) => (
              <tr key={job.id}>
                <td className="nowrap muted">{time(job.createdAt)}</td>
                <td>
                  <p className="record-title">{job.videoTitle}</p>
                  <p className="record-comment">{job.comment}</p>
                  {(job.deletion ||
                    ['failed', 'uncertain'].includes(job.status)) && (
                    <p className="error-text">
                      {job.deletion?.message || job.message}
                    </p>
                  )}
                </td>
                <td className="nowrap">유튜브{job.profileId.slice(-1)}</td>
                <td>
                  <span
                    className={`badge ${job.deletion ? `deletion-${job.deletion.state}` : job.status}`}
                  >
                    {jobLabel(job)}
                  </span>
                </td>
                <td>
                  <div className="record-actions">
                    {job.commentUrl && (
                      <a
                        href={job.commentUrl}
                        target="_blank"
                        rel="noreferrer"
                        aria-label="댓글 보기"
                      >
                        <ExternalLink size={15} />
                      </a>
                    )}
                    {job.screenshot && (
                      <a
                        href={`/api/screenshots/${job.screenshot}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        캡처
                      </a>
                    )}
                    {job.status === 'uncertain' && (
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => {
                          void api(`/jobs/${job.id}/verify`, {})
                            .then(refreshJobs)
                            .catch((e) => notify(e.message, true));
                        }}
                      >
                        재확인
                      </button>
                    )}
                    {deleteButton(job)}
                    {verifyDeletionButton(job)}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : (
      <div className="empty-history">
        <History size={23} />
        <span>아직 게시 기록이 없어요.</span>
        <small>게시한 영상과 댓글, 결과가 시간순으로 쌓입니다.</small>
      </div>
    );
  }
  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="운명원 Comment Studio">
          <span className="brand-icon">
            <Moon size={23} strokeWidth={1.5} />
            <i />
          </span>
          <span className="brand-name">
            운명원<span>COMMENT STUDIO</span>
          </span>
        </a>
        <nav aria-label="주 메뉴">
          <button
            type="button"
            className={tab === 'studio' ? 'active' : ''}
            onClick={() => setTab('studio')}
          >
            작업실
          </button>
          <button
            type="button"
            className={tab === 'discovery' ? 'active' : ''}
            onClick={() => setTab('discovery')}
          >
            유망 영상 <span className="tiny">BETA</span>
          </button>
          <button
            type="button"
            className={tab === 'history' ? 'active' : ''}
            onClick={() => setTab('history')}
          >
            운영 기록
          </button>
        </nav>
        <div className="top-actions">
          <span className="local-label">
            <i /> LOCAL WORKSPACE
          </span>
          <button
            type="button"
            className="icon-button"
            aria-label="사용 가이드"
            onClick={() => setPanel('guide')}
          >
            <CircleHelp size={19} />
          </button>
          <button
            type="button"
            className="outline-button settings-trigger"
            onClick={() => setPanel('settings')}
          >
            <Settings2 size={15} /> 프로필 설정
          </button>
        </div>
      </header>
      <main>
        <section className="page-heading">
          <div>
            <div className="eyebrow">
              <span /> CONTEXT BEFORE COMMENTS
            </div>
            <h1>
              {tab === 'history' ? (
                '모든 게시에는, 기록이 남도록.'
              ) : tab === 'discovery' ? (
                '다음 이야기가 시작되는 곳.'
              ) : (
                <>
                  영상의 맥락을, <em>댓글의 이유로.</em>
                </>
              )}
            </h1>
            <p>
              {tab === 'history'
                ? '어느 영상에, 어떤 계정으로, 무슨 댓글을 남겼는지 확인하세요.'
                : tab === 'discovery'
                  ? '작은 조회수 속 빠른 움직임을 찾아보세요. 이곳에서는 초안만 만듭니다.'
                  : '영상을 고르고, 공감할 이야기를 준비하고, 게시 결과까지 확인하세요.'}
            </p>
          </div>
          <div className="quota-card">
            <span>오늘의 게시</span>
            <div>
              <strong>{status?.quota.used ?? 0}</strong>
              <span> / {status?.quota.max ?? 10}</span>
              <span className="quota-unit">개</span>
            </div>
            <div className="quota-track">
              <i
                style={{
                  width: `${Math.min(100, ((status?.quota.used || 0) / (status?.quota.max || 10)) * 100)}%`,
                }}
              />
            </div>
            <small>전체 프로필 합산 · 한국시간 기준</small>
          </div>
        </section>
        <div className="workspace-meta">
          <span>
            <span
              className={`status-dot ${status?.vertex.configured ? 'green' : ''}`}
            />{' '}
            AI {status?.vertex.state || '연결 확인 중'}
            <span className="meta-divider" /> <Users size={13} /> 프로필{' '}
            {readyProfiles.length}/3 연결
          </span>
          <span>
            <ShieldCheck size={13} /> 영상당 1개 · 하루{' '}
            {status?.quota.max ?? 10}개 · 검수 단계
          </span>
        </div>
        {tab === 'studio' && (
          <section className="studio-grid" aria-label="댓글 작성 작업실">
            <article className="work-panel video-panel">
              <div className="panel-head">
                <div className="step-label">
                  <span>01</span>
                  <h2>영상 불러오기</h2>
                </div>
                <span className="small-tag">DISCOVER</span>
              </div>
              <div className="panel-intro">
                이야기를 시작할 영상을 찾아보세요.
              </div>
              <div className="video-controls">
                <button
                  type="button"
                  className="primary-button load-button"
                  disabled={!!loading}
                  onClick={() => void loadVideos()}
                >
                  {loading === 'videos' ? <Spinner /> : <RefreshCw size={15} />}{' '}
                  영상 불러오기 <span>최신순</span>
                </button>
                <form
                  className="link-input"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void importVideo();
                  }}
                >
                  <Link2 size={15} />
                  <input
                    aria-label="YouTube 영상 링크"
                    placeholder="또는 YouTube 링크 붙여넣기"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                  />
                  <button
                    type="submit"
                    aria-label="링크 영상 불러오기"
                    disabled={!!loading || !input.trim()}
                  >
                    {loading === 'import' ? (
                      <Spinner />
                    ) : (
                      <ArrowRight size={16} />
                    )}
                  </button>
                </form>
              </div>
              <div className="list-heading">
                <span>
                  영상 목록 <b>{videos.length}</b>
                </span>
                <label className="filter-input">
                  <Search size={13} />
                  <input
                    aria-label="영상 목록 검색"
                    placeholder="목록 검색"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  />
                </label>
              </div>
              <div className="video-list">
                {loading === 'videos' && !videos.length ? (
                  ['one', 'two', 'three', 'four', 'five'].map((id) => (
                    <div className="skeleton-card" key={id}>
                      <div />
                      <span>
                        <i />
                        <i />
                      </span>
                    </div>
                  ))
                ) : shownVideos.length ? (
                  shownVideos.map((video) => (
                    <button
                      type="button"
                      key={video.id}
                      className={`video-card ${selected?.id === video.id ? 'selected' : ''}`}
                      onClick={() => void selectVideo(video)}
                      disabled={generating}
                    >
                      <div className="thumbnail">
                        <img src={video.thumbnail} alt="" loading="lazy" />
                        <span>{video.duration || 'VIDEO'}</span>
                        {selected?.id === video.id && (
                          <i>
                            <Check size={15} />
                          </i>
                        )}
                      </div>
                      <div className="video-copy">
                        <h3>{video.title}</h3>
                        <p>{video.channel}</p>
                        <small>
                          {publishDate(video.publishedAt) || '게시일 확인 필요'}
                          <span>·</span>
                          {number(video.viewCount)}
                        </small>
                        {blocked.includes(video.id) && (
                          <span className="already-posted">게시 기록 있음</span>
                        )}
                      </div>
                    </button>
                  ))
                ) : (
                  <div className="small-empty">
                    <Film size={26} />
                    <p>
                      {filter
                        ? '검색어에 맞는 영상이 없어요.'
                        : '영상 불러오기를 눌러 시작하세요.'}
                    </p>
                  </div>
                )}
              </div>
              <div className="panel-foot">
                <span className="status-dot green" /> YouTube 공개 영상 · ‘연애’
                키워드
              </div>
            </article>
            <article className="work-panel draft-panel">
              <div className="panel-head">
                <div className="step-label">
                  <span>02</span>
                  <h2>맥락 읽고, 초안 만들기</h2>
                </div>
                <Sparkles size={17} className="gold" />
              </div>
              <div className="panel-intro">
                영상의 고민에 먼저 귀 기울입니다.
              </div>
              {nextDraftNotice && (
                <div className="posting-block-reason" role="status">
                  {nextDraftNotice}
                </div>
              )}
              {!selected ? (
                <div className="draft-empty">
                  <div className="orbit-art">
                    <span className="orbit" />
                    <Moon size={32} strokeWidth={1} />
                    <i />
                    <b />
                  </div>
                  <span className="eyebrow">A COMMENT THAT BELONGS</span>
                  <h3>
                    좋은 댓글은
                    <br />
                    이해에서 시작되니까.
                  </h3>
                  <p>
                    왼쪽에서 영상을 선택하면
                    <br />
                    고민과 근거를 읽고 댓글을 준비할게요.
                  </p>
                  <div className="empty-hint">
                    <ArrowRight size={13} /> 영상을 선택해 주세요
                  </div>
                </div>
              ) : generating ? (
                <div className="generating-state">
                  <div className="ai-loader">
                    <Sparkles size={27} />
                  </div>
                  <h3>영상의 이야기를 읽고 있어요.</h3>
                  <p>
                    자막·설명·인기 댓글 수집 후<br />
                    맥락에 맞는 초안을 생성합니다.
                  </p>
                  <small>
                    <Spinner /> 실제 자료를 분석 중입니다. 잠시 기다려 주세요.
                  </small>
                </div>
              ) : draft ? (
                <div className="draft-content">
                  <div className="selected-caption">
                    <span className="small-tag">선택한 영상</span>
                    <p>{selected.title}</p>
                  </div>
                  <div className="concern-box">
                    <div className="concern-label">
                      <Sparkles size={13} /> 영상 속 고민 한 줄
                    </div>
                    <h3>{draft.concern}</h3>
                  </div>
                  <div className="evidence-box">
                    <div>
                      <span className="small-tag">맥락의 근거</span>
                      <small>
                        {sourceLabels[draft.evidence.source]}{' '}
                        {draft.evidence.timestamp || ''}
                      </small>
                    </div>
                    <blockquote>“{draft.evidence.quote}”</blockquote>
                  </div>
                  <div className="editor-heading">
                    <label htmlFor="comment-editor">댓글 초안</label>
                    <button
                      type="button"
                      className="text-button draft-regenerate-highlight"
                      onClick={() => void selectVideo(selected, true)}
                    >
                      <RefreshCw size={12} /> 다시 생성
                    </button>
                  </div>
                  <textarea
                    id="comment-editor"
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    maxLength={500}
                  />
                  <div className="editor-footer">
                    <span>직접 다듬을 수 있어요.</span>
                    <span
                      className={chars < 40 || chars > 120 ? 'error-text' : ''}
                    >
                      <b>{chars}</b> / 120자
                    </span>
                  </div>
                  {validation.length ? (
                    <div className="validation-error">
                      {validation.map((e) => (
                        <p key={e}>{e}</p>
                      ))}
                    </div>
                  ) : (
                    <div className="validation-ok">
                      <CheckCheck size={14} /> 길이·브랜드·링크·근거 표현 검사
                      통과
                    </div>
                  )}
                  {draft.context.warnings.map((w) => (
                    <p className="context-warning" key={w}>
                      {w}
                    </p>
                  ))}
                  <div className="source-note">
                    인기 댓글 {draft.context.topComments.length}개 참고 ·{' '}
                    {draft.context.transcriptStatus === 'available'
                      ? '자막 사용'
                      : '제목·설명 사용'}
                  </div>
                </div>
              ) : (
                <div className="small-empty">
                  <MessageSquare size={27} />
                  <p>초안을 준비하지 못했어요.</p>
                  <button
                    type="button"
                    className="outline-button"
                    onClick={() => void selectVideo(selected)}
                  >
                    다시 시도
                  </button>
                </div>
              )}
              <div className="panel-foot">
                <ShieldCheck size={13} /> 40~120자 · 링크 / 해시태그 / 허위 후기
                제외
              </div>
            </article>
            <article className="work-panel post-panel">
              <div className="panel-head">
                <div className="step-label">
                  <span>03</span>
                  <h2>댓글 달기</h2>
                </div>
                <span className="small-tag">PUBLISH</span>
              </div>
              <div className="panel-intro">
                기본 브라우저에서 입력부터 확인까지.
              </div>
              <div className="post-content">
                <div className="field-label">
                  게시 프로필{' '}
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setPanel('settings')}
                  >
                    관리 <ChevronRight size={12} />
                  </button>
                </div>
                <div className="profile-select-wrap">
                  <Users size={17} />
                  <select
                    aria-label="게시 프로필"
                    value={profile}
                    onChange={(e) => setProfile(e.target.value)}
                  >
                    <option value="auto">자동 순환 배정</option>
                    {status?.profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                        {p.ready
                          ? ' · 연결됨'
                          : channelRequired[p.id]
                            ? ' · YouTube 채널 없음'
                            : ' · 로그인 필요'}
                      </option>
                    ))}
                  </select>
                </div>
                <p className="field-note">
                  연결된 프로필에 순서대로 배정합니다.
                </p>
                <div className="profile-chips">
                  {status?.profiles.map((p) => (
                    <span key={p.id} className={p.ready ? 'ready' : ''}>
                      <i />
                      {p.name}
                    </span>
                  ))}
                </div>
                <div className="publish-preview">
                  <span className="small-tag">게시 전 확인</span>
                  <ul>
                    <li>
                      <Check size={13} /> 영상당 하나의 계정으로 한 번만
                    </li>
                    <li>
                      <Check size={13} /> 전체 프로필 합산 하루{' '}
                      {status?.quota.max ?? 10}개
                    </li>
                    <li>
                      <Check size={13} /> 게시 후 내 댓글이 보이는지 확인
                    </li>
                  </ul>
                </div>
                {draft?.source === 'discovery' && (
                  <div className="inline-notice">
                    유망 영상은 초안 전용입니다.
                    <br />이 경로에서는 게시할 수 없어요.
                  </div>
                )}
                {!readyProfiles.length && (
                  <button
                    type="button"
                    className="setup-notice"
                    onClick={() => setPanel('settings')}
                  >
                    <Users size={17} />
                    <span>
                      먼저 전용 프로필을 연결해 주세요.
                      <small>
                        기본 브라우저로 로그인 → 직접 로그인 → 로그인 완료 ·
                        연결
                      </small>
                    </span>
                    <ChevronRight size={16} />
                  </button>
                )}
                {postBlockReason && (
                  <div className="posting-block-reason" role="status">
                    <TriangleAlert size={17} />
                    <div>
                      <p>{postBlockReason}</p>
                      {selected && blocked.includes(selected.id) && (
                        <>
                          <p>
                            ‘초안 되돌리기’ 후 다른 영상을 선택해 새 댓글을
                            준비하고, 게시 프로필을 다른 계정으로 변경해 주세요.
                          </p>
                          <button
                            type="button"
                            className="outline-button"
                            onClick={prepareNextComment}
                          >
                            <RefreshCw size={14} /> 초안 되돌리기 · 다른 영상
                            선택
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                )}
                <button
                  type="button"
                  className="publish-button"
                  onClick={() => void post()}
                  disabled={!canPost || loading === 'post'}
                >
                  {loading === 'post' || active ? (
                    <Spinner />
                  ) : (
                    <Play size={15} fill="currentColor" />
                  )}{' '}
                  {active ? jobLabel(active) : '댓글 달기'}
                  <ArrowRight size={16} />
                </button>
                <p className="publish-note">
                  버튼을 누르면 실제 YouTube에 게시됩니다.
                </p>
                <div className="progress-steps">
                  {['프로필 열기', '한 글자씩 입력', '게시 · 확인'].map(
                    (s, i) => (
                      <div
                        key={s}
                        className={
                          selectedJob &&
                          (selectedJob.status === 'success' ||
                            [
                              'opening',
                              'typing',
                              'submitting',
                              'verifying',
                            ].indexOf(selectedJob.status) >= [0, 1, 2][i])
                            ? 'done'
                            : ''
                        }
                      >
                        <span>{i + 1}</span>
                        {s}
                        {i < 2 && <ArrowDown size={12} />}
                      </div>
                    ),
                  )}
                </div>
                {selectedJob && (
                  <div className={`job-result ${selectedJob.status}`}>
                    <span className="badge">{jobLabel(selectedJob)}</span>
                    <p>
                      {selectedJob.deletion?.message || selectedJob.message}
                    </p>
                    {selectedJob.commentUrl && (
                      <a
                        href={selectedJob.commentUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        댓글 보기 <ExternalLink size={12} />
                      </a>
                    )}
                    {deleteButton(selectedJob)}
                    {verifyDeletionButton(selectedJob)}
                  </div>
                )}
              </div>
              <div className="panel-foot">
                <span className="status-dot" /> 기록은 이 컴퓨터에 저장됩니다.
              </div>
            </article>
          </section>
        )}
        {tab === 'discovery' && (
          <section className="discovery-section">
            <div className="section-heading">
              <div>
                <h2>
                  <TrendingUp size={19} /> 뜨기 직전의 영상
                </h2>
                <p>조회수 1,000~5,000회 · 실측 시간당 증가량 150회 이상</p>
              </div>
              <button
                type="button"
                className="primary-button"
                disabled={!!loading}
                onClick={() => void discover()}
              >
                {loading === 'discovery' ? (
                  <Spinner />
                ) : (
                  <RefreshCw size={15} />
                )}{' '}
                조회수 관측하기
              </button>
            </div>
            <div className="discovery-note">
              <ShieldCheck size={17} />
              <p>
                초안 전용 기능입니다. 최초 관측 후 1시간 이상 지난 데이터로
                증가량을 계산하며, 실제 측정 전에는 유망 영상으로 판정하지
                않습니다.
              </p>
            </div>
            {discoveries.length ? (
              <div className="discovery-grid">
                {discoveries.map((v) => (
                  <button
                    type="button"
                    className="discovery-card"
                    key={v.id}
                    onClick={() => void selectVideo(v)}
                  >
                    <div className="discovery-image">
                      <img src={v.thumbnail} alt="" />
                      <span className={`badge ${v.eligible ? 'success' : ''}`}>
                        {v.eligible
                          ? '조건 충족'
                          : v.hourlyGrowth === null
                            ? '측정 중'
                            : '조건 미충족'}
                      </span>
                    </div>
                    <h3>{v.title}</h3>
                    <p>{v.channel}</p>
                    <div>
                      {number(v.viewCount)}
                      <strong>
                        {v.hourlyGrowth === null
                          ? '1시간 후 재관측'
                          : `+${v.hourlyGrowth.toLocaleString()}회/시간`}
                      </strong>
                    </div>
                    <span className="text-button">
                      초안 준비 <ArrowRight size={13} />
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="large-empty">
                <TrendingUp size={34} />
                <h3>조회수의 움직임을 관측해 보세요.</h3>
                <p>현재 조회수를 저장하고, 다음 관측과 비교합니다.</p>
              </div>
            )}
          </section>
        )}
        <section className="history-section">
          <div className="section-heading">
            <div>
              <h2>
                <History size={18} />{' '}
                {tab === 'history' ? '전체 운영 기록' : '최근 게시 기록'}{' '}
                <span className="record-count">{jobs.length}</span>
              </h2>
              <p>
                성공도, 실패도 남깁니다. 확인이 필요한 작업은 자동으로
                재게시하지 않습니다.
              </p>
            </div>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                if (tab === 'history') void refreshJobs();
                else setTab('history');
              }}
            >
              {tab === 'history' ? '새로고침' : '전체 기록'}{' '}
              <ArrowRight size={13} />
            </button>
          </div>
          {jobTable(tab === 'history' ? jobs : jobs.slice(0, 4))}
        </section>
        <footer>
          <span>
            <Moon size={13} /> 운명원 COMMENT STUDIO
          </span>
          <span>맥락을 먼저 읽고, 한 번의 게시를 책임 있게.</span>
          <span>
            LOCAL ONLY <i /> TRACK 02
          </span>
        </footer>
      </main>
      <dialog
        ref={deleteDialog}
        className="delete-confirm-dialog"
        onCancel={() => setDeleteTarget(null)}
        aria-labelledby="delete-comment-title"
      >
        {deleteTarget && (
          <>
            <h2 id="delete-comment-title">YouTube 댓글을 삭제할까요?</h2>
            <p className="delete-warning">삭제한 댓글은 되돌릴 수 없습니다.</p>
            <p>
              <strong>영상</strong> {deleteTarget.videoTitle}
            </p>
            <p>
              <strong>작성 프로필</strong> 유튜브
              {deleteTarget.profileId.slice(-1)}
            </p>
            <blockquote>{deleteTarget.comment}</blockquote>
            <p>
              작성 계정·댓글 ID·본문을 확인한 뒤 YouTube에서 삭제합니다. 게시
              이력과 일일 사용량은 보존되며, 이 영상에는 다시 게시할 수
              없습니다.
            </p>
            <div className="delete-confirm-actions">
              <button
                type="button"
                className="outline-button"
                autoFocus
                onClick={() => setDeleteTarget(null)}
              >
                취소
              </button>
              <button
                type="button"
                className="primary-button confirm-delete-button"
                disabled={!!deletingId || !!active}
                onClick={() => void deleteComment(deleteTarget)}
              >
                <Trash2 size={15} /> 삭제에 동의하고 댓글 삭제
              </button>
            </div>
          </>
        )}
      </dialog>
      {toast && (
        <div className={`toast ${toast.error ? 'error' : ''}`} role="status">
          <span>{toast.text}</span>
          <button
            type="button"
            className="icon-button"
            aria-label="알림 닫기"
            onClick={() => setToast(null)}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {panel && (
        <div className="modal-backdrop">
          <button
            type="button"
            className="modal-dismiss"
            aria-label="패널 닫기"
            onClick={() => setPanel(null)}
          />
          <aside
            className="settings-panel"
            aria-label={panel === 'settings' ? '프로필 설정' : '사용 가이드'}
          >
            <div className="settings-head">
              <span className="eyebrow">WORKSPACE SETTINGS</span>
              <button
                type="button"
                className="icon-button"
                aria-label="설정 닫기"
                onClick={() => setPanel(null)}
              >
                <X size={20} />
              </button>
            </div>
            <h2>
              {panel === 'settings' ? '준비는 여기서.' : '세 단계면 충분해요.'}
            </h2>
            {panel === 'settings' ? (
              <>
                <p className="settings-description">
                  기본 브라우저의 전용 창에 서로 다른 본인 Google 계정을
                  연결하세요. 유튜브1 하나면 필수 경로를 사용할 수 있습니다.
                </p>
                <section
                  className="channel-requirement"
                  aria-labelledby="channel-requirement-title"
                >
                  <TriangleAlert size={25} aria-hidden="true" />
                  <div>
                    <span className="channel-requirement-label">
                      로그인 전 필수 확인
                    </span>
                    <h3 id="channel-requirement-title">
                      로그인할 계정에
                      <br />
                      YouTube 채널이 있어야 합니다
                    </h3>
                    <p>
                      Google 계정만으로는 댓글을 작성할 수 없습니다. 사용할
                      아이디에 YouTube 채널을 먼저 만들거나, 기존 채널을 선택한
                      뒤 연결해 주세요.
                    </p>
                  </div>
                </section>
                <div className="settings-section-title">기본 웹브라우저</div>
                <div className="ai-setting">
                  <ExternalLink size={20} />
                  <div>
                    <strong>{status?.browser.name || '감지 중'}</strong>
                    <small>
                      {status?.browser.automation
                        ? '전용 프로필 게시 연결 가능'
                        : '일반 페이지 열기 가능'}
                    </small>
                  </div>
                  <button
                    type="button"
                    className="text-button"
                    disabled={!!profileBusy}
                    onClick={() => void refreshBrowser()}
                  >
                    {profileBusy === 'browser' ? <Spinner /> : '다시 감지'}
                  </button>
                </div>
                <p className="settings-description">
                  {status?.browser.message} 운영체제에서 기본 브라우저를 바꾼
                  뒤에는 다시 감지를 눌러 주세요.
                </p>
                <button
                  type="button"
                  className="outline-button"
                  onClick={() => {
                    void api('/browser/open-review', {}).catch((e) =>
                      notify(e.message, true),
                    );
                  }}
                >
                  <ExternalLink size={13} /> 검수 페이지를 기본 브라우저로 열기
                </button>
                <p className="settings-description">
                  로그인은 직접 진행한 뒤 로그인 완료 · 연결을 누르세요.
                  {status?.browser.platform === 'win32'
                    ? ' Windows에서는 로그인한 전용 창을 먼저 완전히 종료해 주세요.'
                    : ' 이 앱이 사용하는 전용 창만 정상 종료한 뒤 같은 프로필의 YouTube 계정을 확인합니다.'}
                </p>
                <p className="settings-description">
                  YouTube가 로그인 오류를 표시하면 아래의 새 전용 창으로 다시
                  로그인을 사용하세요. 기존 프로필과 개인 Chrome 데이터는 그대로
                  보존합니다. 같은 계정이 일반 브라우저에서도 실패한다면
                  YouTube의 계정별 로그인 문제인지 확인해야 합니다.
                </p>
                <div className="settings-section-title">
                  전용 프로필 <span>{readyProfiles.length}/3 연결</span>
                </div>
                {status?.profiles.map((p) => (
                  <div
                    className={`profile-setting ${!p.ready && channelRequired[p.id] ? 'channel-missing' : ''}`}
                    key={p.id}
                  >
                    <div className="profile-setting-title">
                      <span className="profile-avatar">{p.id.slice(-1)}</span>
                      <div>
                        <strong>{p.name}</strong>
                        <small>
                          {p.ready
                            ? p.channelName || 'YouTube 채널 연결됨'
                            : channelRequired[p.id]
                              ? 'Google 로그인 완료 · YouTube 채널 없음'
                              : '로그인이 필요합니다'}
                        </small>
                      </div>
                      <span
                        className={`status-dot ${p.ready ? 'green' : ''}`}
                      />
                    </div>
                    {!p.ready && channelRequired[p.id] && (
                      <div
                        className="channel-warning"
                        role="alert"
                        aria-labelledby={`channel-warning-${p.id}`}
                      >
                        <TriangleAlert size={22} aria-hidden="true" />
                        <div>
                          <h3 id={`channel-warning-${p.id}`}>
                            YouTube 채널이 없어 연결할 수 없습니다
                          </h3>
                          <p>
                            Google 로그인은 완료됐지만 이 계정에 댓글을 작성할
                            채널이 없습니다. 채널을 준비한 뒤 다시 연결해
                            주세요.
                          </p>
                          <ol>
                            <li>
                              아래 ‘기본 브라우저로 로그인’으로 전용 창 열기
                            </li>
                            <li>
                              YouTube 프로필 메뉴에서 채널 만들기 또는 기존 채널
                              선택
                            </li>
                            <li>‘로그인 완료 · 연결’을 눌러 다시 확인</li>
                          </ol>
                        </div>
                      </div>
                    )}
                    <div className="profile-setting-actions">
                      <button
                        type="button"
                        className="outline-button"
                        disabled={!!profileBusy}
                        onClick={() => void profileAction(p.id, 'open')}
                      >
                        {profileBusy === `${p.id}-open` ? (
                          <Spinner />
                        ) : (
                          <ExternalLink size={13} />
                        )}{' '}
                        {status?.browser.automation
                          ? '기본 브라우저로 로그인'
                          : '기본 브라우저로 YouTube 열기'}
                      </button>
                      <button
                        type="button"
                        className="primary-button"
                        disabled={!!profileBusy || !status?.browser.automation}
                        onClick={() => void profileAction(p.id, 'check')}
                      >
                        {profileBusy === `${p.id}-check` ? (
                          <Spinner />
                        ) : (
                          <Check size={13} />
                        )}{' '}
                        로그인 완료 · 연결
                      </button>
                    </div>
                    {profileFeedback[p.id] &&
                      !(
                        channelRequired[p.id] &&
                        profileFeedback[p.id].code ===
                          'YOUTUBE_CHANNEL_REQUIRED'
                      ) && (
                        <p
                          className={`profile-feedback ${profileFeedback[p.id].error ? 'error' : ''}`}
                          role={
                            profileFeedback[p.id].error ? 'alert' : 'status'
                          }
                        >
                          {profileFeedback[p.id].text}
                        </p>
                      )}
                    {!p.ready && status?.browser.automation && (
                      <button
                        type="button"
                        className="text-button"
                        disabled={!!profileBusy}
                        onClick={() => void profileAction(p.id, 'fresh')}
                      >
                        {profileBusy === `${p.id}-fresh` ? (
                          <Spinner />
                        ) : (
                          <RefreshCw size={13} />
                        )}{' '}
                        새 전용 창으로 다시 로그인
                      </button>
                    )}
                  </div>
                ))}
                <div className="settings-section-title">AI 연결</div>
                <div className="ai-setting">
                  <Sparkles size={20} />
                  <div>
                    <strong>Vertex AI</strong>
                    <small>{status?.vertex.model}</small>
                    <span>{status?.vertex.state || '미확인'}</span>
                  </div>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      void api('/vertex/check', {})
                        .then(() => api<Status>('/status'))
                        .then(setStatus)
                        .catch((e) => notify(e.message, true));
                    }}
                  >
                    인증 확인
                  </button>
                </div>
                <p className="security-note">
                  <ShieldCheck size={15} /> 인증은 로컬 서버에서만 사용합니다.
                  이 화면에는 키나 토큰을 표시하지 않습니다.
                </p>
              </>
            ) : (
              <div className="guide-content">
                <h3>01 · 영상 불러오기</h3>
                <p>
                  최신 영상을 불러오거나 YouTube 링크를 직접 입력하세요. 영상
                  목록에서 원하는 영상을 선택합니다.
                </p>
                <h3>02 · 맥락과 초안 검수</h3>
                <p>
                  AI가 실제 자료에서 고민과 근거를 추출합니다. 근거가 영상과
                  맞는지 확인하고 댓글을 자연스럽게 다듬으세요.
                </p>
                <h3>03 · 게시와 결과 확인</h3>
                <p>
                  프로필 연결 후 댓글 달기를 누르면 기본 브라우저의 전용 창에서
                  한 글자씩 입력·게시합니다. 게시 완료와 내 댓글을 함께
                  확인하세요.
                </p>
                <div className="discovery-note">
                  <ShieldCheck size={18} />
                  <p>
                    결과가 불명확한 게시 건은 ‘확인 필요’로 잠깁니다. 운영
                    기록의 재확인은 게시 없이 댓글만 찾습니다.
                  </p>
                </div>
                <h3>검수 후 시연 제작</h3>
                <p>
                  현재는 사용자 검수 단계입니다. 검수 완료 확인 후 2~3분 시연
                  영상을 준비합니다.
                </p>
                <a
                  className="outline-button"
                  href="/api/review"
                  target="_blank"
                  rel="noreferrer"
                >
                  검수 상태 확인 <ExternalLink size={13} />
                </a>
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
