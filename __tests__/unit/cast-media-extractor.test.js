const { collectFrames, extractSubtitlesFromWebContents, extractVideoFromWebContents, parseFrameResult, parseSubtitleResult } = require('../../cast-media-extractor');

function frameWith(payload) {
    return {
        frames: [],
        isDestroyed: () => false,
        executeJavaScript: jest.fn().mockResolvedValue(JSON.stringify(payload))
    };
}

describe('cast media extractor', () => {
  test('collects direct video URLs from nested frames and removes duplicates', async () => {
    const player = {
      frames: [],
      isDestroyed: () => false,
      executeJavaScript: jest.fn().mockResolvedValue(JSON.stringify({
        title: 'Embedded player',
        videoElementCount: 1,
        nonDirectVideoCount: 0,
        videos: [
          { url: 'https://media.example.test/movie.m3u8', label: 'Episode' },
          { url: 'https://media.example.test/movie.m3u8', label: 'Duplicate' }
        ]
      }))
    };
    const page = {
      frames: [player],
      isDestroyed: () => false,
      executeJavaScript: jest.fn().mockResolvedValue(JSON.stringify({ title: 'Episode page', videoElementCount: 0, nonDirectVideoCount: 0, videos: [] }))
    };

    const result = await extractVideoFromWebContents({ mainFrame: page });

    expect(collectFrames(page)).toEqual([page, player]);
    expect(result).toMatchObject({ title: 'Episode page', frameCount: 2, videoElementCount: 1 });
    expect(result.videos).toEqual([{ url: 'https://media.example.test/movie.m3u8', label: 'Episode' }]);
    expect(player.executeJavaScript).toHaveBeenCalledTimes(1);
  });

  test('reports blob-backed video without treating it as a castable URL', async () => {
    const frame = {
      frames: [],
      isDestroyed: () => false,
      executeJavaScript: jest.fn().mockResolvedValue(JSON.stringify({ title: 'Player', videoElementCount: 1, nonDirectVideoCount: 1, videos: [] }))
    };

    await expect(extractVideoFromWebContents({ mainFrame: frame })).resolves.toMatchObject({ videos: [], videoElementCount: 1, nonDirectVideoCount: 1 });
    expect(parseFrameResult('not json')).toBeNull();
  });

  test('extracts subtitle cues from the frame that owns the video', async () => {
    const player = frameWith({
      found: true,
      trackSrc: '',
      label: 'English',
      language: 'en',
      cues: [
        { start: 1, end: 2, text: 'Hi' },
        { start: 2, end: 1, text: 'ignored: backwards' },
        { start: 3, end: 4, text: '' }
      ]
    });
    const page = { frames: [player], isDestroyed: () => false, executeJavaScript: jest.fn().mockRejectedValue(new Error('no frame')) };

    await expect(extractSubtitlesFromWebContents({ mainFrame: page })).resolves.toEqual({
      found: true,
      trackSrc: '',
      label: 'English',
      language: 'en',
      cues: [{ start: 1, end: 2, text: 'Hi' }]
    });
  });

  test('falls back to a sidecar track URL and a default result when nothing is found', async () => {
    const sidecar = frameWith({ found: true, trackSrc: 'https://media.example/subs.vtt', label: '', language: 'en', cues: [] });
    await expect(extractSubtitlesFromWebContents({ mainFrame: sidecar })).resolves.toMatchObject({
      found: true,
      trackSrc: 'https://media.example/subs.vtt',
      cues: []
    });
    await expect(extractSubtitlesFromWebContents({ mainFrame: frameWith({ found: false }) })).resolves.toMatchObject({ found: false, cues: [] });
  });

  test('sanitizes subtitle extraction results', () => {
    expect(parseSubtitleResult(JSON.stringify({
      found: true,
      trackSrc: 'javascript:alert(1)',
      label: ['nope'],
      cues: [
        { start: 'x', end: 2, text: 'bad start' },
        { start: 1, end: 2, text: 'good' }
      ]
    }))).toEqual({
      found: true,
      trackSrc: '',
      label: '',
      language: '',
      cues: [{ start: 1, end: 2, text: 'good' }]
    });
    expect(parseSubtitleResult('not json')).toBeNull();
  });
});
