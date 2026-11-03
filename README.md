# 운명원 · Comment Studio

**영상 맥락을 읽고, 댓글 초안을 검수한 뒤, 실제 게시 결과까지 확인하는 로컬 대시보드입니다.**

제이지그룹 AI PM 과제 Track 2 · YouTube 댓글 워크플로

[시연 영상](#시연-영상) · [빠른 시작](#빠른-시작) · [기술과 출처](#기술과-출처) · [검증](#검증)

## 시연 영상

**2분 38초** 동안 세 프로필 연결, 영상별 초안 비교, 실제 댓글 입력과 게시 확인을 보여줍니다.

https://github.com/user-attachments/assets/23c7dd53-d2a3-4f17-a8e8-abf1506fc4cf

[Google Drive에서 1080p 영상 재생](https://drive.google.com/file/d/1AeM-uR6TBH4u_tNLE6SJrW5pLQvwEok7/view)

## 사용 흐름

| 단계 | 화면에서 하는 일 |
| --- | --- |
| **01 · 영상 불러오기** | 공개 검색에서 최대 20개를 가져오거나, YouTube 링크를 직접 입력합니다. |
| **02 · 맥락과 초안 검수** | 고민과 근거를 읽고 초안을 수정합니다. 자막이 없으면 제목과 설명을 활용합니다. |
| **03 · 게시와 결과 확인** | 최대 세 개의 전용 프로필 중 하나를 선택해 게시합니다. 브라우저가 한 글자씩 입력하고, 작성 채널과 본문을 대조해 결과를 기록합니다. |

- **게시 제한** — 프로필 전체를 합쳐 영상당 1회, 한국시간 기준 하루 기본 10회입니다. 삭제 이후에도 사용량과 이력을 보존합니다.
- **게시 전 검사** — 공백 포함 40~120자, 근거 문구, 링크·해시태그·허위 후기 패턴을 확인합니다. 생성과 재생성은 영상별 하루 5회까지 가능합니다.
- **운영 기록** — 성공·실패·확인 필요 상태와 댓글 링크를 남깁니다. 게시 결과가 불명확할 때는 **재확인**으로 조회합니다. 삭제는 게시 당시 채널과 댓글 ID·본문을 대조한 뒤 실행합니다.
- **유망 영상** — 조회수 1,000~5,000회와 시간당 150회 이상 증가를 실측으로 판정합니다. 이 목록에서는 초안까지만 준비합니다.

## 빠른 시작

**준비물** · Node.js 24, pnpm 11, Vertex AI를 사용할 수 있는 Google Cloud 프로젝트, 기본 브라우저로 설정된 Chrome·Edge·Chromium 중 하나

```sh
pnpm install --frozen-lockfile
cp .env.example .env
```

1. `.env`에 `GOOGLE_CLOUD_PROJECT`와 저장소 밖 서비스 계정 JSON의 절대 경로를 `GOOGLE_APPLICATION_CREDENTIALS`로 설정합니다. 기본 리전은 `global`, 기본 모델은 `gemini-3.8-flash`입니다.
2. `pnpm dev`로 실행합니다. 기본 주소는 **http://127.0.0.1:3000**입니다. 해당 포트가 사용 중이면 터미널에 표시된 주소로 접속합니다.
3. **프로필 설정 → 기본 브라우저로 로그인**에서 Google 로그인과 YouTube 채널 준비를 마친 뒤 **로그인 완료 · 연결**을 누릅니다. Windows에서는 연결 전에 전용 로그인 창을 종료합니다.
4. 영상을 선택하고 초안을 검수한 뒤 **댓글 달기**를 누르면 실제 YouTube에 게시합니다.

<details>
<summary>브라우저 지원과 로그인 문제 해결</summary>

- macOS의 기본 Chrome에서 전용 창 실행과 실제 게시를 검증했습니다. Windows와 Linux의 브라우저 감지는 단위 테스트 범위입니다.
- Safari·Firefox·Brave에서는 일반 페이지 열기를 지원합니다. 전용 프로필 연결과 자동 게시에는 Chrome·Edge·Chromium 계열 기본 브라우저가 필요합니다.
- 로그인이 반복해서 실패하면 **새 전용 창으로 다시 로그인**을 선택합니다. YouTube 채널이 없다면 먼저 채널을 준비합니다. [YouTube 로그인 문제 해결](https://support.google.com/youtube/troubleshooter/3219097) · [채널 만들기](https://support.google.com/youtube/answer/1646861?hl=ko)
- 빌드해서 실행할 때는 `pnpm build` 후 `pnpm start`를 사용합니다. 브라우저 자동 열기를 끄려면 `pnpm start -- --no-open`을 사용합니다.

</details>

## 기술과 출처

| 영역 | 사용 기술 | 프로젝트에서 하는 일 |
| --- | --- | --- |
| 화면 | [React 19](https://react.dev/) · [Vite 8](https://vite.dev/) | 세 단계 화면과 게시 상태 표시, 프런트엔드 빌드 |
| 서버 | [Node.js 24](https://nodejs.org/) · [Express 5](https://expressjs.com/) | 로컬 HTTP API와 SSE로 작업 상태 전달 |
| 형식과 검증 | [TypeScript](https://www.typescriptlang.org/) · [Zod](https://zod.dev/) | 화면과 서버의 데이터 형식 정의, 요청과 초안 검증 |
| 저장 | [SQLite via node:sqlite](https://nodejs.org/api/sqlite.html) | 게시 이력과 중복 방지, 일일 한도 관리 |
| 브라우저 | [Playwright](https://playwright.dev/) | 전용 프로필에서 실제 댓글 입력과 게시 확인 |
| AI | [Google Gen AI SDK](https://github.com/googleapis/js-genai) · Vertex AI | 수집한 근거를 바탕으로 댓글 초안 생성 |
| 디자인 자산 | [Lucide](https://lucide.dev/) · [DM Sans](https://fonts.google.com/specimen/DM+Sans) · [Noto Sans KR](https://fonts.google.com/noto/specimen/Noto+Sans+KR) | 아이콘과 화면 글꼴 |

레이아웃과 스타일은 [React 화면](src/web/App.tsx)과 [프로젝트 CSS](src/web/styles.css)에 구현했습니다. 정확한 패키지 버전은 [package.json](package.json)에서 확인할 수 있습니다.

**작업에 사용한 스킬** · Codex Sites는 로컬 미리보기, PDF 스킬은 과제 원문 분석, project-validation-bootstrap은 검증 설정에 사용했습니다.

**디자인 참고 링크** · Anthropic의 공식 Claude Code `frontend-design` 스킬과 이용 조건입니다. 이 프로젝트에 적용했는지는 작업 기록에서 확인되지 않았습니다. [공식 플러그인](https://github.com/anthropics/claude-code/tree/main/plugins/frontend-design) · [스킬 원문](https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md) · [이용 조건](https://github.com/anthropics/skills/blob/main/skills/frontend-design/LICENSE.txt)

## 검증

```sh
pnpm test
pnpm typecheck
pnpm build
node scripts/check-public.mjs --history
```

공개 전 검사는 Git 인덱스와 이력에서 비밀정보를 확인합니다. 실제 `.env`, 인증 JSON, 브라우저 세션, 운영 DB, 원본 캡처는 로컬에서 관리합니다. [GitHub Actions 검증 결과](https://github.com/jindeveloper-ai/comment-studio-track2/actions)

[코드 흐름과 설계 이유](docs/CODE_WALKTHROUGH.ko.md) · [과제 요구사항 점검](docs/REQUIREMENTS_AUDIT.ko.md) · [검수 체크리스트](docs/REVIEW.ko.md)
