/* Independent experimental implementation. Loon Script V2 >= 3.5.1 (983).
 * No message/body access; no connection visibility; lease is NOT atomic CAS.
 */
(function () {
  'use strict';
  var ended = false, callbackUsed = false, owned = false, original = '', key = '', owner = '';
  var a, started;
  function log(message) { try { console.log('[telegram-reconnect] ' + message); } catch (_) {} }
  function report(message) {
    log(message);
    if (a && a.NOTIFY === true) {
      try { $notification.post('Telegram 策略切换实验', '', message); }
      catch (_) { log('通知发送失败；请检查运行日志。'); }
    }
  }
  function read(name) { return $persistentStore.read(key + name); }
  function write(name, value) {
    if ($persistentStore.write(value, key + name) !== true) throw Error('持久化写入失败');
  }
  function clock() {
    var n = Date.now();
    if (!Number.isSafeInteger(n) || n <= 0) throw Error('时间异常');
    return n;
  }
  function release() {
    if (!owned) return;
    try {
      // Preserve recovery evidence while a group may still be stuck on REJECT.
      if ($config.getSelectedPolicy(a.POLICY_GROUP) === 'REJECT') return;
      var raw = read('lease');
      if (raw && JSON.parse(raw).owner === owner) write('lease', undefined);
    } catch (_) { report('lease 清理失败；后续触发可能被保护性阻止。'); }
    owned = false;
  }
  function finish() {
    if (ended) return;
    ended = true;
    release();
    $done({});
  }
  function fail(message) { report(message); finish(); }
  function restore() {
    try {
      var current = $config.getSelectedPolicy(a.POLICY_GROUP);
      if (current !== 'REJECT') {
        report('选中策略已变化，保留用户当前选择；本次不记成功冷却。');
        return false;
      }
      var ok = $config.setSelectPolicy(a.POLICY_GROUP, original);
      var actual = $config.getSelectedPolicy(a.POLICY_GROUP);
      if (ok !== true || actual !== original) {
        report('切回未确认成功，请立即在 Loon 手动将该组切回可用策略。');
        return false;
      }
      return true;
    } catch (_) {
      report('切回出现异常，请立即在 Loon 手动将该组切回可用策略。');
      return false;
    }
  }
  function switchOutFailed() {
    report('切出未确认成功；尝试检查并恢复，不记成功冷却。');
    try { if ($config.getSelectedPolicy(a.POLICY_GROUP) === 'REJECT') restore(); }
    catch (_) { report('无法读取策略，请立即检查并手动切回可用策略。'); }
    finish();
  }
  function begin(text) {
    if (ended || callbackUsed) return;
    callbackUsed = true;
    try {
      var parsed = text ? JSON.parse(text) : [];
      if (!Array.isArray(parsed)) throw Error('子策略数据异常');
      var children = parsed.map(function (item) {
        if (typeof item === 'string') return item;
        if (item && typeof item.name === 'string') return item.name;
        throw Error('子策略元素格式异常');
      });
      if (children.indexOf('REJECT') < 0) throw Error('组不存在或子策略不含 REJECT');
      original = $config.getSelectedPolicy(a.POLICY_GROUP);
      if (typeof original !== 'string' || !original.trim() || original === 'REJECT') throw Error('当前策略为空或已是 REJECT');
      if (a.MODE === 'observe') { log('观察模式：子策略与当前选择检查就绪；不切换，不代表 Telegram 连接可见。'); finish(); return; }
      started = clock();
      var cooldown = read('cooldown');
      if (cooldown !== null && cooldown !== undefined && cooldown !== '') {
        var last = Number(cooldown);
        if (!Number.isSafeInteger(last) || last <= 0 || last > started) throw Error('冷却时间异常，请人工检查');
        if (started - last < a.INTERVAL * 1000) { log('仍在成功冷却期，跳过。'); finish(); return; }
      }
      var raw = read('lease');
      if (raw) {
        var prior = JSON.parse(raw);
        if (!prior || typeof prior.owner !== 'string' || !prior.owner || typeof prior.original !== 'string' || !prior.original || !Number.isSafeInteger(prior.started) || !Number.isSafeInteger(prior.expires) || prior.started <= 0 || prior.started > started || prior.expires <= prior.started || prior.expires - prior.started !== 15000) throw Error('lease 或时间异常，请人工检查');
        if (prior.expires > started) { log('同组 lease 尚有效，跳过。'); finish(); return; }
      }
      owner = String(started) + ':' + Math.random().toString(36).slice(2);
      var lease = JSON.stringify({owner:owner, started:started, expires:started+15000, original:original});
      write('lease', lease);
      owned = true;
      if (read('lease') !== lease) throw Error('lease 写后校验失败');
      // Recheck immediately before mutation. These reads are NOT atomic CAS.
      if ($config.getSelectedPolicy(a.POLICY_GROUP) !== original) throw Error('切出前用户选择已变化');
      if (clock() < started || clock() >= started + 15000) throw Error('切出前时间异常或 lease 过期');
    } catch (e) { fail('未切换：' + e.message); return; }
    try {
      var changed = $config.setSelectPolicy(a.POLICY_GROUP, 'REJECT');
      var actual = $config.getSelectedPolicy(a.POLICY_GROUP);
      if (changed !== true || actual !== 'REJECT') { switchOutFailed(); return; }
    } catch (_) { switchOutFailed(); return; }
    try {
      setTimeout(function () {
        if (ended) return;
        if (restore()) {
          try {
            var completed = clock();
            if (completed < started || completed >= started + 15000) throw Error('时间异常或 lease 过期');
            write('cooldown', String(completed));
            if (read('cooldown') !== String(completed)) throw Error('冷却写后校验失败');
            report('已完成 REJECT → 原策略的策略切换并记录冷却；不代表连接已断开或重连成功。');
          } catch (_) { report('已切回原策略，但成功冷却未确认写入；请检查存储或时间。'); }
        }
        finish();
      }, a.HOLD_MS);
    } catch (_) { report('等待计时器异常，立即尝试切回。'); restore(); finish(); }
  }
  try {
    a = typeof $argument === 'undefined' ? null : $argument;
    if (!a || typeof a !== 'object' || Array.isArray(a) || ['observe','reconnect'].indexOf(a.MODE) < 0 || typeof a.POLICY_GROUP !== 'string' || !a.POLICY_GROUP.trim() || typeof a.INTERVAL !== 'number' || !Number.isFinite(a.INTERVAL) || a.INTERVAL < 0 || a.INTERVAL > Number.MAX_SAFE_INTEGER/1000 || !Number.isInteger(a.HOLD_MS) || a.HOLD_MS < 100 || a.HOLD_MS > 1500 || typeof a.AUTO_TRIGGER !== 'boolean' || typeof a.NOTIFY !== 'boolean') throw Error('参数缺失或类型/范围无效');
    key = 'telegram-reconnect:v1:' + encodeURIComponent(a.POLICY_GROUP) + ':';
    if (typeof $request !== 'undefined' || typeof $response !== 'undefined') {
      if (!a.AUTO_TRIGGER || typeof $request === 'undefined' || !/^https:\/\/(?:api\.swiftgram\.app|api\.imem\.app|api\.iturrit\.com)(?::443)?(?:\/|\?|$)/.test($request.url)) { finish(); return; }
    }
    clock();
    setTimeout(function () { if (!ended && !callbackUsed) fail('读取子策略超时，未切换；晚回调将被忽略。'); }, 2000);
    $config.getSubPolicies(a.POLICY_GROUP, begin);
  } catch (e) { fail('未切换：' + e.message); }
})();
