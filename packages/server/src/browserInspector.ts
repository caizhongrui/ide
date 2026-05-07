/*---------------------------------------------------------------------------------------------
 *  Maxian Server — Browser Inspector Script
 *
 *  注入到被代理页面的内容脚本。在 iframe 上下文中运行：
 *  - hook console.log/info/warn/error/debug → postMessage 给 parent（'maxian-console'）
 *  - hook fetch / XHR → postMessage 'maxian-network'
 *  - 监听 'maxian-cmd' postMessage → 执行 click/fill/eval/wait-for，回 'maxian-resp'
 *  - 上报当前 location.href 给 parent，让 URL bar 跟随真实导航
 *
 *  注意：此脚本通过 /browser/proxy?url=... 内联到 HTML <head> 顶部，因此始终在
 *  被代理页面的 origin 下运行 —— 不再受跨域限制。
 *--------------------------------------------------------------------------------------------*/

export const INSPECTOR_SCRIPT = String.raw`
(function(){
  if (window.__maxianInjected) return;
  window.__maxianInjected = true;

  function safeJson(v) {
    try { return JSON.parse(JSON.stringify(v)); } catch (e) { return String(v); }
  }
  function send(msg) {
    try { window.parent.postMessage(msg, '*'); } catch (_) {}
  }

  // ─── 关键：先把 iframe 的 location 改写成上游路径 ────────────────────────
  // 否则 SPA Router（Vue Router / React Router）会读到 /browser/proxy?... 报警告并匹配不到路由。
  //
  // 注意：我们注入了 <base href="<上游 origin>/">，这会让相对 URL 全部解析到上游。
  // history.replaceState(state, '', '/login') 也走 baseURI 解析 → 解析成 <上游>/login → 跨 origin → SecurityError！
  // 因此必须传**绝对 same-origin URL**（用当前 location.origin + 上游 path 拼）。
  var __replaceStateOK = false;
  var __replaceStateErr = '';
  var __pathnameBefore = location.pathname + location.search;
  if (window.__maxianUpstreamUri && history && history.replaceState) {
    try {
      var absoluteUri = location.origin + (
        window.__maxianUpstreamUri.charAt(0) === '/'
          ? window.__maxianUpstreamUri
          : '/' + window.__maxianUpstreamUri
      );
      history.replaceState(history.state, '', absoluteUri);
      __replaceStateOK = true;
    } catch (e) {
      __replaceStateErr = String(e && e.message || e);
      // 实在不行（比如某些极端 CSP），退到一个无害的占位 path，至少不让 Router 看到 /browser/proxy
      try {
        history.replaceState(history.state, '', location.origin + '/');
        __replaceStateOK = true;
        __replaceStateErr += ' (回退到根路径 / 成功)';
      } catch (e2) {
        __replaceStateErr += ' (回退也失败: ' + String(e2 && e2.message || e2) + ')';
      }
    }
  }
  // 把启动诊断信息发给 parent（前端可在 Console 面板看到）
  send({
    type: 'maxian-console',
    level: __replaceStateOK ? 'info' : 'error',
    text: '[maxian-inspector] boot pathname=' + __pathnameBefore +
      ' upstreamUri=' + (window.__maxianUpstreamUri || '<empty>') +
      ' replaceState=' + (__replaceStateOK ? 'OK→' + location.pathname : 'FAIL ' + __replaceStateErr),
    ts: Date.now(),
  });

  // ─── 真实显示 URL 跟随（pushState / replaceState / popstate / hashchange）────
  // 上报给 parent 时拼回上游 origin，让 URL bar 显示用户能识别的真实地址。
  function reportUrl() {
    var realUrl = window.__maxianUpstream
      ? window.__maxianUpstream + location.pathname + location.search + location.hash
      : location.href;
    send({ type: 'maxian-url-change', url: realUrl, ts: Date.now() });
  }
  reportUrl();
  var _push = history.pushState;
  var _repl = history.replaceState;
  history.pushState = function(){ var r = _push.apply(this, arguments); reportUrl(); return r; };
  history.replaceState = function(){ var r = _repl.apply(this, arguments); reportUrl(); return r; };
  window.addEventListener('popstate', reportUrl);
  window.addEventListener('hashchange', reportUrl);

  // ─── 链接劫持仅作"逃生窗口"使用（默认关闭） ────────────────────────────────
  // 早先版本会在 capture 阶段拦截所有 <a> 点击和 <form> submit 改写到 proxy。
  // 这导致两个问题：
  //   1) Vue Router / React Router 等也在 click 上拦截并 router.push()，跟我们抢；
  //      最终既走了 SPA 路由又触发了一次完整页面跳转，URL 跳到 proxy 但 SPA 状态被打乱。
  //   2) 完整页面跳转后 inspector 在新页运行的 boot 时序跟原来不同，
  //      容易出现 Vue Router 在 replaceState 之前已经读了一次 location 的情况。
  //
  // 所以现在：把内部导航完全交给 SPA Router（它用 pushState/replaceState，全部 same-origin），
  // 只有用户在 URL bar 主动输入新地址时才会触发新一轮 proxy 加载。
  // 极端情况下若页面真的是 multi-page 站点（每页都是独立 HTML），用户直接在 URL bar 切换即可。

  // ─── console hook ───────────────────────────────────────────────────
  ['log','info','warn','error','debug'].forEach(function(level){
    var orig = console[level];
    console[level] = function(){
      try {
        var args = Array.prototype.slice.call(arguments);
        var text = args.map(function(a){
          if (typeof a === 'string') return a;
          try { return JSON.stringify(a); } catch (e) { return String(a); }
        }).join(' ');
        send({ type: 'maxian-console', level: level, text: text, ts: Date.now() });
      } catch (e) {}
      return orig.apply(console, arguments);
    };
  });

  window.addEventListener('error', function(e){
    send({
      type: 'maxian-console',
      level: 'error',
      text: '[uncaught] ' + (e.message || (e.error && e.error.message) || String(e)),
      ts: Date.now(),
    });
  });
  window.addEventListener('unhandledrejection', function(e){
    var reason = e.reason;
    var text = reason && reason.message ? reason.message : String(reason);
    send({
      type: 'maxian-console',
      level: 'error',
      text: '[unhandledrejection] ' + text,
      ts: Date.now(),
    });
  });

  // ─── fetch hook ─────────────────────────────────────────────────────
  if (window.fetch) {
    var origFetch = window.fetch.bind(window);
    window.fetch = function(input, init){
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var method = (init && init.method) || (input && input.method) || 'GET';
      var t0 = Date.now();
      return origFetch(input, init).then(function(res){
        send({
          type: 'maxian-network',
          method: String(method).toUpperCase(),
          url: url,
          status: res.status,
          durationMs: Date.now() - t0,
          ts: Date.now(),
        });
        return res;
      }).catch(function(err){
        send({
          type: 'maxian-network',
          method: String(method).toUpperCase(),
          url: url,
          status: 0,
          durationMs: Date.now() - t0,
          ts: Date.now(),
        });
        throw err;
      });
    };
  }

  // ─── XHR hook ───────────────────────────────────────────────────────
  var origXhrOpen = XMLHttpRequest.prototype.open;
  var origXhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url){
    this.__maxian = { method: method, url: url, t0: 0 };
    return origXhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(){
    var info = this.__maxian;
    if (info) info.t0 = Date.now();
    var self = this;
    this.addEventListener('loadend', function(){
      if (!info) return;
      send({
        type: 'maxian-network',
        method: String(info.method || 'GET').toUpperCase(),
        url: info.url,
        status: self.status,
        durationMs: Date.now() - info.t0,
        ts: Date.now(),
      });
    });
    return origXhrSend.apply(this, arguments);
  };

  // ─── 命令执行（AI 工具调）─────────────────────────────────────────
  function execCmd(cmd) {
    var op = cmd.op;
    var args = cmd.args || {};
    try {
      if (op === 'click') {
        var el = document.querySelector(args.selector);
        if (!el) return { ok: false, error: '元素未找到: ' + args.selector };
        el.click();
        return { ok: true };
      }
      if (op === 'fill') {
        var input = document.querySelector(args.selector);
        if (!input) return { ok: false, error: '元素未找到: ' + args.selector };
        input.focus();
        if (typeof input.value !== 'undefined') {
          var proto = (input.tagName === 'TEXTAREA')
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
          var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          setter.call(input, args.value);
          input.dispatchEvent(new Event('input',  { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          input.textContent = args.value;
        }
        return { ok: true };
      }
      if (op === 'eval') {
        var fn = new Function(args.script);
        var r = fn();
        if (r && typeof r.then === 'function') {
          // Promise -> wait
          return r.then(function(rv){ return { ok: true, result: safeJson(rv) }; })
                   .catch(function(err){ return { ok: false, error: String(err && err.message || err) }; });
        }
        return { ok: true, result: safeJson(r) };
      }
      if (op === 'wait-for') {
        // 简单轮询：每 200ms 检查一次，最长 args.timeoutMs（默认 10s）
        var deadline = Date.now() + (Math.min(60000, args.timeoutMs || 10000));
        return new Promise(function(resolve){
          var t0 = Date.now();
          (function poll(){
            if (document.querySelector(args.selector)) {
              resolve({ ok: true, foundAfterMs: Date.now() - t0 });
              return;
            }
            if (Date.now() > deadline) {
              resolve({ ok: false, error: '元素超时未出现: ' + args.selector });
              return;
            }
            setTimeout(poll, 200);
          })();
        });
      }
      if (op === 'screenshot') {
        // 浏览器无原生 screenshot API。返回 documentElement.outerHTML 让外层用 SVG/canvas 渲染。
        var html = document.documentElement.outerHTML;
        return { ok: true, result: { html: html, w: window.innerWidth, h: window.innerHeight } };
      }
      return { ok: false, error: 'unknown op: ' + op };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  }

  window.addEventListener('message', function(ev){
    var d = ev.data;
    if (!d || d.type !== 'maxian-cmd') return;
    Promise.resolve(execCmd(d)).then(function(resp){
      send({
        type: 'maxian-resp',
        cmdId: d.cmdId,
        ok: !!resp.ok,
        result: resp.result,
        error: resp.error,
      });
    });
  });

  send({ type: 'maxian-injected', ts: Date.now() });
})();
`;

/**
 * 把 inspector 脚本嵌入 HTML（放在 <head> 第一个位置 / 或 <body> 顶端）。
 * 同时注入 <base href="<upstream-origin>/"> 让相对路径仍然解析到上游。
 *
 * 选择策略：
 * 1. 如果有 <head>，紧跟其后插入 <base> + <script>
 * 2. 否则如果有 <html>，<head> 段落整体注入到 <html> 后
 * 3. 都没有 → prepend
 *
 * @param html              上游响应正文（HTML 字符串）
 * @param upstreamOrigin    上游 origin（如 "https://example.com"），用于 <base href>
 * @param proxyBaseWithUrl  proxy URL 前缀（如 "http://127.0.0.1:4096/browser/proxy?auth=xxx&url="），
 *                          inspector 内部用它把 <a> 点击 / form GET 重写为同样走 proxy。
 *                          注意：调用方拼好后必须保证 url= 是末尾参数，inspector 直接 append 真实 URL。
 * @param upstreamUri       上游的 path+search+hash（如 "/login?from=home"），inspector 用 history.replaceState
 *                          把 iframe 的 location.pathname/search 改成这个值，避免 SPA Router 读到 /browser/proxy 报错。
 */
export function injectInspector(
	html: string,
	upstreamOrigin: string,
	proxyBaseWithUrl?: string,
	upstreamUri?: string,
): string {
	const proxyVars =
		`<script data-maxian-vars>` +
		`window.__maxianUpstream=${JSON.stringify(upstreamOrigin)};` +
		(proxyBaseWithUrl ? `window.__maxianProxyBase=${JSON.stringify(proxyBaseWithUrl)};` : '') +
		(upstreamUri ? `window.__maxianUpstreamUri=${JSON.stringify(upstreamUri)};` : '') +
		`</script>`;
	// 关键顺序：<script vars> + <script inspector> 必须在 <base href> 之前，
	// 这样 inspector 的 history.replaceState 在 baseURI 还是 sidecar origin 时执行，
	// 相对 path 能解析回 sidecar origin（same-origin OK），不会被 base 重定向到上游被 SecurityError 拦下。
	const headBlock =
		proxyVars +
		`<script data-maxian-inspector>${INSPECTOR_SCRIPT}</script>` +
		`<base href="${upstreamOrigin}/">`;

	// 1. <head ...>
	const headOpen = /<head\b[^>]*>/i;
	if (headOpen.test(html)) {
		return html.replace(headOpen, (m) => `${m}${headBlock}`);
	}
	// 2. <html ...>
	const htmlOpen = /<html\b[^>]*>/i;
	if (htmlOpen.test(html)) {
		return html.replace(htmlOpen, (m) => `${m}<head>${headBlock}</head>`);
	}
	// 3. 都没有
	return `<head>${headBlock}</head>${html}`;
}
