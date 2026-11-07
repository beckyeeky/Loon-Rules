/**
 * applemusic-probe.js — Loon Script V2 · generic（手动触发，只读探测）
 *
 * 用途
 *   在 Loon「节点 / 策略」页长按某个节点 → 菜单里选择本项，脚本用「该节点」去请求
 *   Apple 公开的 iTunes lookup API 与试听(preview)资源，报告两件事：
 *     ① 目录查询（itunes.apple.com/lookup JSON）是否成功、是否含 previewUrl；
 *     ② 试听资源的 HTTP 可达性（Range 小段请求，最多 1 次）。
 *   不修改请求/响应、不切换策略组、不写入持久化存储。
 *
 * 依据（官方文档）
 *   - generic + script(...) + with：https://nsloon.app/docs/Script/script_v2
 *     路径可为「本地文件、相对路径或远程 URL」；`generic then script("tool.js")` 即手动触发。
 *   - $environment.params.node / nodeInfo：https://nsloon.app/docs/Script/script_api §3.4
 *     params.node 为「节点名称；旧版本字段」，params.nodeInfo 为「节点简要信息，不包含密码等敏感字段」。
 *   - $httpClient.get({url, timeout, headers, node, ...})：同上 §7.2，
 *     node 可填「DIRECT、节点描述、节点名称或策略组」。
 *
 * 未验证（勿当成已确认行为）
 *   - $environment.params.nodeInfo 的真机结构（可能是字符串，也可能是对象/其它形态）。
 *     本脚本只在字符串或对象的若干常见字段名里做尽力提取，并在报告里标注来源。
 *   - node 名称与 Loon 内部节点名的匹配规则（是否支持备注名/描述、重名时取哪个）。
 *   - 相对路径脚本在「导入插件」后的解析目录（官方只说沿用现有本地/远程逻辑）。
 *   - 报告只覆盖「目录 JSON」与「试听首段 HTTP」，不覆盖完整播放、授权、DRM、地区解锁。
 *
 * 不收集任何 token / Cookie / 账号信息；报告只含节点名、ID、曲名、状态码、字节数。
 */

var DEFAULT_URL = 'https://music.apple.com/jp/album/onslaught/6822966749?i=6822966763&l=en-US';
var ALLOWED_HOST = 'music.apple.com';
var LOOKUP_ENDPOINT = 'https://itunes.apple.com/lookup';
var PREVIEW_RANGE = 'bytes=0-1023';
var PREVIEW_MAX_REQUESTS = 1;          // 只探 1 次试听资源，避免重复下载
var DEFAULT_REQUEST_TIMEOUT_MS = 8000; // 单请求超时（$httpClient.timeout）
var DEFAULT_TOTAL_TIMEOUT_MS = 20000;  // 脚本总预算，到点立即 $done（防挂死）
var MAX_CONTENT_CHARS = 900;           // 通知正文长度上限
var PREVIEW_HOST_SUFFIXES = ['itunes.apple.com', 'mzstatic.com'];

/* ------------------------------------------------------------------ *
 * 纯函数工具（可单测）
 * ------------------------------------------------------------------ */

/** HTML 安全转义：仅用于把不受信内容放进 HTML 上下文的场景（如粘贴到网页/日志查看器）。 */
function escapeHtml(input) {
  return String(input == null ? '' : input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 单行文本净化：删除控制字符、折叠空白、限长。用于通知正文里的动态值。 */
function sanitizeInline(input, maxLen) {
  var s = String(input == null ? '' : input);
  s = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  var limit = typeof maxLen === 'number' && maxLen > 0 ? maxLen : 80;
  if (s.length > limit) s = s.slice(0, limit - 1) + '…';
  return s;
}

function truncate(text, max) {
  var s = String(text == null ? '' : text);
  if (max && s.length > max) return s.slice(0, max - 1) + '…';
  return s;
}

function toPositiveInt(value, fallback, min, max) {
  var n = typeof value === 'number' ? value : Number(String(value == null ? '' : value).trim());
  if (!isFinite(n) || n <= 0) return fallback;
  n = Math.round(n);
  if (typeof min === 'number' && n < min) n = min;
  if (typeof max === 'number' && n > max) n = max;
  return n;
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return null;
  var want = String(name).toLowerCase();
  var keys = Object.keys(headers);
  for (var i = 0; i < keys.length; i++) {
    if (String(keys[i]).toLowerCase() === want) return headers[keys[i]];
  }
  return null;
}

/**
 * 地区编码比较：链接给 2 字母（JP/US），iTunes 条目 country 给 3 字母（JPN/USA）。
 * 二者等价，不能当成「地区不一致」。仅在同一前缀意义下判等。
 */
function regionsMatch(a, b) {
  var x = String(a == null ? '' : a).toUpperCase().trim();
  var y = String(b == null ? '' : b).toUpperCase().trim();
  if (!x || !y) return true;            // 缺值不构成不一致证据
  if (x === y) return true;
  var shorter = x.length <= y.length ? x : y;
  var longer = x.length <= y.length ? y : x;
  if (shorter.length < 2) return false;
  return longer.indexOf(shorter) === 0;  // JP⊂JPN、US⊂USA
}

/**
 * 严格校验一个 https URL 的 authority，返回 host（小写）或 null。
 * 拒绝：非 https、含 userinfo(@)、显式端口（避免 host:443@evil 之类绕过）、
 * 非法字符、空 host、首尾点、连续点。
 */
function parseHttpsHost(url) {
  var m = /^https:\/\/([^\/?#]*)([\/?#]|$)/i.exec(String(url == null ? '' : url));
  if (!m) return null;
  var authority = m[1];
  if (!authority) return null;
  if (authority.indexOf('@') >= 0) return null;          // userinfo 一律拒绝
  if (authority.indexOf(':') >= 0) return null;          // 显式端口一律拒绝
  if (authority.indexOf('\\') >= 0) return null;
  if (!/^[A-Za-z0-9.-]+$/.test(authority)) return null;
  var host = authority.toLowerCase();
  if (host.charAt(0) === '.' || host.charAt(host.length - 1) === '.') return null;
  if (host.indexOf('..') >= 0) return null;
  return host;
}

function hostSuffixAllowed(host) {
  for (var i = 0; i < PREVIEW_HOST_SUFFIXES.length; i++) {
    var suf = PREVIEW_HOST_SUFFIXES[i];
    if (host === suf || host.slice(-(suf.length + 1)) === '.' + suf) return true;
  }
  return false;
}

/**
 * 解析 Apple Music 链接。不依赖 URL 全局对象（JSCore 里不保证存在），全部用正则 + 字符串切分。
 * 返回 { ok, country, kind, songId, albumId, lookupId, reason }
 */
function parseTargetUrl(input) {
  var original = String(input == null ? '' : input);
  if (/[\u0000-\u001f\u007f]/.test(original)) {
    // 控制字符（含换行）可能被用于拆分/注入请求头，直接拒绝；普通首尾空格允许
    return { ok: false, reason: '探测链接包含控制字符（含换行/制表符）' };
  }
  var raw = original.trim();
  if (!raw) return { ok: false, reason: '探测链接为空' };
  if (raw.length > 2048) return { ok: false, reason: '探测链接过长（>2048 字符）' };
  if (/\s/.test(raw)) return { ok: false, reason: '探测链接包含空白字符' };

  var m = /^https:\/\/([^\/?#]+)([^?#]*)(\?[^#]*)?(#[\s\S]*)?$/i.exec(raw);
  if (!m) return { ok: false, reason: '仅支持以 https:// 开头的链接' };

  var authority = m[1];
  if (authority.toLowerCase() !== ALLOWED_HOST) {
    // 故意用全等比较：拒绝 music.apple.com:443（显式端口）、user@music.apple.com、music.apple.com.evil.com
    return { ok: false, reason: '仅允许官方 ' + ALLOWED_HOST + ' 主机，实际为「' + sanitizeInline(authority, 60) + '」' };
  }

  var path = m[2] || '';
  var query = m[3] || '';
  var parts = path.split('/').filter(function (s) { return s.length > 0; });

  var country = null;
  if (parts.length && /^[a-z]{2}$/i.test(parts[0])) country = parts.shift().toUpperCase();
  if (!country) return { ok: false, reason: '链接缺少地区代码（应为 /jp/ 这类两字母段）' };

  var kind = String(parts.shift() || '').toLowerCase();
  if (kind !== 'album' && kind !== 'song') {
    return { ok: false, reason: '仅支持 /<地区>/album/... 或 /<地区>/song/... 链接' };
  }

  var pathId = null;
  for (var i = parts.length - 1; i >= 0; i--) {
    if (/^\d{1,20}$/.test(parts[i])) { pathId = parts[i]; break; }
  }
  if (!pathId) return { ok: false, reason: '链接路径中未找到数字 ID' };

  var querySongId = null;
  if (query) {
    var pairs = query.slice(1).split('&');
    for (var j = 0; j < pairs.length; j++) {
      var eq = pairs[j].indexOf('=');
      if (eq <= 0) continue;
      var key = pairs[j].slice(0, eq);
      var val = pairs[j].slice(eq + 1);
      if (key === 'i' && /^\d{1,20}$/.test(val)) querySongId = val;
    }
  }

  // 规则：?i= 指定的歌曲 ID 优先；否则 /song/ 路径 ID 视为歌曲 ID；/album/ 路径 ID 作为专辑 ID。
  var songId = querySongId;
  var albumId = null;
  if (kind === 'album') {
    albumId = pathId;
  } else if (!songId) {
    songId = pathId;
  }

  var lookupId = songId || albumId;
  if (!lookupId) return { ok: false, reason: '未能从链接确定可查询的 ID' };

  return {
    ok: true,
    country: country,
    kind: kind,
    songId: songId,
    albumId: albumId,
    lookupId: lookupId,
    reason: ''
  };
}

/**
 * 取被测节点名。只认官方 Script API §3.4 明确写明的 `$environment.params.node`
 * （「节点名称；旧版本字段」）。`nodeInfo` 的字段结构官方只描述为「节点简要信息」，
 * 本仓未在真机核实其键名，**不做任何猜测式提取**：宁可停止，也不用错节点出网。
 * 返回 { name, source, candidates, nodeInfoPresent }
 */
function resolveNode(environment) {
  var params = (environment && environment.params) || {};
  var raw = typeof params.node === 'string' ? params.node : '';
  // 路由必须用「原样」节点名：不能折叠空格、不能截断，否则可能指向另一个节点或匹配失败。
  // name 用于 $httpClient 的 node 参数；display 仅用于输出，做单行净化与限长。
  var routing = raw !== '' && raw.trim() !== '' ? raw : '';
  return {
    name: routing || null,
    display: routing ? sanitizeInline(routing, 120) : null,
    source: routing ? '$environment.params.node' : null,
    nodeInfoPresent: params.nodeInfo != null && params.nodeInfo !== ''
  };
}

/** 读取 [Argument] 注入的 $argument。字符串视作 URL；对象取 url / timeout_ms / total_timeout_ms。 */
function readConfig(argument) {
  var cfg = {
    url: DEFAULT_URL,
    urlSource: '默认值',
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    totalTimeoutMs: DEFAULT_TOTAL_TIMEOUT_MS
  };
  if (argument == null) return cfg;

  if (typeof argument === 'string') {
    var text = argument.trim();
    if (text) { cfg.url = text; cfg.urlSource = '$argument 字符串'; }
    return cfg;
  }

  if (typeof argument === 'object') {
    if (typeof argument.url === 'string' && argument.url.trim()) {
      cfg.url = argument.url.trim();
      cfg.urlSource = '$argument.url';
    }
    cfg.requestTimeoutMs = toPositiveInt(argument.timeout_ms, DEFAULT_REQUEST_TIMEOUT_MS, 1000, 60000);
    cfg.totalTimeoutMs = toPositiveInt(argument.total_timeout_ms, DEFAULT_TOTAL_TIMEOUT_MS, 2000, 120000);
    // 单请求超时不得吃掉整份预算：预算更小时下调单请求超时（保留用户设定的总预算）
    if (cfg.totalTimeoutMs < cfg.requestTimeoutMs) cfg.requestTimeoutMs = cfg.totalTimeoutMs;
  }
  return cfg;
}

/**
 * 从 lookup JSON 里挑出**目标**条目，两种模式都要绑定 ID：
 *   - 有 songId（?i= 或 /song/）：只有 trackId 完全相同的条目才算命中；
 *   - 只有 albumId（专辑链接）：只有 collectionId 与输入专辑相同的歌曲条目才算命中。
 * 不满足时 track=null + mismatch=true，**绝不**用返回的其它条目冒充目标。
 * 返回 { track, mismatch, mismatchKind, returnedIds, returnedCollectionIds }
 */
function pickTrack(payload, wantSongId, wantCollectionId) {
  var out = {
    track: null, mismatch: false, mismatchKind: null,
    returnedIds: [], returnedCollectionIds: []
  };
  if (!payload || typeof payload !== 'object') return out;
  var results = payload.results;
  if (!results || typeof results.length !== 'number' || results.length === 0) return out;

  var songs = [];
  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    if (!r || typeof r !== 'object') continue;
    var kind = String(r.kind || '').toLowerCase();
    var wrapper = String(r.wrapperType || '').toLowerCase();
    if (wrapper !== 'track' && kind !== 'song') continue;
    songs.push(r);
    if (r.trackId != null && out.returnedIds.length < 3) out.returnedIds.push(String(r.trackId));
    if (r.collectionId != null && out.returnedCollectionIds.length < 3 &&
        out.returnedCollectionIds.indexOf(String(r.collectionId)) < 0) {
      out.returnedCollectionIds.push(String(r.collectionId));
    }
  }
  if (!songs.length) return out;

  if (wantSongId) {
    var wantTrack = String(wantSongId);
    for (var k = 0; k < songs.length; k++) {
      if (String(songs[k].trackId) === wantTrack) {
        // 歌曲命中后，若链接同时给出专辑 ID，再校一次归属（防止同名/异构条目）
        if (wantCollectionId) {
          var cid = songs[k].collectionId;
          if (cid != null && String(cid) !== String(wantCollectionId)) {
            out.mismatch = true;
            out.mismatchKind = 'song-collection';   // 歌曲命中但专辑归属不符
            return out;
          }
        }
        out.track = songs[k];
        return out;
      }
    }
    out.mismatch = true;
    out.mismatchKind = 'song';
    return out;
  }

  if (wantCollectionId) {
    var wantCol = String(wantCollectionId);
    for (var m = 0; m < songs.length; m++) {
      if (songs[m].collectionId != null && String(songs[m].collectionId) === wantCol) {
        out.track = songs[m];
        return out;
      }
    }
    out.mismatch = true;
    out.mismatchKind = 'collection';
    return out;
  }

  // 既无 songId 也无 albumId（理论上不会走到）：取第一条，仅作样本
  out.track = songs[0];
  return out;
}

/**
 * 判定试听响应是否可用：HTTP 状态 + 内容类型 + 实际字节数三者都要过。
 * 200 而 body 是 HTML/JSON（典型是错误页、验证页）一律失败，不能只看状态码。
 */
var AUDIO_MIME_PREFIXES = ['audio/'];
var AUDIO_MIME_EXACT = ['application/octet-stream', 'application/mp4', 'video/mp4', 'binary/octet-stream'];
function classifyPreviewBody(status, contentType, byteLen) {
  var ct = contentType ? String(contentType).toLowerCase().split(';')[0].trim() : '';
  var looksAudio = false;
  for (var i = 0; i < AUDIO_MIME_PREFIXES.length; i++) {
    if (ct.indexOf(AUDIO_MIME_PREFIXES[i]) === 0) looksAudio = true;
  }
  for (var j = 0; j < AUDIO_MIME_EXACT.length; j++) {
    if (ct === AUDIO_MIME_EXACT[j]) looksAudio = true;
  }
  var looksHtmlOrJson = ct === 'text/html' || ct === 'application/xhtml+xml' ||
    ct === 'application/json' || ct === 'text/plain' || (ct.indexOf('text/') === 0);

  if (status !== 200 && status !== 206) {
    return { ok: false, code: 'status', text: 'HTTP ' + status };
  }
  if (!byteLen || byteLen <= 0) {
    return { ok: false, code: 'empty', text: 'HTTP ' + status + ' 但响应体为空，不能视为可用' };
  }
  if (looksHtmlOrJson) {
    return { ok: false, code: 'mime', text: 'HTTP ' + status + ' 但 Content-Type 为 ' + (ct || '未知') + '，疑似错误页/JSON，不是音频' };
  }
  if (!ct) {
    return { ok: false, code: 'mime-missing', text: 'HTTP ' + status + ' 但缺少 Content-Type，无法确认是音频（已收到 ' + byteLen + ' 字节）' };
  }
  if (!looksAudio) {
    return { ok: false, code: 'mime-unknown', text: 'HTTP ' + status + ' 但 Content-Type「' + ct + '」不是已知音频类型（已收到 ' + byteLen + ' 字节）' };
  }
  return {
    ok: true,
    code: status === 206 ? 'partial' : 'full',
    text: status === 206 ? 'HTTP 206 · ' + ct + ' · ' + byteLen + ' 字节（Range 生效）' : 'HTTP 200 · ' + ct + ' · ' + byteLen + ' 字节（服务器忽略 Range）'
  };
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

function run() {
  var finished = false;
  var ctx = {
    node: null,
    target: null,
    config: null,
    lookup: null,
    preview: null,
    notes: []
  };

  /**
   * 收尾。置 finished 后立即 $done；**不调用 clearTimeout**——官方 Script API §2.3 明确
   * 「运行时没有提供可靠的 clearTimeout 或 clearInterval 配套接口」。定时器到点后会因
   * finished 为真而空转返回。
   */
  function finish(title, content) {
    if (finished) return;
    finished = true;
    $done({ title: truncate(String(title || 'Apple Music 探测'), 120), content: truncate(String(content || ''), MAX_CONTENT_CHARS) });
  }

  function httpGet(options) {
    return new Promise(function (resolve) {
      if (finished) {
        // 总预算已用尽 / 已收尾：不得再发出任何网络请求（含迟到的后续阶段）
        resolve({ skipped: true, ok: false, error: '已收尾，未发起请求' });
        return;
      }
      var settled = false;
      function settle(result) {
        if (settled) return;
        settled = true;
        resolve(result);
      }
      try {
        $httpClient.get(options, function (err, resp, data) {
          if (err) { settle({ ok: false, error: sanitizeInline(err && err.message ? err.message : err, 120) }); return; }
          var status = 0;
          if (resp && typeof resp === 'object') {
            if (typeof resp.status === 'number') status = resp.status;
            else if (typeof resp.statusCode === 'number') status = resp.statusCode;
          }
          settle({ ok: true, status: status, headers: (resp && resp.headers) || {}, data: data });
        });
      } catch (e) {
        settle({ ok: false, error: '调用 $httpClient 异常：' + sanitizeInline(e && e.message, 120) });
      }
    });
  }

  function parseJsonBody(data) {
    if (data == null) return { ok: false, error: '响应体为空' };
    if (typeof data === 'object') return { ok: true, value: data };
    var text = String(data);
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (e) {
      return { ok: false, error: 'JSON 解析失败（前 40 字符：' + sanitizeInline(text, 40) + '）' };
    }
  }

  function render(status) {
    var lines = [];
    var nodeLabel = ctx.node && ctx.node.display ? ctx.node.display : '（无）';
    lines.push('节点：' + escapeForText(nodeLabel) + (ctx.node && ctx.node.source ? '（来源 ' + ctx.node.source + '）' : ''));

    if (ctx.target && ctx.target.ok) {
      var ids = ['链接地区 ' + ctx.target.country];
      if (ctx.target.songId) ids.push('songId ' + ctx.target.songId);
      if (ctx.target.albumId) ids.push('albumId ' + ctx.target.albumId);
      lines.push('入口：' + ids.join(' · '));
    }

    if (ctx.lookup) {
      var l = ctx.lookup;
      if (l.stage === 'error') {
        lines.push('① 目录查询：❌ ' + escapeForText(l.text));
      } else {
        lines.push('① 目录查询：' + (l.ok ? '✅' : '⚠️') + ' ' + escapeForText(l.text));
        if (l.track) {
          lines.push('   曲目：' + escapeForText(l.track));
        }
        if (l.trackIdNote) lines.push('   ' + escapeForText(l.trackIdNote));
        if (l.regionNote) lines.push('   ' + escapeForText(l.regionNote));
      }
    } else {
      lines.push('① 目录查询：未执行');
    }

    if (ctx.preview) {
      var p = ctx.preview;
      lines.push('② 试听 HTTP：' + (p.ok ? '✅' : '⚠️') + ' ' + escapeForText(p.text));
      if (p.detail) lines.push('   ' + escapeForText(p.detail));
    } else {
      lines.push('② 试听 HTTP：未执行' + (ctx.lookup && ctx.lookup.stage === 'done' && !ctx.lookup.hasPreview ? '（无 previewUrl）' : ''));
    }

    for (var i = 0; i < ctx.notes.length; i++) lines.push('· ' + escapeForText(ctx.notes[i]));
    lines.push('结论：' + status);
    return lines.join('\n');
  }

  // 已净化过的单行值；这里不再二次转义，保持通知可读。
  function escapeForText(v) {
    return sanitizeInline(v, 160);
  }

  /* 0) 节点必须先有 */
  ctx.config = readConfig(typeof $argument === 'undefined' ? null : $argument);
  var environment = typeof $environment === 'undefined' ? null : $environment;
  ctx.node = resolveNode(environment);

  if (!ctx.node.name) {
    finish('Apple Music 探测：未选择节点', [
      '未取到 $environment.params.node（官方唯一明确写明的节点名入口）。',
      ctx.node.nodeInfoPresent
        ? '入口提供了 nodeInfo，但其字段结构未经真机核实，本脚本不做猜测式提取，因此仍停止。'
        : '本次运行没有任何节点入口参数。',
      '为免用「当前默认路由」冒充被测节点，脚本已停止，未发出任何请求。',
      '请在 Loon 的节点/策略页长按目标节点后再选本脚本。',
      '（本脚本不修改任何配置，也不切换策略组。）'
    ].join('\n'));
    return;
  }

  /* 1) 链接必须先合法 */
  ctx.target = parseTargetUrl(ctx.config.url);
  if (!ctx.target.ok) {
    finish('Apple Music 探测：链接不可用', [
      '节点：' + escapeForText(ctx.node.display),
      '拒绝原因：' + escapeForText(ctx.target.reason),
      '仅接受 https://' + ALLOWED_HOST + '/<地区>/album|song/... 形式的官方链接。',
      '本次未发出任何网络请求。'
    ].join('\n'));
    return;
  }

  /* 2) 总预算：到点直接收尾，保证 $done 恰好一次 */
  setTimeout(function () {
    if (finished) return;   // 已收尾：空转，不做事（无 clearTimeout 可用）
    var partial = [];
    if (ctx.lookup && ctx.lookup.stage === 'done') partial.push('目录查询已完成');
    finish('Apple Music 探测：超时', render('未完成（总预算 ' + ctx.config.totalTimeoutMs + 'ms 用尽，结果不完整）') +
      (partial.length ? '\n（' + partial.join('，') + '）' : ''));
  }, ctx.config.totalTimeoutMs);

  var nodeOption = ctx.node.name;

  /* 3) iTunes lookup（公开目录 API，不请求 music.apple.com 网页 HTML） */
  var lookupUrl = LOOKUP_ENDPOINT + '?id=' + encodeURIComponent(ctx.target.lookupId) +
    '&country=' + encodeURIComponent(ctx.target.country.toLowerCase()) + '&entity=song';

  var startedAt = Date.now();
  httpGet({
    url: lookupUrl,
    node: nodeOption,
    timeout: ctx.config.requestTimeoutMs,
    headers: { 'Accept': 'application/json' },
    'auto-redirect': false
  }).then(function (res) {
    if (finished) return;          // 迟到回调：已 $done，不再推进后续阶段
    if (res.skipped) return;
    var elapsed = Date.now() - startedAt;
    if (!res.ok) {
      ctx.lookup = { stage: 'error', text: '请求失败：' + res.error };
      finish('Apple Music 探测：目录查询失败', render('目录查询失败，无法判定该节点可用性（未做重试，避免结果错配节点）'));
      return;
    }
    if (res.status < 200 || res.status > 299) {
      ctx.lookup = { stage: 'error', text: 'HTTP ' + res.status + '（' + elapsed + 'ms）' };
      finish('Apple Music 探测：目录查询失败', render('目录查询返回非 2xx，未做重试'));
      return;
    }

    var parsed = parseJsonBody(res.data);
    if (!parsed.ok) {
      ctx.lookup = { stage: 'error', text: parsed.error + '（HTTP ' + res.status + '）' };
      finish('Apple Music 探测：目录查询失败', render('HTTP 2xx 但响应不是可用 JSON，不能视为成功'));
      return;
    }

    var payload = parsed.value;
    var resultCount = payload && typeof payload.resultCount === 'number' ? payload.resultCount : null;
    var picked = pickTrack(payload, ctx.target.songId, ctx.target.albumId);
    var track = picked.track;

    if (resultCount !== null && resultCount <= 0) {
      ctx.lookup = { stage: 'done', ok: false, hasPreview: false, text: 'HTTP ' + res.status + ' · resultCount=0（' + elapsed + 'ms）' };
      ctx.notes.push('该地区目录查不到此 ID：可能是地区/上架状态差异，也可能是 ID 与地区不匹配。');
      finish('Apple Music 探测：目录为空', render('目录查询可达，但该地区返回 0 条结果，无法证明可播放'));
      return;
    }
    if (!track && picked.mismatch) {
      var isSongCase = picked.mismatchKind === 'song' || picked.mismatchKind === 'song-collection';
      var askedLabel = isSongCase ? 'trackId ' + ctx.target.songId : 'collectionId ' + ctx.target.albumId;
      if (picked.mismatchKind === 'song-collection') {
        askedLabel += ' + collectionId ' + ctx.target.albumId;
      }
      var gotLabel = isSongCase
        ? (picked.returnedIds.length ? picked.returnedIds.join('/') : '无 song 条目')
        : (picked.returnedCollectionIds.length ? picked.returnedCollectionIds.join('/') : '无匹配专辑');
      ctx.lookup = {
        stage: 'done', ok: false, hasPreview: false,
        text: 'HTTP ' + res.status + ' · 目标未找到（请求 ' + askedLabel + '，返回 ' + gotLabel + '）'
      };
      ctx.notes.push('已停止：不会用返回的其它' + (isSongCase ? '曲目' : '专辑') +
        '冒充目标。常见原因是 ID 与该地区目录不匹配（地区/上架差异）。');
      finish('Apple Music 探测：目标' + (isSongCase ? '歌曲' : '专辑') + '未找到',
        render('目录可达，但返回条目与请求的 ' + askedLabel.split(' ')[0] + ' 不一致，判定未通过，不继续试听'));
      return;
    }
    if (!track) {
      ctx.lookup = { stage: 'done', ok: false, hasPreview: false, text: 'HTTP ' + res.status + ' · 无歌曲条目（resultCount=' + (resultCount === null ? '未知' : resultCount) + '）' };
      finish('Apple Music 探测：目录无歌曲条目', render('目录可达但没有歌曲级条目，无法继续试听探测'));
      return;
    }

    var previewUrl = typeof track.previewUrl === 'string' ? track.previewUrl : '';
    var songName = (track.trackName || '') + (track.artistName ? ' — ' + track.artistName : '');
    ctx.lookup = {
      stage: 'done',
      ok: true,
      hasPreview: !!previewUrl,
      text: 'HTTP ' + res.status + ' · resultCount=' + (resultCount === null ? '?' : resultCount) + ' · ' + elapsed + 'ms',
      track: sanitizeInline(songName, 70)
    };
    // iTunes 条目 country 用 3 字母（JPN/USA），链接是 2 字母（JP/US）：等价，不报不一致
    if (track.country && !regionsMatch(track.country, ctx.target.country)) {
      ctx.lookup.regionNote = '注意：条目 country=' + sanitizeInline(track.country, 8) + '，与链接地区 ' + ctx.target.country + ' 不同';
    }

    if (!previewUrl) {
      ctx.notes.push('该条目没有 previewUrl（常见于无试听/未授权试听），跳过试听探测。');
      finish('Apple Music 探测：目录可达', render('仅证明目录 API 可达，未验证试听与完整播放'));
      return;
    }

    var previewHost = parseHttpsHost(previewUrl);
    if (!previewHost || !hostSuffixAllowed(previewHost)) {
      ctx.preview = { ok: false, text: 'previewUrl 主机不在允许列表，已跳过请求' };
      finish('Apple Music 探测：试听地址不可信', render('previewUrl 非 Apple 试听主机，未发起请求'));
      return;
    }

    /* 4) 试听资源：Range 小段，仅 1 次 */
    ctx.notes.push('试听请求：Range ' + PREVIEW_RANGE + '，最多 ' + PREVIEW_MAX_REQUESTS + ' 次');
    if (finished) return;          // 预算可能在 lookup 期间刚好耗尽
    var previewStart = Date.now();
    httpGet({
      url: previewUrl,
      node: nodeOption,
      timeout: ctx.config.requestTimeoutMs,
      headers: { 'Range': PREVIEW_RANGE, 'Accept': 'audio/*,*/*;q=0.1' },
      'binary-mode': true,     // 拿 Uint8Array 才能数出真实字节数（官方 §7.2 binary-mode）
      'auto-redirect': false   // 不跟随重定向：避免跳到白名单外的主机（660+）
    }).then(function (pres) {
      if (finished) return;        // 迟到回调：已 $done，不覆盖结果
      if (pres.skipped) return;
      var pElapsed = Date.now() - previewStart;
      if (!pres.ok) {
        ctx.preview = { ok: false, text: '请求失败：' + pres.error, detail: '该节点可能无法访问 Apple 试听资源（也可能是网络中断）' };
        finish('Apple Music 探测：试听失败', render('目录查询可达，但试听资源不可达；不能据此认为播放可用'));
        return;
      }
      var status = pres.status;
      var contentType = headerValue(pres.headers, 'Content-Type');
      var contentRange = headerValue(pres.headers, 'Content-Range');
      var contentLength = headerValue(pres.headers, 'Content-Length');
      var byteLen = null;
      if (pres.data != null) {
        if (typeof pres.data === 'string') byteLen = pres.data.length;
        else if (typeof pres.data.byteLength === 'number') byteLen = pres.data.byteLength;
        else if (typeof pres.data.length === 'number') byteLen = pres.data.length;
      }
      var verdict = classifyPreviewBody(status, contentType, byteLen);
      var detail = [];
      if (contentType) detail.push('Content-Type ' + sanitizeInline(contentType, 40));
      if (contentRange) detail.push('Content-Range ' + sanitizeInline(contentRange, 40));
      if (contentLength) detail.push('声明长度 ' + sanitizeInline(contentLength, 12));
      if (byteLen !== null) detail.push('实收 ' + byteLen + ' 字节');
      detail.push(pElapsed + 'ms');

      if (!verdict.ok) {
        ctx.preview = { ok: false, text: verdict.text, detail: detail.join(' · ') };
        if (verdict.code === 'mime' || verdict.code === 'mime-missing' || verdict.code === 'mime-unknown') {
          ctx.notes.push('状态码通过但内容不是可识别音频（可能是错误页/拦截页），按失败处理。');
        }
      } else {
        ctx.preview = { ok: true, text: verdict.text, detail: detail.join(' · ') };
        if (verdict.code === 'full') {
          ctx.notes.push('注意：试听服务器忽略 Range 返回 200，本次可能拉取了整段试听文件（仍只请求 1 次，未再重试）。');
        }
      }
      finish(ctx.preview.ok ? 'Apple Music 探测：目录+试听首段可达' : 'Apple Music 探测：试听不可用',
        render(ctx.preview.ok
          ? '该节点可访问 Apple 公开目录 API，并取到非空音频数据（未验证完整播放 / 授权 / 地区解锁）'
          : '该节点可访问目录 API，但试听资源未返回可用音频'));
    }, function (e) {
      // Promise 一般不 reject；保留兜底，仍走同一条收尾路径
      if (finished) return;
      ctx.preview = { ok: false, text: '未知异常' };
      finish('Apple Music 探测：试听异常', render('试听探测发生未预期异常'));
    });
  }, function (e) {
    if (finished) return;
    ctx.lookup = { stage: 'error', text: '未知异常' };
    finish('Apple Music 探测：异常', render('目录查询发生未预期异常'));
  });
}

/* ------------------------------------------------------------------ *
 * 入口：Loon 里没有 module，直接执行；Node 里 require 时只导出纯函数便于测试
 * ------------------------------------------------------------------ */
var __exports = {
  DEFAULT_URL: DEFAULT_URL,
  ALLOWED_HOST: ALLOWED_HOST,
  PREVIEW_RANGE: PREVIEW_RANGE,
  escapeHtml: escapeHtml,
  sanitizeInline: sanitizeInline,
  truncate: truncate,
  parseTargetUrl: parseTargetUrl,
  resolveNode: resolveNode,
  readConfig: readConfig,
  pickTrack: pickTrack,
  regionsMatch: regionsMatch,
  parseHttpsHost: parseHttpsHost,
  classifyPreviewBody: classifyPreviewBody,
  hostSuffixAllowed: hostSuffixAllowed,
  run: run
};

if (typeof module !== 'undefined' && module && module.exports) {
  module.exports = __exports;
} else {
  run();
}
