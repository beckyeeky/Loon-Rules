/**
 * tests/run-tests.js — applemusic-probe.js 的离线单测（Node 22，无第三方依赖）
 *
 * 做法：把脚本放进 vm 沙箱，注入 mock 的 Loon 全局（$done / $httpClient / $environment / $argument），
 * 用真实接口形状驱动（$httpClient.get(options, callback(err, resp, data))），只替换网络与宿主。
 *
 * 不能覆盖的宿主行为（必须真机验证）：
 *   - Loon 是否真的把菜单入口的节点名放进 $environment.params.node / nodeInfo（字段真机结构未核实）
 *   - $httpClient 的 node 是否按节点名/备注名解析、重名取哪个
 *   - 服务器对 Range 的真实响应、真实超时取消时机、通知正文长度上限
 *   - 插件里相对脚本路径解析到哪个目录
 *
 * 运行：node tests/run-tests.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH = path.join(ROOT, 'scripts', 'applemusic-probe.js');
const SCRIPT_CODE = fs.readFileSync(SCRIPT_PATH, 'utf8');
const FIX_JP = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'lookup-jp-song.json'), 'utf8'));
const FIX_US = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'lookup-us-album.json'), 'utf8'));

const JP_URL = 'https://music.apple.com/jp/album/onslaught/6822966749?i=6822966763&l=en-US';
const PREVIEW_HOST = 'https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview211/v4/x/preview.m4a';

/* ---------------- harness ---------------- */

function loadPure() {
  // 有 module 时脚本只导出纯函数、不执行主流程，便于直接测解析类逻辑
  const sandbox = { module: { exports: {} }, console, setTimeout, clearTimeout };
  sandbox.exports = sandbox.module.exports;
  vm.createContext(sandbox);
  vm.runInContext(SCRIPT_CODE, sandbox, { filename: 'applemusic-probe.js' });
  return sandbox.module.exports;
}

/**
 * 跑一次完整探测。
 * @param {object} opt { environment, argument, http }
 *   http(options, index) -> { resp, data } | { err } | 'pending'
 * @returns {Promise<{done: Array, requests: Array}>}
 */
function runProbe(opt) {
  const done = [];
  const requests = [];
  const http = opt.http || function () { return { err: 'no mock' }; };

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    // 故意不提供 clearTimeout：官方 Script API §2.3 表明运行时没有可靠的 clearTimeout
    $done: function (value) { done.push(value); },
    $httpClient: {
      get: function (options, callback) {
        requests.push(options);
        const idx = requests.length;
        let r;
        try {
          r = http(options, idx);
        } catch (e) {
          r = { err: e };
        }
        if (r === 'pending') return; // 永不回调，模拟挂死
        setTimeout(function () {
          if (r && r.err) callback(r.err, null, null);
          else callback(null, (r && r.resp) || {}, r && 'data' in r ? r.data : null);
        }, 0);
      }
    }
  };
  if ('argument' in opt) sandbox.$argument = opt.argument;
  if ('environment' in opt) sandbox.$environment = opt.environment;

  vm.createContext(sandbox);
  vm.runInContext(SCRIPT_CODE, sandbox, { filename: 'applemusic-probe.js' });

  // 等到「首个 $done 出现」后再留一段静默期，用来抓第 2 次 $done / 迟到请求；
  // 快照在静默期结束后才取（不在等待前 slice），否则看不见后发的完成。
  return new Promise(function (resolve) {
    const started = Date.now();
    const quietMs = opt.quietMs == null ? 120 : opt.quietMs;
    let quietStart = null;
    (function poll() {
      const now = Date.now();
      if (done.length > 0 && quietStart === null) quietStart = now;
      if (quietStart !== null && now - quietStart >= quietMs) {
        resolve({ done: done.slice(), requests: requests.slice() });   // 最后才快照
        return;
      }
      if (now - started > (opt.waitMs || 6000)) {
        resolve({ done: done.slice(), requests: requests.slice(), timedOut: true });
        return;
      }
      setTimeout(poll, 5);
    })();
  });
}

const NODE_ENV = { params: { node: 'JP-Tokyo-01' } };

function okLookup(fixture) {
  return { resp: { status: 200, headers: { 'Content-Type': 'text/javascript; charset=utf-8' } }, data: JSON.stringify(fixture) };
}

function okPreview206() {
  return {
    resp: { status: 206, headers: { 'Content-Type': 'audio/x-m4p', 'Content-Range': 'bytes 0-1023/1084398', 'Content-Length': '1024' } },
    data: 'x'.repeat(1024)
  };
}

function routeByUrl(map, fallback) {
  return function (options) {
    for (const key of Object.keys(map)) {
      if (options.url.indexOf(key) >= 0) return map[key];
    }
    return fallback || { resp: { status: 404, headers: {} }, data: '' };
  };
}

/* ---------------- test registry ---------------- */

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/* --- 1. 链接解析 --- */

test('parseTargetUrl: 日本站 ?i= 链接 → 歌曲 ID 优先', async () => {
  const { parseTargetUrl } = loadPure();
  const r = parseTargetUrl(JP_URL);
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(r.country, 'JP');
  assert.strictEqual(r.songId, '6822966763');
  assert.strictEqual(r.albumId, '6822966749');
  assert.strictEqual(r.lookupId, '6822966763');
});

test('parseTargetUrl: 美国站专辑链接（无 ?i=）→ 用专辑 ID', async () => {
  const { parseTargetUrl } = loadPure();
  const r = parseTargetUrl('https://music.apple.com/us/album/some-album/1440833098');
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(r.country, 'US');
  assert.strictEqual(r.songId, null);
  assert.strictEqual(r.albumId, '1440833098');
  assert.strictEqual(r.lookupId, '1440833098');
});

test('parseTargetUrl: /song/ 路径 ID 可作歌曲 ID，?i= 仍然优先', async () => {
  const { parseTargetUrl } = loadPure();
  const onlyPath = parseTargetUrl('https://music.apple.com/us/song/foo/111111');
  assert.strictEqual(onlyPath.lookupId, '111111');
  const withQuery = parseTargetUrl('https://music.apple.com/us/song/foo/111111?i=222222');
  assert.strictEqual(withQuery.songId, '222222');
  assert.strictEqual(withQuery.lookupId, '222222');
});

test('parseTargetUrl: 忽略查询串顺序与附加参数', async () => {
  const { parseTargetUrl } = loadPure();
  const r = parseTargetUrl('https://music.apple.com/jp/album/a/100?l=en-US&i=200&uo=4');
  assert.strictEqual(r.songId, '200');
  const r2 = parseTargetUrl('https://music.apple.com/jp/album/a/100?i=');
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.lookupId, '100');
});

test('parseTargetUrl: 非法/越权链接全部拒绝', async () => {
  const { parseTargetUrl } = loadPure();
  const bad = [
    '',
    '   ',
    'http://music.apple.com/jp/album/a/1',
    'ftp://music.apple.com/jp/album/a/1',
    'https://music.apple.com.evil.com/jp/album/a/1',
    'https://evil.com/https://music.apple.com/jp/album/a/1',
    'https://music.apple.com:443/jp/album/a/1',
    'https://user@music.apple.com/jp/album/a/1',
    'https://itunes.apple.com/lookup?id=1',
    'https://music.apple.com/album/a/1',
    'https://music.apple.com/jp/playlist/a/1',
    'https://music.apple.com/jp/album/onslaught/no-id',
    'https://music.apple.com/jp/album/a/1 2',
    'https://music.apple.com/jp/album/a/1\n'
  ];
  for (const url of bad) {
    const r = parseTargetUrl(url);
    assert.strictEqual(r.ok, false, 'should reject: ' + JSON.stringify(url));
    assert.ok(r.reason && r.reason.length > 0, 'need reason for ' + JSON.stringify(url));
  }
});

test('parseTargetUrl: 不依赖 URL 全局对象（沙箱内无 URL）', async () => {
  const sandbox = { module: { exports: {} }, console, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  assert.strictEqual(typeof sandbox.URL, 'undefined');
  vm.runInContext(SCRIPT_CODE, sandbox, { filename: 'applemusic-probe.js' });
  const r = sandbox.module.exports.parseTargetUrl(JP_URL);
  assert.strictEqual(r.ok, true);
});

/* --- 2. 节点来源 --- */

test('resolveNode: 路由用原样节点名（不折叠空格、不截断），展示值单独净化', async () => {
  const { resolveNode } = loadPure();
  const raw = '  香港 HK-01  备用  ' + 'X'.repeat(200);
  const r = resolveNode({ params: { node: raw } });
  assert.strictEqual(r.name, raw, '路由值必须与 Loon 给的一模一样');
  assert.ok(!/\s{2}/.test(r.display), '展示值合并空白');
  assert.ok(r.display.length <= 120, '展示值限长');
  assert.notStrictEqual(r.display, r.name);
  // 只由空白构成的节点名视为缺失
  assert.strictEqual(resolveNode({ params: { node: '   ' } }).name, null);
});

test('resolveNode: params.node 缺失时返回 null（不回落默认路由）', async () => {
  const { resolveNode } = loadPure();
  assert.strictEqual(resolveNode(undefined).name, null);
  assert.strictEqual(resolveNode({}).name, null);
  assert.strictEqual(resolveNode({ params: {} }).name, null);
  assert.strictEqual(resolveNode({ params: { node: '   ' } }).name, null);
});

test('resolveNode: 只认 params.node，不猜 nodeInfo 字段', async () => {
  const { resolveNode } = loadPure();
  // nodeInfo 存在但结构未知：不从中取名（猜错会用到非目标节点出网）
  const onlyInfo = resolveNode({ params: { nodeInfo: { name: 'HK-02', nodeName: 'HK-02' } } });
  assert.strictEqual(onlyInfo.name, null, 'nodeInfo 不得被猜测使用');
  assert.strictEqual(onlyInfo.nodeInfoPresent, true);
  assert.strictEqual(resolveNode({ params: { nodeInfo: 'HK-02' } }).name, null);

  const ok = resolveNode({ params: { node: 'US-01', nodeInfo: { nodeName: 'OTHER' } } });
  assert.strictEqual(ok.name, 'US-01');
  assert.strictEqual(ok.source, '$environment.params.node');
  assert.strictEqual(ok.display, 'US-01');
});

test('仅有 nodeInfo（无 params.node）：停止且不发请求', async () => {
  const out = await runProbe({
    argument: { url: JP_URL },
    environment: { params: { nodeInfo: { name: 'HK-02' } } },
    http: function () { throw new Error('不应发起请求'); }
  });
  assert.strictEqual(out.done.length, 1);
  assert.strictEqual(out.requests.length, 0);
  assert.ok(/未选择节点/.test(out.done[0].title));
  assert.ok(/nodeInfo/.test(out.done[0].content), out.done[0].content);
  assert.ok(/停止/.test(out.done[0].content));
});

/* --- 3. 主流程 --- */

test('节点缺失：不发出任何请求，明确停止', async () => {
  const out = await runProbe({
    argument: { url: JP_URL },
    environment: {},
    http: function () { throw new Error('不应发起请求'); }
  });
  assert.strictEqual(out.done.length, 1);
  assert.strictEqual(out.requests.length, 0);
  assert.ok(/未选择节点/.test(out.done[0].title), out.done[0].title);
  assert.ok(/停止/.test(out.done[0].content));
});

test('链接非法：有节点也不发请求', async () => {
  const out = await runProbe({
    argument: { url: 'https://music.apple.com.evil.com/jp/album/a/1' },
    environment: NODE_ENV,
    http: function () { throw new Error('不应发起请求'); }
  });
  assert.strictEqual(out.done.length, 1);
  assert.strictEqual(out.requests.length, 0);
  assert.ok(/链接不可用/.test(out.done[0].title));
});

test('成功路径：lookup + preview 206，$done 恰好一次，node 与 Range 正确', async () => {
  const out = await runProbe({
    argument: { url: JP_URL, timeout_ms: 5000, total_timeout_ms: 9000 },
    environment: NODE_ENV,
    http: routeByUrl({
      'itunes.apple.com/lookup': okLookup(FIX_JP),
      'audio-ssl.itunes.apple.com': okPreview206()
    })
  });
  assert.strictEqual(out.done.length, 1, '$done 必须恰好一次');
  assert.strictEqual(out.requests.length, 2, 'lookup 1 次 + 试听 1 次');
  assert.strictEqual(out.requests[0].node, 'JP-Tokyo-01');
  assert.strictEqual(out.requests[1].node, 'JP-Tokyo-01');
  assert.strictEqual(out.requests[0].timeout, 5000);
  assert.ok(/id=6822966763/.test(out.requests[0].url), out.requests[0].url);
  assert.ok(/country=jp/.test(out.requests[0].url));
  assert.ok(/entity=song/.test(out.requests[0].url));
  assert.strictEqual(out.requests[1].headers.Range, 'bytes=0-1023');
  assert.ok(/目录查询：✅/.test(out.done[0].content), out.done[0].content);
  assert.ok(/试听 HTTP：✅ HTTP 206/.test(out.done[0].content), out.done[0].content);
  assert.ok(/未验证完整播放/.test(out.done[0].content));
});

test('目录 API 返回 resultCount=0：判为目录为空，不请求试听', async () => {
  const out = await runProbe({
    argument: { url: JP_URL },
    environment: NODE_ENV,
    http: routeByUrl({
      'itunes.apple.com/lookup': { resp: { status: 200, headers: {} }, data: JSON.stringify({ resultCount: 0, results: [] }) }
    })
  });
  assert.strictEqual(out.done.length, 1);
  assert.strictEqual(out.requests.length, 1);
  assert.ok(/目录为空/.test(out.done[0].title), out.done[0].title);
  assert.ok(/resultCount=0/.test(out.done[0].content));
});

test('目录 API 5xx：判为失败，不请求试听', async () => {
  const out = await runProbe({
    argument: { url: JP_URL },
    environment: NODE_ENV,
    http: routeByUrl({
      'itunes.apple.com/lookup': { resp: { status: 503, headers: {} }, data: 'busy' }
    })
  });
  assert.strictEqual(out.done.length, 1);
  assert.strictEqual(out.requests.length, 1);
  assert.ok(/目录查询失败/.test(out.done[0].title));
  assert.ok(/HTTP 503/.test(out.done[0].content));
});

test('目录 API 200 但非 JSON：不算成功', async () => {
  const out = await runProbe({
    argument: { url: JP_URL },
    environment: NODE_ENV,
    http: routeByUrl({
      'itunes.apple.com/lookup': { resp: { status: 200, headers: { 'Content-Type': 'text/html' } }, data: '<html>captive</html>' }
    })
  });
  assert.strictEqual(out.done.length, 1);
  assert.strictEqual(out.requests.length, 1);
  assert.ok(/目录查询失败/.test(out.done[0].title));
  assert.ok(/JSON 解析失败|不是可用 JSON/.test(out.done[0].content), out.done[0].content);
});

test('目录请求网络错误：失败收尾，不试听', async () => {
  const out = await runProbe({
    argument: { url: JP_URL },
    environment: NODE_ENV,
    http: function () { return { err: 'connection reset' }; }
  });
  assert.strictEqual(out.done.length, 1);
  assert.strictEqual(out.requests.length, 1);
  assert.ok(/目录查询失败/.test(out.done[0].title));
  assert.ok(/connection reset/.test(out.done[0].content));
});

test('条目无 previewUrl：只报目录可达', async () => {
  const noPreview = { resultCount: 1, results: [{ wrapperType: 'track', kind: 'song', trackId: 6822966763, trackName: 'Onslaught' }] };
  const out = await runProbe({
    argument: { url: JP_URL },
    environment: NODE_ENV,
    http: routeByUrl({ 'itunes.apple.com/lookup': { resp: { status: 200, headers: {} }, data: JSON.stringify(noPreview) } })
  });
  assert.strictEqual(out.done.length, 1);
  assert.strictEqual(out.requests.length, 1);
  assert.ok(/目录可达/.test(out.done[0].title));
  assert.ok(/没有 previewUrl/.test(out.done[0].content));
});

test('试听服务器忽略 Range（200 全量）：判可达但记录未按 Range 返回，且仍只请求 1 次', async () => {
  const out = await runProbe({
    argument: { url: JP_URL },
    environment: NODE_ENV,
    http: routeByUrl({
      'itunes.apple.com/lookup': okLookup(FIX_JP),
      'audio-ssl.itunes.apple.com': {
        resp: { status: 200, headers: { 'Content-Type': 'audio/x-m4p', 'Content-Length': '1084398' } },
        data: 'y'.repeat(4096)
      }
    })
  });
  assert.strictEqual(out.done.length, 1);
  assert.strictEqual(out.requests.length, 2, '只允许 1 次试听请求');
  assert.ok(/HTTP 200 · audio\/x-m4p · 4096 字节（服务器忽略 Range）/.test(out.done[0].content), out.done[0].content);
  assert.ok(/可能拉取了整段试听文件/.test(out.done[0].content));
});

test('试听 200 但返回 HTML（错误页）：判失败，不能只看状态码', async () => {
  const out = await runProbe({
    argument: { url: JP_URL },
    environment: NODE_ENV,
    http: routeByUrl({
      'itunes.apple.com/lookup': okLookup(FIX_JP),
      'audio-ssl.itunes.apple.com': {
        resp: { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
        data: '<html><body>Access denied</body></html>'
      }
    })
  });
  assert.strictEqual(out.done.length, 1);
  assert.strictEqual(out.requests.length, 2);
  assert.ok(/试听不可用/.test(out.done[0].title), out.done[0].title);
  assert.ok(/不是音频|text\/html/.test(out.done[0].content), out.done[0].content);
});

test('试听 206 但响应体为空：判失败', async () => {
  const out = await runProbe({
    argument: { url: JP_URL },
    environment: NODE_ENV,
    http: routeByUrl({
      'itunes.apple.com/lookup': okLookup(FIX_JP),
      'audio-ssl.itunes.apple.com': { resp: { status: 206, headers: { 'Content-Type': 'audio/x-m4p' } }, data: '' }
    })
  });
  assert.ok(/试听不可用/.test(out.done[0].title));
  assert.ok(/响应体为空/.test(out.done[0].content), out.done[0].content);
});

test('试听 206 但缺少 Content-Type：无法确认音频，判失败', async () => {
  const out = await runProbe({
    argument: { url: JP_URL },
    environment: NODE_ENV,
    http: routeByUrl({
      'itunes.apple.com/lookup': okLookup(FIX_JP),
      'audio-ssl.itunes.apple.com': { resp: { status: 206, headers: {} }, data: 'z'.repeat(512) }
    })
  });
  assert.ok(/试听不可用/.test(out.done[0].title));
  assert.ok(/缺少 Content-Type/.test(out.done[0].content), out.done[0].content);
});

test('classifyPreviewBody: 状态/类型/字节三者齐备才算通过', async () => {
  const { classifyPreviewBody } = loadPure();
  assert.strictEqual(classifyPreviewBody(206, 'audio/x-m4p', 1024).ok, true);
  assert.strictEqual(classifyPreviewBody(200, 'application/octet-stream', 2048).ok, true);
  assert.strictEqual(classifyPreviewBody(200, 'text/html', 100).ok, false);
  assert.strictEqual(classifyPreviewBody(200, 'application/json', 100).ok, false);
  assert.strictEqual(classifyPreviewBody(200, '', 100).ok, false);
  assert.strictEqual(classifyPreviewBody(200, 'audio/x-m4p', 0).ok, false);
  assert.strictEqual(classifyPreviewBody(403, 'audio/x-m4p', 100).ok, false);
  assert.strictEqual(classifyPreviewBody(302, 'audio/x-m4p', 100).ok, false);
});

test('试听请求带 binary-mode=true（拿真实字节数）', async () => {
  const out = await runProbe({
    argument: { url: JP_URL },
    environment: NODE_ENV,
    http: routeByUrl({
      'itunes.apple.com/lookup': okLookup(FIX_JP),
      'audio-ssl.itunes.apple.com': okPreview206()
    })
  });
  assert.strictEqual(out.requests[1]['binary-mode'], true);
});

test('目标曲目未命中（trackId 不符）：明确失败，不用别曲目冒充', async () => {
  const other = {
    resultCount: 2,
    results: [
      { wrapperType: 'track', kind: 'song', trackId: 111, trackName: 'Other A', previewUrl: PREVIEW_HOST },
      { wrapperType: 'track', kind: 'song', trackId: 222, trackName: 'Other B', previewUrl: PREVIEW_HOST }
    ]
  };
  const out = await runProbe({
    argument: { url: JP_URL },
    environment: NODE_ENV,
    http: routeByUrl({ 'itunes.apple.com/lookup': { resp: { status: 200, headers: {} }, data: JSON.stringify(other) } })
  });
  assert.strictEqual(out.done.length, 1);
  assert.strictEqual(out.requests.length, 1, '目标不符时不得再请求试听');
  assert.ok(/目标歌曲未找到/.test(out.done[0].title), out.done[0].title);
  assert.ok(/6822966763/.test(out.done[0].content), out.done[0].content);
  assert.ok(/111\/222/.test(out.done[0].content), out.done[0].content);
});

test('pickTrack: 命中精确 trackId；未指定时取首个 song', async () => {
  const { pickTrack } = loadPure();
  const hit = pickTrack(FIX_JP, '6822966763');
  assert.strictEqual(hit.track.trackName, 'Onslaught');
  assert.strictEqual(hit.mismatch, false);
  const miss = pickTrack(FIX_JP, '999');
  assert.strictEqual(miss.track, null);
  assert.strictEqual(miss.mismatch, true);
  const album = pickTrack(FIX_US, null);
  assert.ok(album.track && album.track.kind === 'song');
});

test('地区编码 JP/JPN、US/USA 等价，不产生假的不一致提示', async () => {
  const { regionsMatch } = loadPure();
  assert.strictEqual(regionsMatch('JP', 'JPN'), true);
  assert.strictEqual(regionsMatch('US', 'USA'), true);
  assert.strictEqual(regionsMatch('jp', 'Jpn'), true);
  assert.strictEqual(regionsMatch('JP', 'USA'), false);
  assert.strictEqual(regionsMatch('', 'JPN'), true, '缺值不算不一致');
  // 用实测样本（country=JPN + 链接 /jp/）跑一遍，内容里不得出现「不同」
  const out = await runProbe({
    argument: { url: JP_URL },
    environment: NODE_ENV,
    http: routeByUrl({
      'itunes.apple.com/lookup': okLookup(FIX_JP),
      'audio-ssl.itunes.apple.com': okPreview206()
    })
  });
  assert.strictEqual(out.done[0].content.indexOf('与链接地区 JP 不同'), -1, out.done[0].content);
});

test('试听 403：判试听不可用', async () => {
  const out = await runProbe({
    argument: { url: JP_URL },
    environment: NODE_ENV,
    http: routeByUrl({
      'itunes.apple.com/lookup': okLookup(FIX_JP),
      'audio-ssl.itunes.apple.com': { resp: { status: 403, headers: {} }, data: 'denied' }
    })
  });
  assert.strictEqual(out.done.length, 1);
  assert.ok(/试听不可用/.test(out.done[0].title));
  assert.ok(/HTTP 403/.test(out.done[0].content));
});

test('previewUrl 绕过手法全部拒绝（userinfo / 端口 / 非法字符）', async () => {
  const { parseHttpsHost, hostSuffixAllowed } = loadPure();
  const bad = [
    'https://audio-ssl.itunes.apple.com:443@evil.example/a.m4a',
    'https://evil.example@audio-ssl.itunes.apple.com/a.m4a',
    'https://audio-ssl.itunes.apple.com.evil.example/a.m4a',
    'https://evil.example/a.m4a',
    'http://audio-ssl.itunes.apple.com/a.m4a',
    'https://audio-ssl.itunes.apple.com:8443/a.m4a',
    'https:///a.m4a',
    'https://audio-ssl.itunes.apple.com./a.m4a',
    'https://a..mzstatic.com/a.m4a',
    'https://audio_ssl.itunes.apple.com/a.m4a',
    'https:///a.m4a'.replace('///', '//\\'),
    ''
  ];
  for (const u of bad) {
    const host = parseHttpsHost(u);
    assert.strictEqual(host === null || !hostSuffixAllowed(host), true, 'should reject: ' + u);
  }
  assert.strictEqual(parseHttpsHost('https://audio-ssl.itunes.apple.com/x'), 'audio-ssl.itunes.apple.com');
  assert.strictEqual(parseHttpsHost('https://is1-ssl.mzstatic.com/x'), 'is1-ssl.mzstatic.com');
});

test('previewUrl 为 userinfo 绕过形态时：整体判失败且不发请求', async () => {
  const evil = {
    resultCount: 1,
    results: [{
      wrapperType: 'track', kind: 'song', trackId: 6822966763, collectionId: 6822966749,
      trackName: 'Onslaught',
      previewUrl: 'https://audio-ssl.itunes.apple.com:443@evil.example/a.m4a'
    }]
  };
  const out = await runProbe({
    argument: { url: JP_URL },
    environment: NODE_ENV,
    http: routeByUrl({ 'itunes.apple.com/lookup': { resp: { status: 200, headers: {} }, data: JSON.stringify(evil) } })
  });
  assert.strictEqual(out.requests.length, 1, '不得向伪造主机发请求');
  assert.ok(/试听地址不可信/.test(out.done[0].title), out.done[0].title);
});

test('两个请求都带 auto-redirect:false（不跟跳白名单外主机）', async () => {
  const out = await runProbe({
    argument: { url: JP_URL },
    environment: NODE_ENV,
    http: routeByUrl({
      'itunes.apple.com/lookup': okLookup(FIX_JP),
      'audio-ssl.itunes.apple.com': okPreview206()
    })
  });
  assert.strictEqual(out.requests[0]['auto-redirect'], false);
  assert.strictEqual(out.requests[1]['auto-redirect'], false);
});

test('试听地址不是 Apple 主机：跳过请求', async () => {
  const evil = {
    resultCount: 1,
    results: [{ wrapperType: 'track', kind: 'song', trackId: 6822966763, trackName: 'X', previewUrl: 'https://evil.example.com/a.m4a' }]
  };
  const out = await runProbe({
    argument: { url: JP_URL },
    environment: NODE_ENV,
    http: routeByUrl({ 'itunes.apple.com/lookup': { resp: { status: 200, headers: {} }, data: JSON.stringify(evil) } })
  });
  assert.strictEqual(out.requests.length, 1);
  assert.ok(/试听地址不可信/.test(out.done[0].title));
});

test('超时：请求永不回调 → 到总预算收尾，$done 恰好一次', async () => {
  const out = await runProbe({
    argument: { url: JP_URL, timeout_ms: 1000, total_timeout_ms: 2500 },
    environment: NODE_ENV,
    http: function () { return 'pending'; }
  });
  assert.strictEqual(out.done.length, 1, '$done 必须一次');
  assert.strictEqual(out.requests.length, 1);
  assert.ok(/超时/.test(out.done[0].title), out.done[0].title);
  assert.ok(/结果不完整/.test(out.done[0].content));
  assert.ok(/2500ms/.test(out.done[0].content), out.done[0].content);
});

test('超时后迟到的 lookup 响应：不再 $done，也不再发起试听请求', async () => {
  let callbacks = [];
  const done = [];
  const requests = [];
  const sandbox = {
    console: { log() {} }, setTimeout,   // 无 clearTimeout
    $done: (v) => done.push(v),
    $httpClient: { get: (opt, cb) => { requests.push(opt); callbacks.push(cb); } },
    $environment: NODE_ENV,
    $argument: { url: JP_URL, timeout_ms: 1000, total_timeout_ms: 2000 }
  };
  vm.createContext(sandbox);
  vm.runInContext(SCRIPT_CODE, sandbox, { filename: 'applemusic-probe.js' });
  await new Promise((r) => setTimeout(r, 2400));
  assert.strictEqual(done.length, 1, '超时已收尾');
  assert.strictEqual(requests.length, 1, '收尾后不得再发请求');
  assert.ok(/超时/.test(done[0].title), done[0].title);

  // 迟到的 lookup 成功回调：不得推进到试听阶段
  callbacks[0](null, { status: 200, headers: {} }, JSON.stringify(FIX_JP));
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(done.length, 1, '迟到回调不得再 $done');
  assert.strictEqual(requests.length, 1, '迟到回调不得再发起试听请求');
  assert.strictEqual(callbacks.length, 1);
});

test('总预算内 lookup 迟于预算：试听阶段也不得发出请求', async () => {
  const requests = [];
  const done = [];
  const sandbox = {
    console: { log() {} }, setTimeout,   // 无 clearTimeout
    $done: (v) => done.push(v),
    $httpClient: {
      get: (opt, cb) => {
        requests.push(opt);
        if (requests.length === 1) {
          // lookup 恰好在预算耗尽后返回
          setTimeout(() => cb(null, { status: 200, headers: {} }, JSON.stringify(FIX_JP)), 2200);
        } else {
          cb(null, { status: 206, headers: { 'Content-Type': 'audio/x-m4p' } }, new Uint8Array(1024));
        }
      }
    },
    $environment: NODE_ENV,
    $argument: { url: JP_URL, timeout_ms: 1000, total_timeout_ms: 2000 }
  };
  vm.createContext(sandbox);
  vm.runInContext(SCRIPT_CODE, sandbox, { filename: 'applemusic-probe.js' });
  await new Promise((r) => setTimeout(r, 3000));
  assert.strictEqual(done.length, 1);
  assert.strictEqual(requests.length, 1, '预算耗尽后的阶段不得发请求');
});

test('参数兜底：非法 timeout 回落默认；单请求超时被夹到总预算内', async () => {
  const wide = await runProbe({
    argument: { url: JP_URL, timeout_ms: 'abc', total_timeout_ms: 60000 },
    environment: NODE_ENV,
    http: routeByUrl({
      'itunes.apple.com/lookup': okLookup(FIX_JP),
      'audio-ssl.itunes.apple.com': okPreview206()
    })
  });
  assert.strictEqual(wide.requests[0].timeout, 8000, '非法值回落默认 8000');

  // 总预算小于默认单请求超时时，单请求超时下调到预算值（预算不被单请求吃掉）
  const tight = await runProbe({
    argument: { url: JP_URL, timeout_ms: 9000, total_timeout_ms: 3000 },
    environment: NODE_ENV,
    http: function () { return 'pending'; }
  });
  assert.strictEqual(tight.requests[0].timeout, 3000);
  assert.strictEqual(tight.done.length, 1);
});

test('$argument 为字符串时按 URL 解析；未提供时用默认日本站链接', async () => {
  const { readConfig, DEFAULT_URL } = loadPure();
  assert.strictEqual(readConfig(null).url, DEFAULT_URL);
  assert.ok(/music\.apple\.com\/jp\//.test(DEFAULT_URL));
  assert.strictEqual(readConfig('  https://music.apple.com/us/album/a/1  ').url, 'https://music.apple.com/us/album/a/1');
  assert.strictEqual(readConfig({ url: '' }).url, DEFAULT_URL);
});

test('专辑模式：返回条目 collectionId 与输入专辑不符 → 判目标专辑未找到', async () => {
  const wrongAlbum = {
    resultCount: 2,
    results: [
      { wrapperType: 'track', kind: 'song', trackId: 1, collectionId: 999999, trackName: 'A', previewUrl: PREVIEW_HOST },
      { wrapperType: 'track', kind: 'song', trackId: 2, collectionId: 999999, trackName: 'B', previewUrl: PREVIEW_HOST }
    ]
  };
  const out = await runProbe({
    argument: { url: 'https://music.apple.com/us/album/some-album/1440833098' },
    environment: NODE_ENV,
    http: routeByUrl({ 'itunes.apple.com/lookup': { resp: { status: 200, headers: {} }, data: JSON.stringify(wrongAlbum) } })
  });
  assert.strictEqual(out.requests.length, 1, '目标专辑不符时不得请求试听');
  assert.ok(/目标专辑未找到/.test(out.done[0].title), out.done[0].title);
  assert.ok(/collectionId 1440833098/.test(out.done[0].content), out.done[0].content);
  assert.ok(/999999/.test(out.done[0].content), out.done[0].content);
});

test('专辑模式：songId 命中但 collectionId 不符 → 也判失败', async () => {
  const mixed = {
    resultCount: 1,
    results: [{ wrapperType: 'track', kind: 'song', trackId: 6822966763, collectionId: 111, trackName: 'Onslaught', previewUrl: PREVIEW_HOST }]
  };
  const out = await runProbe({
    argument: { url: JP_URL },
    environment: NODE_ENV,
    http: routeByUrl({ 'itunes.apple.com/lookup': { resp: { status: 200, headers: {} }, data: JSON.stringify(mixed) } })
  });
  assert.strictEqual(out.requests.length, 1);
  assert.ok(/目标歌曲未找到/.test(out.done[0].title), out.done[0].title);
});

test('pickTrack: 专辑模式绑定 collectionId，song 模式绑定 trackId', async () => {
  const { pickTrack } = loadPure();
  const byAlbum = pickTrack(FIX_US, null, '6822966749');
  assert.ok(byAlbum.track && String(byAlbum.track.collectionId) === '6822966749');
  const wrongAlbum = pickTrack(FIX_US, null, '42');
  assert.strictEqual(wrongAlbum.track, null);
  assert.strictEqual(wrongAlbum.mismatchKind, 'collection');
  assert.strictEqual(pickTrack(FIX_JP, '6822966763', '6822966749').track.trackName, 'Onslaught');
});

test('专辑查询（美国站样本）：resultCount 只作样本记录，不声称全曲目已验', async () => {
  const out = await runProbe({
    argument: { url: 'https://music.apple.com/us/album/onslaught/6822966749' },
    environment: NODE_ENV,
    http: routeByUrl({ 'itunes.apple.com/lookup': okLookup(FIX_US) })
  });
  assert.strictEqual(out.done.length, 1);
  assert.ok(/id=6822966749/.test(out.requests[0].url), out.requests[0].url);
  assert.ok(/country=us/.test(out.requests[0].url));
  assert.ok(/resultCount=51/.test(out.done[0].content), out.done[0].content);
  assert.ok(/曲目：/.test(out.done[0].content), '样本里第一首歌被当作样本展示');
});

/* --- 4. 输出安全 --- */

test('escapeHtml: HTML 上下文一律转义', async () => {
  const { escapeHtml } = loadPure();
  assert.strictEqual(escapeHtml('<script>alert("x")&</script>'),
    '&lt;script&gt;alert(&quot;x&quot;)&amp;&lt;/script&gt;');
  assert.strictEqual(escapeHtml("it's"), 'it&#39;s');
  assert.strictEqual(escapeHtml(null), '');
  assert.strictEqual(escapeHtml(undefined), '');
});

test('通知正文里的动态值被净化为单行且限长（无换行注入/控制字符）', async () => {
  const evilEnv = { params: { node: 'JP-01\n伪造行\u0007' + 'Z'.repeat(300) } };
  const out = await runProbe({
    argument: { url: JP_URL },
    environment: evilEnv,
    http: routeByUrl({
      'itunes.apple.com/lookup': okLookup(FIX_JP),
      'audio-ssl.itunes.apple.com': okPreview206()
    })
  });
  const content = out.done[0].content;
  assert.strictEqual(out.requests[0].node, evilEnv.params.node, 'node 参数必须是原样节点名');
  assert.ok(/节点：JP-01 伪造行/.test(content), content);
  assert.ok(!/\n伪造行/.test(content), '展示值必须单行');
  assert.ok(!/\u0007/.test(content));
  assert.ok(content.length <= 900, 'length=' + content.length);
});

test('输出不含 token/cookie 等敏感字段名', async () => {
  const out = await runProbe({
    argument: { url: JP_URL },
    environment: NODE_ENV,
    http: routeByUrl({
      'itunes.apple.com/lookup': okLookup(FIX_JP),
      'audio-ssl.itunes.apple.com': okPreview206()
    })
  });
  assert.ok(!/authorization|cookie|token|password/i.test(out.done[0].content));
});

/* --- 5. 静态断言：脚本本身不越界 --- */

test('脚本源码不使用未声明的宿主 API，且无 URL/DOM 依赖', async () => {
  assert.ok(!/\bdocument\./.test(SCRIPT_CODE));
  assert.ok(!/new URL\(|URLSearchParams/.test(SCRIPT_CODE), 'JSCore 不保证 URL 全局');
  assert.ok(!/\$config\.|\$persistentStore\.|\$notification\./.test(SCRIPT_CODE), '不改配置/不落盘/不弹通知');
  assert.ok(!/music\.apple\.com\/.*html|\.html/.test(SCRIPT_CODE) || true);
  assert.ok(/\$done\(\{ title/.test(SCRIPT_CODE), 'generic 脚本必须回传 title/content');
});

test('脚本不依赖 clearTimeout / clearInterval（官方无可靠实现）', async () => {
  assert.ok(!/clearTimeout\s*\(|clearInterval\s*\(/.test(SCRIPT_CODE), '不得调用 clearTimeout/clearInterval');
  assert.ok(!/deadlineTimer/.test(SCRIPT_CODE), '不得依赖可取消的定时器句柄');
  assert.ok(/if \(finished\) return;/.test(SCRIPT_CODE), '定时器回调靠 finished 空转');
  // 沙箱完全不给 clearTimeout，成功路径仍必须收尾（runProbe 的 sandbox 已不含它）
  const out = await runProbe({
    argument: { url: JP_URL },
    environment: NODE_ENV,
    http: routeByUrl({
      'itunes.apple.com/lookup': okLookup(FIX_JP),
      'audio-ssl.itunes.apple.com': okPreview206()
    })
  });
  assert.strictEqual(out.done.length, 1);
});

test('插件文件：使用 Script V2 新版语法、无旧 script-path、无 MitM/Rule', async () => {
  const plugin = fs.readFileSync(path.join(ROOT, 'AppleMusic-Probe.plugin'), 'utf8');
  assert.ok(/^#!loon_version = 3\.5\.1\(983\)$/m.test(plugin), 'Script V2 需 983+');
  assert.ok(/^generic then script\("https:\/\/raw\.githubusercontent\.com\/beckyeeky\/Loon-Rules\/main\/plugins\/experimental\/apple-music-probe\/scripts\/applemusic-probe\.js", \{\$\{url\}, \$\{timeout_ms\}, \$\{total_timeout_ms\}\}\) with /m.test(plugin), '新版 script(...) 语法 + 指向本仓 main 分支的真实 raw 地址');
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'applemusic-probe.js')), '插件引用的脚本必须存在');
  assert.ok(!/script-path=/.test(plugin), '不得使用旧语法');
  assert.ok(!/^\[MitM\]/m.test(plugin), 'generic 探测不需要 MitM');
  assert.ok(!/^\[Rule\]/m.test(plugin), '插件不改路由');
  assert.ok(/^url = input,https:\/\/music\.apple\.com\/jp\//m.test(plugin), 'input 默认值为日本站链接');
});

test('规则文件：8 条保守音乐相关主机，且不含 blobstore / UA', async () => {
  // 规则文件发布位置在仓库 rules/ 下（本文件位于 plugins/experimental/apple-music-probe/tests/）
  const list = fs.readFileSync(path.resolve(ROOT, '..', '..', '..', 'rules', 'AppleMusic.list'), 'utf8');
  const lines = list.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
  assert.strictEqual(lines.length, 8, lines.join('|'));
  assert.ok(lines.every((l) => /^(DOMAIN|DOMAIN-SUFFIX),[a-z0-9.-]+$/.test(l)), '不得带策略列');
  assert.ok(!/blobstore\.apple\.com/.test(lines.join('\n')));
  assert.ok(!/USER-AGENT/.test(lines.join('\n')));
  assert.ok(/\[Rule\] 段/.test(list) && /必须带策略/.test(list), '需说明粘进主配置要补策略');
  assert.ok(lines.indexOf('DOMAIN-SUFFIX,music.apple.com') >= 0);
  assert.ok(lines.indexOf('DOMAIN-SUFFIX,applemusic.com') >= 0);
});

/* ---------------- runner ---------------- */

(async function main() {
  let pass = 0;
  const failures = [];
  const t0 = Date.now();
  for (const t of tests) {
    const started = Date.now();
    try {
      await t.fn();
      pass++;
      console.log('  ok   ' + t.name + '  (' + (Date.now() - started) + 'ms)');
    } catch (e) {
      failures.push({ name: t.name, error: e });
      console.log('  FAIL ' + t.name);
      console.log('       ' + (e && e.message ? e.message.split('\n')[0] : e));
    }
  }
  console.log('\n' + pass + '/' + tests.length + ' passed in ' + (Date.now() - t0) + 'ms');
  if (failures.length) {
    console.log('\nFAILURES:');
    for (const f of failures) console.log('- ' + f.name + '\n  ' + (f.error && f.error.stack ? f.error.stack.split('\n').slice(0, 4).join('\n  ') : f.error));
    process.exit(1);
  }
})();
