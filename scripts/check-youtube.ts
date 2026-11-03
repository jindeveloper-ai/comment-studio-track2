import { safeError } from '../src/server/safety.js';
import {
  closeCollector,
  collectContext,
  searchVideos,
  videoDetails,
} from '../src/server/youtube.js';

try {
  const videos = await searchVideos();
  console.log(JSON.stringify({ count: videos.length, sample: videos[0] }));
  if (process.argv.includes('--context') && videos[0]) {
    const detail = await videoDetails(videos[0].id, 'latest');
    const context = await collectContext(detail.video);
    console.log(
      JSON.stringify({
        exactViews: detail.video.viewCount,
        transcriptStatus: context.transcriptStatus,
        transcriptChars: context.transcript.length,
        popularCommentCount: context.topComments.length,
        warnings: context.warnings,
      }),
    );
  }
} catch (e) {
  console.log(JSON.stringify({ error: safeError(e) }));
  process.exitCode = 1;
} finally {
  await closeCollector();
}
