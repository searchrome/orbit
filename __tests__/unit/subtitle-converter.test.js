const { cuesToSrt, formatTimecode, parseTimecode, parseWebVtt } = require('../../subtitle-converter');

describe('subtitle converter', () => {
    test('parses WebVTT cues with identifiers, settings, and inline tags', () => {
        const vtt = [
            'WEBVTT',
            '',
            'NOTE this block is skipped',
            '',
            'ID-1',
            '00:00:01.000 --> 00:00:03.500 align:center',
            '<c>Hello</c> <v Speaker>world</v>',
            'second line',
            '',
            '0:04 --> 0:05,000',
            'short &amp; sweet'
        ].join('\n');
        expect(parseWebVtt(vtt)).toEqual({
            cues: [
                { start: 1, end: 3.5, text: 'Hello world\nsecond line' },
                { start: 4, end: 5, text: 'short & sweet' }
            ]
        });
    });

    test('rejects malformed and empty cues', () => {
        const vtt = [
            'WEBVTT',
            '',
            '00:05.000 --> 00:04.000',
            'backwards timing',
            '',
            '00:06.000 --> 00:07.000',
            '',
            '00:08.000 --> nonsense',
            'broken'
        ].join('\n');
        expect(parseWebVtt(vtt)).toEqual({ cues: [] });
    });

    test('formats SRT timecodes', () => {
        expect(formatTimecode(0)).toBe('00:00:00,000');
        expect(formatTimecode(3.5)).toBe('00:00:03,500');
        expect(formatTimecode(3725.25)).toBe('01:02:05,250');
        expect(parseTimecode('01:02:05,250')).toBe(3725.25);
        expect(parseTimecode('00:01:02.500')).toBe(62.5);
        expect(parseTimecode('nope')).toBeNull();
    });

    test('builds an SRT document from cues', () => {
        const srt = cuesToSrt([
            { start: 1, end: 2.5, text: 'First line' },
            { start: 3, end: 4, text: 'Second' }
        ]);
        expect(srt).toBe([
            '1',
            '00:00:01,000 --> 00:00:02,500',
            'First line',
            '',
            '2',
            '00:00:03,000 --> 00:00:04,000',
            'Second',
            ''
        ].join('\n'));
    });

    test('skips invalid cues and returns empty output when nothing survives', () => {
        expect(cuesToSrt([{ start: 5, end: 4, text: 'nope' }, { start: 1, end: 2, text: '' }])).toBe('');
    });
});
