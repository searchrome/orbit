const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { promisify } = require('node:util');
const { execFile, spawn } = require('node:child_process');
const { CastRelayService } = require('../../cast-relay-service');

async function run() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cast-relay-smoke-'));
    const relay = new CastRelayService({ address: '127.0.0.1' });
    const server = http.createServer(async (req, res) => {
        try {
            const requested = path.basename(new URL(req.url, 'http://localhost').pathname);
            const filename = requested.replace(/^opaque-(\d+)$/, 'test$1.ts');
            const body = await fs.readFile(path.join(dir, filename));
            res.writeHead(200, { 'content-type': filename.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t' });
            res.end(body);
        } catch {
            res.writeHead(404); res.end();
        }
    });
    try {
        await promisify(execFile)(relay.ffmpegPath, [
            '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25',
            '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'hls',
            '-hls_time', '1', '-hls_list_size', '0', path.join(dir, 'test.m3u8')
        ]);
        // Real players commonly serve segments with opaque, extensionless URLs.
        const manifestPath = path.join(dir, 'test.m3u8');
        const manifest = await fs.readFile(manifestPath, 'utf8');
        await fs.writeFile(manifestPath, manifest.replace(/test(\d+)\.ts/g, 'opaque-$1'));
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const source = `http://127.0.0.1:${server.address().port}/test.m3u8`;
        const result = await relay.start({ kind: 'hls', url: source, session: { fetch }, requestHeaders: {} });
        const response = await fetch(result.url, { signal: AbortSignal.timeout(20000) });
        assert.equal(response.status, 200);
        const bytes = Buffer.from(await response.arrayBuffer());
        assert(bytes.length > 188, 'Relay must produce video bytes');
        const probe = spawn(path.join(path.dirname(relay.ffmpegPath), 'ffprobe'), [
            '-v', 'error', '-show_entries', 'stream=codec_name,codec_type', '-of', 'json', '-i', 'pipe:0'
        ]);
        let output = '';
        probe.stdout.on('data', chunk => { output += chunk; });
        const done = new Promise((resolve, reject) => {
            probe.on('error', reject);
            probe.on('exit', code => code === 0 ? resolve() : reject(new Error(`ffprobe exited ${code}`)));
        });
        probe.stdin.end(bytes);
        await done;
        const streams = JSON.parse(output).streams;
        assert(streams.some(s => s.codec_name === 'h264' && s.codec_type === 'video'));
        assert(streams.some(s => s.codec_name === 'aac' && s.codec_type === 'audio'));
        console.log(`PASS: real HLS relay produced ${bytes.length} bytes of playable H.264/AAC MPEG-TS.`);
    } finally {
        await relay.stop();
        await new Promise(resolve => server.close(resolve));
        // Remove only fixtures created by this test in its unique temporary folder.
        for (const file of await fs.readdir(dir)) await fs.unlink(path.join(dir, file));
        await fs.rmdir(dir);
    }
}
run().catch(error => { console.error(error.message); process.exitCode = 1; });
