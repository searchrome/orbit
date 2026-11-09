const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {Client} = require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport} = require('@modelcontextprotocol/sdk/client/stdio.js');

test('MCP task completion uses the same private ownership token as tab creation', {timeout: 15000}, async () => {
    const requests = [];
    const token = randomUUID();
    const server = http.createServer(async (request, response) => {
        assert.equal(request.headers['x-browser-remote-token'], token);
        let body = '';
        for await (const chunk of request) body += chunk;
        const payload = JSON.parse(body);
        requests.push(payload);
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ok: true, data: payload.tool === 'open_tab' ? {id: 'research-tab'} : {closedTabIds: ['research-tab'], keptTabs: []}}));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const client = new Client({name: 'orbit-task-cleanup-test', version: '1.0.0'});
    try {
        await client.connect(new StdioClientTransport({
            command: process.execPath,
            args: [path.resolve(__dirname, '../browser-mcp-server.js')],
            env: {...process.env, BROWSER_REMOTE_URL: `http://127.0.0.1:${server.address().port}/tool`, BROWSER_REMOTE_TOKEN: token}
        }));
        const names = (await client.listTools()).tools.map(tool => tool.name);
        assert.ok(names.includes('begin_task'));
        assert.ok(names.includes('complete_task'));
        await client.callTool({name: 'begin_task', arguments: {}});
        await client.callTool({name: 'open_tab', arguments: {url: 'https://example.com'}});
        const completed = await client.callTool({name: 'complete_task', arguments: {keepTabIds: ['final-result']}});
        assert.equal(requests.length, 2);
        assert.equal(requests[0].tool, 'open_tab');
        assert.match(requests[0].args._taskId, /^[a-f0-9-]{36}$/);
        assert.equal(requests[1].tool, 'cleanup_task_tabs');
        assert.equal(requests[1].args.taskId, requests[0].args._taskId);
        assert.deepEqual(requests[1].args.keepTabIds, ['final-result']);
        assert.deepEqual(JSON.parse(completed.content[0].text).data.closedTabIds, ['research-tab']);
    } finally {
        await client.close();
        await new Promise(resolve => server.close(resolve));
    }
});
