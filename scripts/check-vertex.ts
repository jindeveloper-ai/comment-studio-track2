import {
  checkVertex,
  generateDraft,
  vertexStatus,
} from '../src/server/vertex.js';

// Never print raw SDK errors, credentials, access tokens, or request headers.
const authenticated = await checkVertex();
console.log(JSON.stringify({ authenticated, ...vertexStatus() }));
if (authenticated && process.argv.includes('--generate')) {
  try {
    const context = {
      title: '연애에서 연락의 빈도보다 약속을 지키는 태도가 중요한 이유',
      description:
        '연락의 빈도보다 약속을 지키는 태도가 중요하다는 연애 고민을 다룹니다.',
      transcript: '',
      transcriptStatus: 'unavailable' as const,
      topComments: ['말보다 꾸준한 행동이 중요한 것 같아요.'],
      warnings: [],
    };
    const draft = await generateDraft(
      {
        id: 'testvideo01',
        title: context.title,
        channel: '연결 점검용 가상 자료',
        thumbnail: '',
        publishedAt: '',
        viewCount: null,
        duration: '',
        source: 'direct',
      },
      context,
      [],
    );
    console.log(
      JSON.stringify({
        generation: true,
        validation: draft.validation,
        concern: draft.concern,
        evidence: draft.evidence,
        comment: draft.comment,
        model: draft.model,
      }),
    );
  } catch {
    console.log(
      JSON.stringify({
        generation: false,
        message: '모델 요청 실패. 권한·모델·할당량을 확인하세요.',
      }),
    );
    process.exitCode = 1;
  }
}
if (!authenticated) process.exitCode = 1;
