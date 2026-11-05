const service = require('../../claude-cli-service.js');

describe('CLI assistant service', () => {
    beforeEach(() => {
        service.codexSessionsByAssistantSession.clear();
    });

    test('builds codex exec args for a new persistent session', () => {
        expect(service.buildCodexCliArgs({
            model: 'gpt-5.4-mini',
            reasoningEffort: 'xhigh',
            outputFile: '/tmp/result.txt'
        })).toEqual([
            'exec',
            '--dangerously-bypass-approvals-and-sandbox',
            '--model',
            'gpt-5.4-mini',
            '-c',
            'model_reasoning_effort="xhigh"',
            '--json',
            '-o',
            '/tmp/result.txt',
            '-'
        ]);
    });

    test('builds codex exec resume args for an existing session', () => {
        expect(service.buildCodexCliArgs({
            model: 'gpt-5.4-mini',
            reasoningEffort: 'medium',
            outputFile: '/tmp/result.txt',
            codexSessionId: '019eac0b-2fe6-71b2-bdf9-2b00356d51c0'
        })).toEqual([
            'exec',
            'resume',
            '--dangerously-bypass-approvals-and-sandbox',
            '--model',
            'gpt-5.4-mini',
            '-c',
            'model_reasoning_effort="medium"',
            '--json',
            '-o',
            '/tmp/result.txt',
            '019eac0b-2fe6-71b2-bdf9-2b00356d51c0',
            '-'
        ]);
    });

    test('extracts codex session id from JSONL event output', () => {
        const jsonl = [
            JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } }),
            JSON.stringify({
                type: 'session_meta',
                payload: {
                    id: '019eac0b-2fe6-71b2-bdf9-2b00356d51c0',
                    cwd: '/Users/sozay/workspace/browser'
                }
            })
        ].join('\n');

        expect(service.extractCodexSessionIdFromJsonLines(jsonl)).toBe('019eac0b-2fe6-71b2-bdf9-2b00356d51c0');
    });

    test('compact prompt is shorter and keeps current state', () => {
        const full = service.buildPromptText({
            prompt: 'Find a bike',
            messages: [{ role: 'user', content: 'Find a bike' }],
            browserState: { tabs: Array.from({ length: 5 }, (_, index) => ({ id: `tab-${index}`, url: `https://example.com/${index}` })) },
            taskProfile: { kind: 'shopping' },
            runtimeState: { toolCallsRemaining: 42 }
        });
        const compact = service.buildPromptText({
            prompt: 'Find a bike',
            messages: [{ role: 'user', content: 'Find a bike' }],
            browserState: { tabs: Array.from({ length: 5 }, (_, index) => ({ id: `tab-${index}`, url: `https://example.com/${index}` })) },
            taskProfile: { kind: 'shopping' },
            runtimeState: { toolCallsRemaining: 42 },
            compactPlannerContext: true
        });

        expect(compact.length).toBeLessThan(full.length);
        expect(compact).toContain('Continue the existing browser workspace task');
        expect(compact).toContain('toolCallsRemaining');
    });

    test('exports the Claude Haiku 5.5 model used by the claude-haiku provider', () => {
        expect(service.CLAUDE_HAIKU_MODEL).toBe('claude-haiku-5-5');
    });
});
