jest.mock('child_process', () => ({
    execSync: jest.fn(),
}));

const {
    parseArgs,
    normalizeCodexReasoningEffort,
    buildCodexExecArgs,
} = require('../../scripts/cdp-agent-cli.js');

describe('cdp-agent-cli codex config', () => {
    test('parses backend, model, and reasoning effort flags', () => {
        const flags = parseArgs([
            'node',
            'scripts/cdp-agent-cli.js',
            '--backend',
            'codex',
            '--model',
            'gpt-5.4-mini',
            '--reasoning-effort',
            'xhigh',
            '--max-steps',
            '12',
            'find',
            'sellers'
        ]);

        expect(flags.backend).toBe('codex');
        expect(flags.model).toBe('gpt-5.4-mini');
        expect(flags.reasoningEffort).toBe('xhigh');
        expect(flags.maxSteps).toBe(12);
        expect(flags.prompt).toBe('find sellers');
    });

    test('parses codex-evrim backend', () => {
        const flags = parseArgs([
            'node',
            'scripts/cdp-agent-cli.js',
            '--backend',
            'codex-evrim',
            '--model',
            'gpt-5.4-mini',
            '--effort',
            'high',
            'find',
            'electronics',
            'sellers'
        ]);

        expect(flags.backend).toBe('codex-evrim');
        expect(flags.model).toBe('gpt-5.4-mini');
        expect(flags.reasoningEffort).toBe('high');
        expect(flags.prompt).toBe('find electronics sellers');
    });

    test('normalizes supported codex effort levels', () => {
        expect(normalizeCodexReasoningEffort('XHIGH')).toBe('xhigh');
        expect(normalizeCodexReasoningEffort('high')).toBe('high');
        expect(() => normalizeCodexReasoningEffort('extreme')).toThrow(
            'Unknown Codex reasoning effort "extreme". Use low, medium, high, or xhigh.'
        );
    });

    test('builds codex exec args with reasoning effort override', () => {
        expect(buildCodexExecArgs({
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
            '-o',
            '/tmp/result.txt',
            '-'
        ]);
    });
});
