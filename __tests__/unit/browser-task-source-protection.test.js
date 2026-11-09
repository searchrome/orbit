const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../../main.js'), 'utf8');
const start = source.indexOf('function requestBrowserToolFromRenderer(');
const method = source.slice(start, source.indexOf('\n}\n', start) + 2);

function bridge(dynamic) {
  const requests = new Map();
  const send = jest.fn();
  const request = new Function('artifactService', 'mainWindow', 'browserToolRequests', 'crypto', 'setTimeout',
    `${method}; return requestBrowserToolFromRenderer;`
  )({dynamic}, {isDestroyed: () => false, webContents: {send}}, requests, {randomUUID: () => 'request'}, () => 1);
  return {request, send, requests};
}

test('cleanup receives live source URLs from the browser, overriding caller-supplied exclusions', async () => {
  const {request, send, requests} = bridge({list: () => [{id: 'app'}], get: () => ({definition: {sources: [{url: 'https://live.example'}]}})});
  const result = request({tool: 'cleanup_task_tabs', args: {taskId: 'task', protectedUrls: []}});
  expect(send.mock.calls[0][1].args.protectedUrls).toEqual(['https://live.example']);
  requests.get('request').resolve({ok: true});
  await result;
});

test('cleanup closes nothing when live artifact sources cannot be checked', async () => {
  const {request, send} = bridge({list: () => {throw new Error('Database unavailable');}});
  const result = await request({tool: 'cleanup_task_tabs', args: {taskId: 'task'}});
  expect(result.error.code).toBe('artifact_source_check_failed');
  expect(send).not.toHaveBeenCalled();
});
