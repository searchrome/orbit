#!/usr/bin/env node
const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');

const TARGET_URL = process.argv[2] || 'https://www.tvids.tv/watch1366/euphoria/season-03-episode-06-stand-still-and-see';
const CDP_PORT = 9222;
const VIDEO_PATTERNS = [/\.m3u8/i, /\.mp4/i, /\.webm/i, /\.mpd/i, /\.m4s/i, /video\//i, /stream/i, /manifest/i, /playlist/i, /hls/i, /embed/i, /player/i];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const videoUrls = new Set();
const allUrls = [];

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

let cmdId = 1;
function cdp(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = cmdId++;
    const t = setTimeout(() => reject(new Error(`Timeout: ${method}`)), 30000);
    const h = data => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) { clearTimeout(t); ws.removeListener('message', h); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); }
    };
    ws.on('message', h);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function isVideoUrl(url) {
  if (!url || url.startsWith('javascript:') || url.startsWith('data:') || url.startsWith('about:')) return false;
  return VIDEO_PATTERNS.some(p => p.test(url));
}

function trackNetwork(ws) {
  ws.on('message', data => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'Network.requestWillBeSent') {
        const url = msg.params.request.url;
        allUrls.push(url);
        if (isVideoUrl(url)) { videoUrls.add(url); console.log(`  [NET] ${url}`); }
      }
      if (msg.method === 'Network.responseReceived') {
        const url = msg.params.response.url;
        const mime = msg.params.response.mimeType || '';
        allUrls.push(url);
        if (mime.includes('video') || mime.includes('mpegurl') || mime.includes('dash') || isVideoUrl(url)) {
          videoUrls.add(url); console.log(`  [RESP ${mime}] ${url}`);
        }
      }
    } catch {}
  });
}

async function searchDOM(ws, label) {
  try {
    const r = await cdp(ws, 'Runtime.evaluate', {
      expression: `(function(){
        var results = [];
        document.querySelectorAll('video').forEach(function(v){
          if(v.src) results.push({t:'video',u:v.src});
          if(v.currentSrc) results.push({t:'csrc',u:v.currentSrc});
          v.querySelectorAll('source').forEach(function(s){ if(s.src) results.push({t:'source',u:s.src}); });
        });
        document.querySelectorAll('iframe').forEach(function(f){
          if(f.src && f.src.indexOf('javascript:')!==0 && f.src.indexOf('about:')!==0)
            results.push({t:'iframe',u:f.src});
        });
        var html = document.documentElement.outerHTML;
        var m = html.match(/https?:\\/\\/[^"'\\s<>]+\\.(m3u8|mp4|webm|mpd)[^"'\\s<>]*/g);
        if(m) m.forEach(function(u){ results.push({t:'html',u:u}); });
        // Check for file/sources in script data
        var scripts = document.querySelectorAll('script');
        scripts.forEach(function(s){
          var t = s.textContent||'';
          var m1 = t.match(/["']https?:\\/\\/[^"']+\\.(m3u8|mp4|webm)[^"']*/g);
          if(m1) m1.forEach(function(u){ results.push({t:'script',u:u.replace(/^["']/,'')}); });
          // Look for file: or source: patterns
          var m2 = t.match(/(?:file|source|src|url|video_url|stream_url|hls_url)\\s*[:=]\\s*["']([^"']+)/gi);
          if(m2) m2.forEach(function(u){
            var val = u.replace(/^[^"']*["']/,'');
            if(val.match(/https?:\\/\\//)) results.push({t:'var',u:val});
          });
        });
        return JSON.stringify(results);
      })()`,
      returnByValue: true
    });
    if (r?.result?.value) {
      const els = JSON.parse(r.result.value);
      els.forEach(el => { if (el.u) { console.log(`  [${label}-${el.t}] ${el.u}`); videoUrls.add(el.u); } });
      return els;
    }
  } catch (e) { console.log(`  DOM search error (${label}): ${e.message}`); }
  return [];
}

async function clickPlayButtons(ws) {
  try {
    await cdp(ws, 'Runtime.evaluate', {
      expression: `(function(){
        // Click common play button selectors
        var selectors = ['.play-btn', '.play-button', '#play', '.btn-play', '.vjs-big-play-button',
          '.jw-icon-display', '[class*="play"]', 'button[aria-label*="play" i]', '.poster',
          'video', '.video-container', '.player-container', '[data-plyr="play"]'];
        for(var i=0;i<selectors.length;i++){
          var els = document.querySelectorAll(selectors[i]);
          for(var j=0;j<els.length;j++){
            try { els[j].click(); } catch(e){}
          }
        }
        return 'clicked';
      })()`,
      returnByValue: true
    });
  } catch {}
}

async function main() {
  console.log(`Target: ${TARGET_URL}\n`);

  const proc = spawn('npx', ['electron', '.', `--remote-debugging-port=${CDP_PORT}`], {
    cwd: __dirname, stdio: 'ignore', detached: true,
    env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' }
  });
  const cleanup = () => { try { process.kill(-proc.pid); } catch {} };
  process.on('SIGINT', () => { cleanup(); process.exit(); });

  try {
    // Wait for CDP
    for (let i = 0; i < 30; i++) {
      try { await httpGet(`http://127.0.0.1:${CDP_PORT}/json/list`); break; } catch { await sleep(1000); }
    }
    await sleep(3000);
    console.log('CDP ready.\n');

    // Connect to main page and navigate webview
    let targets = await httpGet(`http://127.0.0.1:${CDP_PORT}/json/list`);
    const pageTarget = targets.find(t => t.type === 'page');
    const mainWs = await wsConnect(pageTarget.webSocketDebuggerUrl);

    // Enable network on main page too
    await cdp(mainWs, 'Network.enable');
    trackNetwork(mainWs);

    console.log('Navigating webview...');
    await cdp(mainWs, 'Runtime.evaluate', {
      expression: `document.querySelector('webview').src = '${TARGET_URL}'; 'ok'`,
      returnByValue: true
    });

    // Poll for the webview target to appear with tvids.tv
    console.log('Waiting for webview target...');
    let webviewWs = null;
    for (let i = 0; i < 20; i++) {
      await sleep(2000);
      targets = await httpGet(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const wvTarget = targets.find(t => t.url && t.url.includes('tvids.tv'));
      if (wvTarget && wvTarget.webSocketDebuggerUrl) {
        try {
          webviewWs = await wsConnect(wvTarget.webSocketDebuggerUrl);
          console.log(`Connected to webview: ${wvTarget.url}\n`);
          break;
        } catch {}
      }
    }

    if (!webviewWs) {
      console.log('Could not connect to webview target. Checking all targets...');
      targets = await httpGet(`http://127.0.0.1:${CDP_PORT}/json/list`);
      targets.forEach(t => console.log(`  [${t.type}] ${t.url}`));
      throw new Error('No webview target found');
    }

    // Enable network monitoring on webview
    await cdp(webviewWs, 'Network.enable');
    trackNetwork(webviewWs);

    // Search DOM immediately
    console.log('--- Initial DOM search ---');
    await searchDOM(webviewWs, 'WV');

    // Try clicking play buttons
    console.log('\n--- Clicking play buttons ---');
    await clickPlayButtons(webviewWs);

    // Wait and monitor
    console.log('\n--- Monitoring network (20s) ---');
    await sleep(20000);

    // Search DOM again after interaction
    console.log('\n--- Post-interaction DOM search ---');
    await searchDOM(webviewWs, 'WV2');

    // Check for any new iframe targets
    targets = await httpGet(`http://127.0.0.1:${CDP_PORT}/json/list`);
    console.log('\n--- All targets ---');
    for (const t of targets) {
      console.log(`  [${t.type}] ${t.url?.substring(0, 120)}`);
      if (t.webSocketDebuggerUrl && t.url && !t.url.startsWith('chrome://') &&
          !t.url.startsWith('devtools://') && !t.url.includes('index.html')) {
        try {
          const extraWs = await wsConnect(t.webSocketDebuggerUrl);
          await cdp(extraWs, 'Network.enable');
          trackNetwork(extraWs);
          await searchDOM(extraWs, t.type);
          // Also try clicking play in iframes
          await clickPlayButtons(extraWs);
          await sleep(5000);
          await searchDOM(extraWs, t.type + '2');
          extraWs.close();
        } catch {}
      }
    }

    // Final wait for any late video loads
    console.log('\n--- Final monitoring (10s) ---');
    await sleep(10000);

    // Print results
    const filtered = [...videoUrls].filter(u =>
      !u.startsWith('javascript:') && !u.startsWith('about:') && !u.startsWith('data:') && !u.startsWith('blob:')
    );

    console.log('\n' + '='.repeat(80));
    console.log('VIDEO / MEDIA LINKS FOUND:');
    console.log('='.repeat(80));

    if (filtered.length === 0) {
      console.log('No video links detected.\n');
      console.log('Interesting network URLs:');
      const interesting = [...new Set(allUrls)].filter(u =>
        !u.includes('.css') && !u.includes('.png') && !u.includes('.jpg') && !u.includes('.gif') &&
        !u.includes('.ico') && !u.includes('.svg') && !u.includes('.woff') && !u.includes('.ttf') &&
        !u.includes('google') && !u.includes('facebook') && !u.includes('analytics') &&
        !u.includes('adservice') && !u.includes('doubleclick')
      ).slice(0, 50);
      interesting.forEach((u, i) => console.log(`  ${i + 1}. ${u}`));
    } else {
      filtered.forEach((url, i) => console.log(`${i + 1}. ${url}`));
    }
    console.log('='.repeat(80));

    mainWs.close();
    webviewWs.close();
  } finally {
    console.log('\nShutting down...');
    cleanup();
  }
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
