// 采集窗口 preload：在页面脚本跑之前，把一段脚本插进页面主世界（MAIN world）。
// 主世界脚本只做两件后备/补充的事，绝不改页面行为、绝不主动发请求：
//   1. 签名器陷阱（后备，P3）：在 Object.prototype 上装 encrypter/encoder setter，
//      等页面给某对象赋值签名器时捕获并上报状态；60 秒未捕获自动拆除。v0.2.0
//      不用借到的签名器发任何请求（主路是 debugger 截获），陷阱只作状态探测。
//   2. fetch/XHR 包装（补充，P2）：只捕获 /rest/v/profile/feed 响应正文，
//      经 CustomEvent 交给 preload 转发给主进程；debugger 截获不到时作补充。
// preload 跑在 documentElement 出现之前，必须用 MutationObserver 等 <html> 插入
// 后再注入（探针实测坑：直接访问 documentElement 会让整个 preload 加载失败）。
// preload 与页面主世界是两个隔离世界：包装必须发生在主世界里（插 <script> 标签），
// 在 preload 里包 fetch 影响不到页面的 fetch。

import { ipcRenderer } from "electron";

// 注意：注入脚本里不许出现反引号、${ 与 "</script>"（外层是模板字符串，且要塞进 <script> 标签）。
const INJECTED_SCRIPT = `(function () {
  try {
    if (window.__monitorCollectInstalled) return;
    window.__monitorCollectInstalled = true;
    var FEED_MARK = "/rest/v/profile/feed";
    function emit(detail) {
      try { window.dispatchEvent(new CustomEvent("__monitor-collect", { detail: detail })); } catch (e) {}
    }
    // ---- 1. 签名器陷阱（只探测，不用它发请求） ----
    var TRAP_PROPS = ["encrypter", "encoder"];
    var trapProp = null;
    for (var i = 0; i < TRAP_PROPS.length; i++) {
      try {
        if (!Object.getOwnPropertyDescriptor(Object.prototype, TRAP_PROPS[i])) { trapProp = TRAP_PROPS[i]; break; }
      } catch (e) {}
    }
    if (trapProp) {
      (function (prop) {
        var timer = setTimeout(removeTrap, 60000);
        function removeTrap() {
          try { clearTimeout(timer); } catch (e) {}
          try { delete Object.prototype[prop]; } catch (e) {}
        }
        try {
          Object.defineProperty(Object.prototype, prop, {
            configurable: true,
            enumerable: false,
            set: function (value) {
              try {
                // 先以普通属性写回该对象，不破坏页面逻辑
                Object.defineProperty(this, prop, { value: value, writable: true, configurable: true, enumerable: true });
                if (value && (typeof value === "object" || typeof value === "function") &&
                    typeof value.$encode === "function" && typeof value.$getCatVersion === "function" && typeof value.call === "function") {
                  window.__monitorSignerCaptured = true;
                  window.__monitorSignerCapturedAt = Date.now();
                  emit({ type: "signer-captured", at: Date.now() });
                  removeTrap();
                }
              } catch (e) {}
            },
          });
        } catch (e) { removeTrap(); }
      })(trapProp);
    }
    // ---- 2. fetch / XHR 包装（只捕获作品列表请求正文） ----
    function isFeedUrl(u) { return typeof u === "string" && u.indexOf(FEED_MARK) !== -1; }
    try {
      var origFetch = window.fetch;
      if (origFetch) {
        window.fetch = function () {
          var args = arguments;
          var url = "";
          try { url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || ""; } catch (e) {}
          return origFetch.apply(this, args).then(function (res) {
            try {
              if (isFeedUrl(url) || isFeedUrl(res.url)) {
                res.clone().text().then(function (t) {
                  emit({ type: "feed-capture", url: res.url, body: t, at: Date.now() });
                }).catch(function () {});
              }
            } catch (e) {}
            return res;
          });
        };
      }
    } catch (e) {}
    try {
      var OrigXHR = window.XMLHttpRequest;
      if (OrigXHR) {
        var origOpen = OrigXHR.prototype.open;
        var origSend = OrigXHR.prototype.send;
        OrigXHR.prototype.open = function (method, url) {
          try { this.__monitorUrl = String(url); } catch (e) {}
          return origOpen.apply(this, arguments);
        };
        OrigXHR.prototype.send = function () {
          var xhr = this;
          try {
            xhr.addEventListener("load", function () {
              try {
                if (!isFeedUrl(xhr.__monitorUrl) && !isFeedUrl(xhr.responseURL)) return;
                var body = null;
                if (xhr.responseType === "" || xhr.responseType === "text") body = xhr.responseText;
                else if (xhr.responseType === "json" && xhr.response) body = JSON.stringify(xhr.response);
                if (body !== null) emit({ type: "feed-capture", url: xhr.responseURL || xhr.__monitorUrl, body: body, at: Date.now() });
              } catch (e) {}
            });
          } catch (e) {}
          return origSend.apply(this, arguments);
        };
      }
    } catch (e) {}
  } catch (e) {}
})();`;

function inject(): void {
  try {
    const s = document.createElement("script");
    s.setAttribute("data-monitor-collect", "1");
    s.textContent = INJECTED_SCRIPT;
    document.documentElement.appendChild(s);
    document.documentElement.setAttribute("data-monitor-preload-ran", "1");
  } catch {
    // 注入失败绝不破坏页面；主路 debugger 截获不受影响
  }
}

// 主世界脚本经 CustomEvent 上报，preload 转发给主进程（两个世界共享 DOM 事件系统）。
window.addEventListener("__monitor-collect", (ev: Event) => {
  try {
    const detail = (ev as CustomEvent).detail as unknown;
    ipcRenderer.send("monitor-collect-event", detail);
  } catch {
    // 忽略
  }
});

if (document.documentElement) {
  inject();
} else {
  const mo = new MutationObserver(() => {
    if (document.documentElement) {
      mo.disconnect();
      inject();
    }
  });
  mo.observe(document, { childList: true });
}

export {};
