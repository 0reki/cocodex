import { Window } from "happy-dom/lib/index.js";

export interface SentinelConfig {
  userAgent: string;
  buildId: string;
  oaiDid: string;
  origin?: string;
  sentinelOrigin?: string;
  customFetch?: any;
}

interface BrowserProfile {
  screenWidth: number;
  screenHeight: number;
  availHeight: number;
  colorDepth: number;
  language: string;
  languages: string[];
  hardwareConcurrency: number;
  deviceMemory: number;
  maxTouchPoints: number;
  jsHeapSizeLimit: number;
  totalJSHeapSize: number;
  usedJSHeapSize: number;
}

function pick<T>(items: readonly T[]): T {
  if (items.length === 0) {
    throw new Error("pick() received an empty list");
  }
  return items[Math.floor(Math.random() * items.length)] as T;
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function createRandomBrowserProfile(): BrowserProfile {
  const resolutions = [
    { w: 1366, h: 768 },
    { w: 1440, h: 900 },
    { w: 1536, h: 864 },
    { w: 1600, h: 900 },
    { w: 1680, h: 1050 },
    { w: 1920, h: 1080 },
    { w: 1920, h: 1200 },
    { w: 2560, h: 1440 },
  ];
  const localeCandidates = [
    ["zh-CN", ["zh-CN", "zh", "en-US"]],
    ["zh-TW", ["zh-TW", "zh", "en-US"]],
    ["en-US", ["en-US", "en", "zh-CN"]],
    ["ja-JP", ["ja-JP", "ja", "en-US"]],
    ["ko-KR", ["ko-KR", "ko", "en-US"]],
  ] as const;
  const memoryCandidates = [4, 8, 16] as const;
  const concurrencyCandidates = [4, 8, 12, 16, 20] as const;

  const resolution = pick(resolutions);
  const [language, languages] = pick(localeCandidates);
  const deviceMemory = pick(memoryCandidates);
  const hardwareConcurrency = pick(concurrencyCandidates);
  const colorDepth = pick([24, 30]);
  const maxTouchPoints = pick([0, 0, 0, 1, 5]);
  const availHeight = Math.max(
    700,
    resolution.h - pick([40, 48, 56, 64, 72, 80]),
  );
  const jsHeapSizeLimit = pick([2147483648, 4294967296, 8589934592]);
  const totalJSHeapSize = randomInt(18_000_000, 68_000_000);
  const usedJSHeapSize = randomInt(
    Math.floor(totalJSHeapSize * 0.45),
    Math.floor(totalJSHeapSize * 0.9),
  );

  return {
    screenWidth: resolution.w,
    screenHeight: resolution.h,
    availHeight,
    colorDepth,
    language,
    languages: Array.from(languages),
    hardwareConcurrency,
    deviceMemory,
    maxTouchPoints,
    jsHeapSizeLimit,
    totalJSHeapSize,
    usedJSHeapSize,
  };
}

export function setupSentinelEnv(config: SentinelConfig) {
  const origin = config.origin || "https://chatgpt.com";
  const sentinelOrigin = config.sentinelOrigin || "https://sentinel.openai.com";
  const serverUrl = sentinelOrigin + "/backend-api/sentinel/";
  const globalAny = globalThis as any;
  const browserProfile = createRandomBrowserProfile();
  const _listeners = new Map<string, any[]>();

  const dispatchSyntheticEvent = (evt: any) => {
    const handlers = _listeners.get(evt?.type) || [];
    for (const handler of handlers) {
      try {
        handler(evt);
      } catch { }
    }
  };

  // --- 创建 happy-dom 窗口 ---
  const win = new Window({
    url: origin + "/",
    width: browserProfile.screenWidth,
    height: browserProfile.screenHeight,
  });
  const doc = win.document;
  const sentinelFetch = config.customFetch || fetch;

  // --- ReDoS 反调试拦截 ---
  const redosPattern = "(((.+)+)+)+$";
  const originalSearch = String.prototype.search;
  String.prototype.search = function (r: any) {
    if (typeof r === "string" && r.includes(redosPattern)) return -1;
    if (r instanceof RegExp && r.source.includes(redosPattern)) return -1;
    return originalSearch.apply(this, arguments as any);
  };

  // --- 设置 document 内容 ---
  doc.documentElement.setAttribute("data-build", config.buildId);
  const scriptEl = doc.createElement("script");
  scriptEl.src = `${sentinelOrigin}/sentinel/${config.buildId}/sdk.js`;
  doc.head.appendChild(scriptEl);
  Object.defineProperty(doc, "currentScript", {
    value: scriptEl,
    configurable: true,
    writable: true,
  });

  // --- 模拟 React/Next.js 在 document 上注入的属性 ---
  // chatgpt.com 是 React 应用，React 会在 DOM 对象上注入 __reactContainer$<hash> 等属性
  // Object.keys(document) 在真实浏览器中只返回这些自定义可枚举属性
  const reactHash = Math.random().toString(36).substring(2, 12);
  (doc as any)[`__reactContainer$${reactHash}`] = {};
  (doc as any)[`__reactFiber$${reactHash}`] = {};
  (doc as any)[`__reactProps$${reactHash}`] = {};
  (doc as any)[`__reactEvents$${reactHash}`] = {};

  // --- 设置 cookie ---
  doc.cookie = `oai-did=${config.oaiDid}`;

  // --- 自定义 navigator 属性 ---
  Object.defineProperty(win.navigator, "userAgent", {
    value: config.userAgent,
    configurable: true,
  });
  Object.defineProperty(win.navigator, "platform", {
    value: "Win32",
    configurable: true,
  });
  Object.defineProperty(win.navigator, "language", {
    value: browserProfile.language,
    configurable: true,
  });
  Object.defineProperty(win.navigator, "languages", {
    value: browserProfile.languages,
    configurable: true,
  });
  Object.defineProperty(win.navigator, "hardwareConcurrency", {
    value: browserProfile.hardwareConcurrency,
    configurable: true,
  });
  Object.defineProperty(win.navigator, "webdriver", {
    value: false,
    configurable: true,
  });
  Object.defineProperty(win.navigator, "deviceMemory", {
    value: browserProfile.deviceMemory,
    configurable: true,
  });
  Object.defineProperty(win.navigator, "maxTouchPoints", {
    value: browserProfile.maxTouchPoints,
    configurable: true,
  });
  Object.defineProperty(win.navigator, "pdfViewerEnabled", {
    value: true,
    configurable: true,
  });
  Object.defineProperty(win.navigator, "vendor", {
    value: "Google Inc.",
    configurable: true,
  });
  Object.defineProperty(win.navigator, "vendorSub", {
    value: "",
    configurable: true,
  });
  Object.defineProperty(win.navigator, "productSub", {
    value: "20030107",
    configurable: true,
  });
  Object.defineProperty(win.navigator, "appVersion", {
    value: config.userAgent.replace("Mozilla/", ""),
    configurable: true,
  });
  Object.defineProperty(win, "SyntaxError", {
    value: SyntaxError,
    configurable: true,
  });
  Object.defineProperty(win, "TypeError", {
    value: TypeError,
    configurable: true,
  });
  Object.defineProperty(win, "Error", {
    value: Error,
    configurable: true,
  });

  // --- navigator 原型: 添加可枚举属性让 E() 正确工作 ---
  const navProto = Object.getPrototypeOf(win.navigator);
  const navProtoProps: Record<string, any> = {
    permissions: { toString: () => "[object Permissions]" },
    clipboard: { toString: () => "[object Clipboard]" },
    geolocation: { toString: () => "[object Geolocation]" },
    mediaDevices: { toString: () => "[object MediaDevices]" },
    connection: { toString: () => "[object NetworkInformation]" },
    storage: { toString: () => "[object StorageManager]" },
    locks: { toString: () => "[object LockManager]" },
    credentials: { toString: () => "[object CredentialsContainer]" },
    serviceWorker: { toString: () => "[object ServiceWorkerContainer]" },
    userActivation: { toString: () => "[object UserActivation]" },
    wakeLock: { toString: () => "[object WakeLock]" },
    gpu: { toString: () => "[object GPU]" },
    usb: { toString: () => "[object USB]" },
    bluetooth: { toString: () => "[object Bluetooth]" },
    xr: { toString: () => "[object XRSystem]" },
  };
  for (const [key, val] of Object.entries(navProtoProps)) {
    Object.defineProperty(navProto, key, {
      value: val,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }

  // --- performance.memory (Chrome 专有) ---
  const perfOriginal = win.performance;
  Object.defineProperty(perfOriginal, "memory", {
    value: {
      jsHeapSizeLimit: browserProfile.jsHeapSizeLimit,
      totalJSHeapSize: browserProfile.totalJSHeapSize,
      usedJSHeapSize: browserProfile.usedJSHeapSize,
    },
    configurable: true,
  });

  // --- screen ---
  Object.defineProperty(win.screen, "width", {
    value: browserProfile.screenWidth,
    configurable: true,
  });
  Object.defineProperty(win.screen, "height", {
    value: browserProfile.screenHeight,
    configurable: true,
  });
  Object.defineProperty(win.screen, "availWidth", {
    value: browserProfile.screenWidth,
    configurable: true,
  });
  Object.defineProperty(win.screen, "availHeight", {
    value: browserProfile.availHeight,
    configurable: true,
  });
  Object.defineProperty(win.screen, "colorDepth", {
    value: browserProfile.colorDepth,
    configurable: true,
  });

  // --- chrome 对象 (Chrome 浏览器特有) ---
  (win as any).chrome = {
    runtime: {},
    app: {},
    csi: () => { },
    loadTimes: () => { },
  };

  // --- iframe 模拟: 拦截 createElement("iframe") ---
  const origCreateElement = doc.createElement.bind(doc);
  Object.defineProperty(doc, "createElement", {
    value: function (tag: string, ...args: any[]) {
      const el = origCreateElement(tag, ...args);

      if (tag.toLowerCase() === "iframe") {
        let loaded = false;
        const frameLocation = new URL(
          `${sentinelOrigin}/backend-api/sentinel/frame.html?sv=${encodeURIComponent(config.buildId)}`,
        );
        const contentWindow: any = {
          window: null,
          self: null,
          parent: win,
          top: win,
          frameElement: el,
          origin: sentinelOrigin,
          location: frameLocation,
          postMessage: async (data: any, _targetOrigin: any) => {
            const { type, flow, requestId, p } = data;
            let result: any;
            let error: string | undefined;

            try {
              const body = JSON.stringify({ p, id: config.oaiDid, flow });
              const resp = await sentinelFetch(serverUrl + "req", {
                method: "POST",
                body,
                headers: { "Content-Type": "text/plain;charset=UTF-8" },
              });
              const raw = await resp.text();
              const json = JSON.parse(raw);

              if (type === "init" || type === "token") {
                result = { cachedChatReq: json, cachedProof: typeof p === "string" ? p : null };
              }
            } catch (e: any) {
              error = e.message;
            }

            setTimeout(() => {
              const msgEvt = {
                type: "message",
                data: { type: "response", requestId, result, error },
                source: contentWindow,
                origin: sentinelOrigin,
                target: win,
                currentTarget: win,
              };
              dispatchSyntheticEvent(msgEvt);
              try {
                win.dispatchEvent(msgEvt as any);
              } catch { }
            }, 0);
          },
        };
        contentWindow.window = contentWindow;
        contentWindow.self = contentWindow;
        Object.defineProperty(el, "contentWindow", {
          value: contentWindow,
          configurable: true,
        });
        Object.defineProperty(el, "contentDocument", {
          value: {
            defaultView: contentWindow,
            location: frameLocation,
            readyState: "complete",
          },
          configurable: true,
        });

        // 拦截 appendChild 使 iframe 自动 "load"
        const origAddEventListener = el.addEventListener.bind(el);
        const loadHandlers: any[] = [];
        el.addEventListener = function (
          type: string,
          handler: any,
          ...rest: any[]
        ) {
          if (type === "load") {
            loadHandlers.push(handler);
            if (loaded) {
              setTimeout(() => {
                try {
                  handler({ type: "load", target: el, currentTarget: el });
                } catch { }
              }, 0);
            }
          }
          return origAddEventListener(type, handler, ...rest);
        };
        const fireLoad = () => {
          if (loaded) return;
          loaded = true;
          for (const h of loadHandlers) {
            try {
              h({ type: "load", target: el, currentTarget: el });
            } catch { }
          }
        };
        // body.appendChild(iframe) 后自动触发 load
        setTimeout(fireLoad, 0);
      }

      return el;
    },
    configurable: true,
    enumerable: false,
  });
  function def(n: string, v: any) {
    Object.defineProperty(globalAny, n, {
      value: v,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }

  // 核心 window 引用 (zt=false: top === window)
  def("window", win);
  def("self", win);
  def("top", win);
  def("parent", win);

  // DOM 相关
  def("document", doc);
  def("location", win.location);
  def("navigator", win.navigator);
  def("performance", win.performance);
  def("screen", win.screen);
  def("history", win.history);
  def("localStorage", win.localStorage);
  def("sessionStorage", win.sessionStorage);

  // 加密 & 编码
  def("crypto", win.crypto);
  def("TextEncoder", TextEncoder); // 用 Node 原生，避免 happy-dom 编码差异
  def("TextDecoder", TextDecoder);
  def("btoa", (s: string) => Buffer.from(s, "binary").toString("base64"));
  def("atob", (s: string) => Buffer.from(s, "base64").toString("binary"));

  // 网络
  def("fetch", config.customFetch || win.fetch?.bind(win) || fetch);
  def("XMLHttpRequest", (win as any).XMLHttpRequest);
  def("Headers", Headers);
  def("Request", Request);
  def("Response", Response);
  def("URL", URL);
  def("URLSearchParams", URLSearchParams);

  // 定时 & 动画
  def("requestIdleCallback", (cb: any) =>
    setTimeout(() => cb({ timeRemaining: () => 50 }), 1),
  );
  def("requestAnimationFrame", (cb: any) =>
    setTimeout(() => cb(Date.now()), 16),
  );
  def("cancelAnimationFrame", clearTimeout);

  // 构造函数 & 类
  def("HTMLElement", (win as any).HTMLElement);
  def("HTMLIFrameElement", (win as any).HTMLIFrameElement);
  def("HTMLScriptElement", (win as any).HTMLScriptElement);
  def("HTMLCanvasElement", (win as any).HTMLCanvasElement);
  def("Element", (win as any).Element);
  def("Node", (win as any).Node);
  def("NodeList", (win as any).NodeList);
  def("Event", (win as any).Event);
  def("CustomEvent", (win as any).CustomEvent);
  def("MessageEvent", (win as any).MessageEvent);
  def("ErrorEvent", (win as any).ErrorEvent);
  def("MutationObserver", (win as any).MutationObserver);
  def("IntersectionObserver", (win as any).IntersectionObserver);
  def("ResizeObserver", (win as any).ResizeObserver);
  def(
    "FormData",
    (win as any).FormData ||
    class {
      append() { }
    },
  );
  def("Blob", (win as any).Blob);
  def("File", (win as any).File);
  def("FileReader", (win as any).FileReader);
  def("AbortController", AbortController);
  def("AbortSignal", AbortSignal);
  def("DOMParser", (win as any).DOMParser);
  def(
    "getComputedStyle",
    (win as any).getComputedStyle?.bind(win) ||
    (() => ({ getPropertyValue: () => "" })),
  );
  def("PerformanceEntry", class { });
  def("WritableStreamDefaultController", class { });
  def("chrome", (win as any).chrome);

  // --- 事件系统: 追踪 addEventListener on globalAny ---
  globalAny.__msgListeners = [] as any[];
  globalAny.addEventListener = (t: any, h: any) => {
    const l = _listeners.get(t) || [];
    if (!l.includes(h)) l.push(h);
    _listeners.set(t, l);
    if (t === "message") globalAny.__msgListeners.push(h);
  };
  globalAny.removeEventListener = (t: any, h: any) => {
    const l = _listeners.get(t);
    if (l) {
      const i = l.indexOf(h);
      if (i >= 0) l.splice(i, 1);
    }
    if (t === "message") {
      const ml = globalAny.__msgListeners;
      const mi = ml.indexOf(h);
      if (mi >= 0) ml.splice(mi, 1);
    }
  };
  globalAny.dispatchEvent = (evt: any) => {
    dispatchSyntheticEvent(evt);
  };
  globalAny.postMessage = (data: any) => {
    // 模拟 window.postMessage
    setTimeout(() => {
      dispatchSyntheticEvent({
        type: "message",
        data,
        source: globalAny,
        origin,
      });
    }, 0);
  };
  (win as any).__msgListeners = globalAny.__msgListeners;
  (win as any).addEventListener = globalAny.addEventListener;
  (win as any).removeEventListener = globalAny.removeEventListener;
  (win as any).dispatchEvent = globalAny.dispatchEvent;
  (win as any).postMessage = globalAny.postMessage;
}
