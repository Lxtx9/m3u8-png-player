// ==UserScript==
// @name         M3U8 PNG 视频播放器
// @namespace    m3u8-png-player
// @version      1.0.0
// @match        *://*/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      *
// @require      https://cdn.jsdelivr.net/npm/hls.js@1.6.15/dist/hls.min.js
// ==/UserScript==

(function () {
  "use strict";

  var W = (typeof unsafeWindow !== "undefined" && unsafeWindow) || window;
  var TAG = "[M3U8]";

  function log() {
    var a = Array.prototype.slice.call(arguments);
    try { console.log.apply(console, [TAG].concat(a)); } catch (e) {}
  }

  function getHls() {
    var h = null;
    try { h = W.Hls; } catch (e) {}
    if (!h) { try { h = window.Hls; } catch (e) {} }
    if (!h) { try { if (typeof unsafeWindow !== "undefined" && unsafeWindow) h = unsafeWindow.Hls; } catch (e) {} }
    if (!h) { try { h = Hls; } catch (e) {} }
    return h || null;
  }

  function toFreshBuffer(data) {
    if (data == null) return data;
    if (typeof data === "string") {
      var n = data.length, u = new Uint8Array(n);
      for (var i = 0; i < n; i++) u[i] = data.charCodeAt(i) & 0xff;
      return u.buffer;
    }
    var view = null;
    try {
      if (data instanceof Uint8Array) view = data;
      else if (data instanceof ArrayBuffer) view = new Uint8Array(data);
      else if (ArrayBuffer.isView(data))
        view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      else view = new Uint8Array(data);
    } catch (e) {
      log("toFreshBuffer fail:", e && e.message);
      return data;
    }
    var out = new Uint8Array(view.byteLength);
    out.set(view);
    return out.buffer;
  }

  function asBytes(data) {
    if (!data) return null;
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data))
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return null;
  }

  function pngPayloadOffset(u8) {
    var sig = [137, 80, 78, 71, 13, 10, 26, 10];
    if (!u8 || u8.length < 8) return -1;
    for (var i = 0; i < 8; i++) if (u8[i] !== sig[i]) return -1;
    var pos = 8;
    while (pos + 8 <= u8.length) {
      var len = ((u8[pos] << 24) | (u8[pos + 1] << 16) |
                (u8[pos + 2] << 8) | u8[pos + 3]) >>> 0;
      var type = String.fromCharCode(u8[pos + 4], u8[pos + 5], u8[pos + 6], u8[pos + 7]);
      pos += 12 + len;
      if (type === "IEND") return pos;
      if (pos > u8.length) break;
    }
    return -1;
  }

  function isPng(u8) {
    return u8 && u8.length >= 4 && u8[0] === 0x89 && u8[1] === 0x50 &&
           u8[2] === 0x4e && u8[3] === 0x47;
  }

  function preparePayload(data, label) {
    if (!data) return data;
    var bytes = asBytes(data);
    if (!bytes) return toFreshBuffer(data);
    if (isPng(bytes)) {
      var off = pngPayloadOffset(bytes);
      if (off > 0 && off < bytes.length) {
        log(label, "PNG strip", bytes.length, "->", bytes.length - off, "B");
        return bytes.slice(off).buffer;
      }
      log(label, "PNG no IEND", bytes.length, "B");
    }
    return toFreshBuffer(data);
  }

  var fragCache = {}, fragCacheMax = 200, fragCacheTTL = 1800000;

  function fragCacheSet(url, data) {
    fragCache[url] = { data: data, ts: Date.now() };
    var keys = Object.keys(fragCache);
    if (keys.length > fragCacheMax) {
      keys.sort(function (a, b) { return fragCache[a].ts - fragCache[b].ts; });
      var toDel = keys.length - fragCacheMax;
      for (var i = 0; i < toDel; i++) delete fragCache[keys[i]];
    }
  }

  function fragCacheGet(url) {
    var e = fragCache[url];
    if (!e) return null;
    if (Date.now() - e.ts > fragCacheTTL) { delete fragCache[url]; return null; }
    return e.data;
  }

  function fragCacheClear() { fragCache = {}; }

  var segUrls = [];
  var preloadAhead = 8;
  var maxPreload = 6;
  var preloadActive = 0;
  var preloadBusy = {};
  var preloadTimer = null;
  var preloadGen = 0;

  function resolveSegUrl(relUrl, m3u8Url) {
    if (!relUrl) return null;
    if (/^https?:\/\//i.test(relUrl)) return relUrl;
    if (m3u8Url) {
      var dir = m3u8Url.substring(0, m3u8Url.lastIndexOf("/") + 1);
      while (relUrl.indexOf("../") === 0) {
        relUrl = relUrl.substring(3);
        dir = dir.substring(0, dir.lastIndexOf("/") + 1);
      }
      return dir + relUrl;
    }
    return relUrl;
  }

  function preloadOne(url) {
    if (!url || preloadBusy[url] || fragCacheGet(url) !== null) return;
    if (preloadActive >= maxPreload) return;
    var myGen = preloadGen;
    preloadBusy[url] = true;
    preloadActive++;
    var label = "[PRE] " + url.split("/").pop().split("?")[0];
    GM_xmlhttpRequest({
      url: url, method: "GET", timeout: 120000, responseType: "arraybuffer",
      onload: function (r) {
        if (myGen !== preloadGen) return;
        preloadActive--; delete preloadBusy[url];
        if (r.status < 200 || r.status >= 300) { log(label, "HTTP", r.status); return; }
        var data = preparePayload(r.response, label);
        fragCacheSet(url, data);
      },
      onerror: function () {
        if (myGen !== preloadGen) return;
        preloadActive--; delete preloadBusy[url];
        log(label, "net error");
      },
      ontimeout: function () {
        if (myGen !== preloadGen) return;
        preloadActive--; delete preloadBusy[url];
        log(label, "timeout");
      }
    });
  }

  function ensurePreload(startIdx, count) {
    var n = count || preloadAhead;
    for (var i = Math.max(0, startIdx); i < startIdx + n && i < segUrls.length; i++) {
      preloadOne(segUrls[i]);
    }
  }

  function preloadReset() {
    preloadGen++;
    preloadBusy = {};
    preloadActive = 0;
  }

  function startPreloadTimer() {
    if (preloadTimer) return;
    preloadTimer = setInterval(function () {
      if (!video || !video.currentTime || !segUrls.length) return;
      var idx = Math.floor(video.currentTime / 4);
      var bufEnd = txBufferedEnd(video);
      var ahead = Math.max(0, bufEnd - video.currentTime);
      if (ahead > 40) return;
      ensurePreload(idx + 1, preloadAhead);
    }, 2000);
  }

  function stopPreloadTimer() {
    if (preloadTimer) { clearInterval(preloadTimer); preloadTimer = null; }
  }

  function resetPreload() {
    segUrls = [];
    preloadReset();
    stopPreloadTimer();
    fragCacheClear();
  }

  function makeGMLoader() {
    var HlsCtor = getHls();
    if (!HlsCtor || !HlsCtor.DefaultConfig) return null;
    var Base = HlsCtor.DefaultConfig.loader;
    if (!Base) return null;

    function GMLoader(config) { Base.call(this, config); this._req = null; this._done = false; }
    GMLoader.prototype = Object.create(Base.prototype);
    GMLoader.prototype.constructor = GMLoader;

    GMLoader.prototype.load = function (context, config, callbacks) {
      var self = this;
      if (this.stats.loading.start) throw new Error("Loader can only be used once.");
      this.stats.loading.start = performance.now();
      this.context = context;
      this.config = config;
      this.callbacks = callbacks;

      var binary = context.responseType === "arraybuffer";
      var url = context.url || "";
      var name = url.split("/").pop().split("?")[0];
      var isM3u8 = /\.m3u8($|\?|#)/i.test(url);
      var isKey = /key/i.test(url) && !isM3u8;
      var label = (isM3u8 ? "[M3U8] " : isKey ? "[KEY]  " : "[SEG]  ") + name;

      if (binary) {
        var cached = fragCacheGet(url);
        if (cached) {
          this.stats.loading.end = performance.now();
          this.stats.loading.first = this.stats.loading.end;
          this.stats.loaded = this.stats.total = cached.byteLength;
          this.stats.bwEstimate = 0;
          log(label, "cache hit", cached.byteLength + "B");
          callbacks.onSuccess({ url: url, data: cached, code: 200 }, this.stats, context, { status: 200 });
          return;
        }
      }

      var opts = {
        url: url, method: "GET", timeout: 120000,
        headers: context.headers || {},
        onload: function (r) {
          if (self._done) return; self._done = true;
          if (r.status < 200 || r.status >= 300) {
            log(label, "HTTP", r.status);
            callbacks.onError({ code: r.status, text: "HTTP " + r.status }, context, null, self.stats);
            return;
          }
          var data = binary ? r.response : r.responseText;
          if (binary) { data = preparePayload(data, label); fragCacheSet(url, data); }
          var now = performance.now();
          self.stats.loading.end = now;
          self.stats.loading.first = self.stats.loading.first || now;
          var sz = binary ? (data.byteLength || 0) : (data ? data.length : 0);
          self.stats.loaded = self.stats.total = sz;
          self.stats.bwEstimate = sz * 8000 / Math.max(1, now - self.stats.loading.first);
          log(label, "OK", sz + "B");
          callbacks.onSuccess({ url: url, data: data, code: r.status }, self.stats, context, { status: r.status });
        },
        onerror: function () {
          if (self._done) return; self._done = true;
          log(label, "net error");
          callbacks.onError({ code: 0, text: "GM fail" }, context, null, self.stats);
        },
        ontimeout: function () {
          if (self._done) return; self._done = true;
          log(label, "timeout");
          callbacks.onError({ code: 0, text: "GM timeout" }, context, null, self.stats);
        }
      };
      if (binary) opts.responseType = "arraybuffer";
      this._req = GM_xmlhttpRequest(opts);
    };

    GMLoader.prototype.abortInternal = function () {
      if (this._req && typeof this._req.abort === "function")
        try { this._req.abort(); } catch (e) {}
    };
    GMLoader.prototype.abort = function () {
      this.abortInternal();
      if (this.callbacks && this.callbacks.onAbort) this.callbacks.onAbort(this.stats, this.context, null);
    };
    GMLoader.prototype.destroy = function () {
      this.abortInternal();
      this.callbacks = null; this.context = null; this.config = null;
    };
    return GMLoader;
  }

  function sanitizeUrl(raw) {
    var s = String(raw == null ? "" : raw).trim();
    if (!s) return s;

    var re = /https?:\/\//gi;
    var positions = [];
    var m;
    while ((m = re.exec(s)) !== null) positions.push(m.index);

    if (positions.length > 1) {
      var lastUrl = s.substring(positions[positions.length - 1]);
      if (/^https?:\/\/[^\s]+$/i.test(lastUrl)) {
        log("URL fix:", s, "->", lastUrl);
        return lastUrl;
      }
    }

    s = s.replace(/[\u200b-\u200f\ufeff]/g, "").trim();

    if (!/^https?:\/\//i.test(s)) {
      var idx = s.indexOf("http");
      if (idx > 0) {
        var tail = s.substring(idx);
        if (/^https?:\/\/[^\s]+$/i.test(tail)) {
          log("URL prefix strip:", s, "->", tail);
          return tail;
        }
      }
    }

    return s;
  }

  var box = null, video = null, statusEl = null, input = null;
  var retryOverlay = null, retryTitleEl = null, retryDetailEl = null;
  var hlsRef = null;
  var uiBound = false;
  var playTriggered = false;
  var stallCount = 0;
  var currentUrl = "";

  function setStatus(msg, color) {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.style.color = color || "#888";
  }

  var retryState = {
    visible: false,
    timer: null,
    countdown: 0
  };

  function ensureRetryOverlay() {
    if (retryOverlay && retryOverlay.isConnected) return;
    if (!video) return;

    retryOverlay = document.createElement("div");
    retryOverlay.id = "m3u8-retry-overlay";
    retryOverlay.style.cssText =
      "position:absolute;left:0;right:0;top:0;bottom:0;display:none;" +
      "align-items:center;justify-content:center;flex-direction:column;gap:10px;" +
      "background:rgba(0,0,0,0.62);backdrop-filter:blur(2px);" +
      "-webkit-backdrop-filter:blur(2px);z-index:10;color:#fff;" +
      "font-family:system-ui,sans-serif;text-align:center;padding:16px;" +
      "pointer-events:none;";

    var spinner = document.createElement("div");
    spinner.style.cssText =
      "width:38px;height:38px;border-radius:50%;" +
      "border:3px solid rgba(255,255,255,0.18);border-top-color:#ff8a3d;" +
      "animation:m3u8Spin 0.8s linear infinite;";

    retryTitleEl = document.createElement("div");
    retryTitleEl.style.cssText =
      "font-size:15px;font-weight:600;letter-spacing:.4px;color:#ffb37a;" +
      "text-shadow:0 2px 8px rgba(0,0,0,.5);";

    retryDetailEl = document.createElement("div");
    retryDetailEl.style.cssText =
      "font-size:12px;line-height:1.6;color:#cfd6e4;max-width:90%;" +
      "text-shadow:0 1px 4px rgba(0,0,0,.5);white-space:pre-wrap;" +
      "word-break:break-all;";

    retryOverlay.appendChild(spinner);
    retryOverlay.appendChild(retryTitleEl);
    retryOverlay.appendChild(retryDetailEl);

    var stage = video.parentNode;
    if (stage) {
      try { if (getComputedStyle(stage).position === "static") stage.style.position = "relative"; } catch (e) {}
      stage.appendChild(retryOverlay);
    }
  }

  function showRetry(title, detail, countdownSec) {
    ensureRetryOverlay();
    if (!retryOverlay) return;
    retryState.visible = true;
    retryOverlay.style.display = "flex";
    if (retryTitleEl) retryTitleEl.textContent = title || "retry...";
    if (retryDetailEl) retryDetailEl.textContent = detail || "";

    if (retryState.timer) { clearInterval(retryState.timer); retryState.timer = null; }
    if (countdownSec && countdownSec > 0) {
      retryState.countdown = countdownSec;
      retryState.timer = setInterval(function () {
        retryState.countdown--;
        if (retryState.countdown <= 0) {
          clearInterval(retryState.timer);
          retryState.timer = null;
          if (retryDetailEl) retryDetailEl.textContent = (detail || "") + "\nretrying...";
          return;
        }
        if (retryDetailEl)
          retryDetailEl.textContent = (detail || "") + "\n" + retryState.countdown + "s";
      }, 1000);
    }
  }

  function hideRetry() {
    if (!retryOverlay) return;
    if (!retryState.visible) return;
    retryState.visible = false;
    clearInterval(retryState.timer);
    retryState.timer = null;
    retryState.countdown = 0;
    retryOverlay.style.display = "none";
  }

  function txBufferedEnd(v) {
    try {
      if (!v || !v.buffered || !v.buffered.length) return 0;
      var ct = v.currentTime;
      for (var i = 0; i < v.buffered.length; i++) {
        if (v.buffered.start(i) <= ct && ct <= v.buffered.end(i)) {
          return v.buffered.end(i);
        }
      }
      return v.buffered.end(v.buffered.length - 1);
    } catch (e) { return 0; }
  }

  function autoPlay(v) {
    var p;
    try { p = v.play(); } catch (e) { return; }
    if (!p || !p.catch) return;
    p.catch(function (err) {
      if (err && err.name === "NotAllowedError") {
        v.muted = true;
        v.play().catch(function () {});
      }
    });
  }

  function findGapAhead(v) {
    try {
      var ct = v.currentTime, buf = v.buffered;
      for (var i = 0; i < buf.length; i++) {
        var s = buf.start(i), e = buf.end(i);
        if (s <= ct && ct < e) {
          if (i + 1 < buf.length) {
            var nextS = buf.start(i + 1);
            if (nextS - e >= 0 && nextS - e < 1.5) return nextS + 0.05;
          }
          return -1;
        }
        if (i + 1 < buf.length && ct >= e && ct < buf.start(i + 1)) {
          if (buf.start(i + 1) - ct < 1.5) return buf.start(i + 1) + 0.05;
        }
      }
    } catch (e) {}
    return -1;
  }

  function bindVideoEvents() {
    if (uiBound || !video) return;
    uiBound = true;

    video.addEventListener("canplay", function () {
      if (!playTriggered) { playTriggered = true; video.muted = true; autoPlay(video); }
    });

    video.addEventListener("seeking", function () {
      var idx = Math.floor(video.currentTime / 4);
      var oldMax = maxPreload;
      maxPreload = 12;
      preloadReset();
      ensurePreload(Math.max(0, idx - 1), 24);
      if (hlsRef) { try { hlsRef.startLoad(); } catch (e) {} }
      setTimeout(function () { maxPreload = oldMax; }, 10000);
    });

    video.addEventListener("seeked", function () {
      var idx = Math.floor(video.currentTime / 4);
      ensurePreload(Math.max(0, idx - 1), 24);
    });

    video.addEventListener("playing", function () {
      stallCount = 0;
      hideRetry();
      setStatus("playing " + video.currentTime.toFixed(1) + "s / "
        + (video.duration ? video.duration.toFixed(0) : "?") + "s", "#6f6");
    });

    video.addEventListener("waiting", function () {
      var idx = Math.floor(video.currentTime / 4);
      preloadReset();
      ensurePreload(idx, 30);
      setStatus("buffering...", "#fc0");
    });

    video.addEventListener("timeupdate", function () {
      if (video.currentTime > 0 && video.currentTime < video.duration && !retryState.visible) {
        var bufEnd = txBufferedEnd(video);
        var s = "playing " + video.currentTime.toFixed(1) + "s / "
          + video.duration.toFixed(0) + "s  buffer:" + bufEnd.toFixed(1) + "s";
        if (segUrls.length) s += "  seg:" + segUrls.length;
        var cache = Object.keys(fragCache).length;
        if (cache) s += "  cache:" + cache;
        setStatus(s, "#6f6");
      }
    }, { passive: true });

    video.addEventListener("error", function () {
      var er = video.error;
      setStatus("video.error " + (er ? er.code + ":" + er.message : "?"), "#f66");
    });
  }

  function build() {
    if (box && box.isConnected) return;
    if (!document.body) { document.addEventListener("DOMContentLoaded", build); return; }

    box = document.createElement("div");
    box.id = "_m3u8_box";
    box.style.cssText =
      "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);" +
      "width:580px;max-width:94vw;background:#0d0d0d;border-radius:12px;" +
      "z-index:2147483647;overflow:hidden;box-shadow:0 8px 40px rgba(0,0,0,.7);" +
      "font-family:system-ui,sans-serif;";

    var row = document.createElement("div");
    row.style.cssText = "display:flex;gap:6px;padding:10px;background:#1a1a2e;";

    input = document.createElement("input");
    input.value = "";
    input.style.cssText =
      "flex:1;padding:8px 10px;border-radius:6px;border:1px solid #333;" +
      "background:#111;color:#eee;font-size:12px;";
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        var u = sanitizeUrl(input.value);
        if (!u) return;
        input.value = u;
        startPlay(u);
      }
    });

    var playBtn = document.createElement("button");
    playBtn.textContent = "play";
    playBtn.style.cssText =
      "padding:8px 16px;border-radius:6px;border:none;background:#1a73e8;" +
      "color:#fff;cursor:pointer;font-size:12px;font-weight:bold;";
    playBtn.onclick = function () {
      var u = sanitizeUrl(input.value);
      if (!u) { setStatus("input URL", "#f66"); return; }
      input.value = u;
      startPlay(u);
    };

    var closeBtn = document.createElement("button");
    closeBtn.textContent = "x";
    closeBtn.style.cssText =
      "padding:8px 12px;border-radius:6px;border:none;background:#333;" +
      "color:#aaa;cursor:pointer;font-size:14px;";
    closeBtn.onclick = function () {
      if (hlsRef) { try { hlsRef.destroy(); } catch (e) {} hlsRef = null; }
      if (video) { try { video.pause(); } catch (e) {} }
      hideRetry();
      resetPreload();
      box.remove();
    };

    row.append(input, playBtn, closeBtn);

    var stage = document.createElement("div");
    stage.style.cssText = "position:relative;background:#000;line-height:0;";

    video = document.createElement("video");
    video.controls = true;
    video.playsInline = true;
    video.muted = true;
    video.autoplay = false;
    video.style.cssText = "width:100%;display:block;aspect-ratio:16/9;background:#000;";
    stage.appendChild(video);

    statusEl = document.createElement("div");
    statusEl.style.cssText =
      "padding:6px 12px;font-size:11px;color:#888;background:#111;" +
      "min-height:28px;white-space:pre-wrap;word-break:break-all;";
    statusEl.textContent = "ready | console " + TAG;

    box.append(row, stage, statusEl);
    document.body.appendChild(box);

    ensureRetryOverlay();
    bindVideoEvents();
  }

  function startPlay(url, mode) {
    url = sanitizeUrl(url);
    if (!url) { setStatus("empty URL", "#f66"); return; }

    build();
    if (input) input.value = url;

    var HlsCtor = getHls();
    if (!HlsCtor) {
      setStatus("waiting hls.js...", "#fc0");
      var tries = 0;
      var t = setInterval(function () {
        tries++;
        if (getHls()) { clearInterval(t); startPlay(url, mode); }
        else if (tries > 40) { clearInterval(t); setStatus("hls.js not loaded", "#f66"); }
      }, 250);
      return;
    }

    currentUrl = url;

    if (hlsRef) { try { hlsRef.destroy(); } catch (e) {} hlsRef = null; }
    playTriggered = false;
    stallCount = 0;
    hideRetry();
    resetPreload();

    var useWorker = (mode !== "noworker");
    var parsedCount = 0;

    var cfg = {
      enableWorker: useWorker,
      lowLatencyMode: false,
      startFragPrefetch: true,
      maxBufferLength: 60,
      maxMaxBufferLength: 1200,
      maxBufferSize: 200 * 1000 * 1000,
      maxBufferHole: 1.0,
      bufferPruning: true,
      backBufferLength: 60,
      startLevel: 0,
      fragLoadingTimeOut: 120000,
      fragLoadingMaxRetry: 8,
      fragLoadingRetryDelay: 500,
      manifestLoadingTimeOut: 30000,
      manifestLoadingMaxRetry: 5,
      levelLoadingTimeOut: 30000,
      levelLoadingMaxRetry: 5,
      abrEwmaDefaultEstimate: 10e6,
      abrBandWidthFactor: 0.95,
      abrBandWidthUpFactor: 0.7,
      nudgeMaxRetry: 200,
      nudgeOffset: 0.05,
      highBufferWatchdogPeriod: 2,
      nudgeOnVideoHole: true,
      appendErrorMaxRetry: 5,
      maxLoadingDelay: 8
    };

    var LoaderCls = makeGMLoader();
    if (LoaderCls) cfg.loader = LoaderCls;

    var hls = hlsRef = new HlsCtor(cfg);
    var netRetry = 0, mediaRetry = 0;

    hls.on(HlsCtor.Events.MANIFEST_PARSED, function (e, d) {
      log("MANIFEST_PARSED:", d.levels ? d.levels.length : "?", "levels  worker=" + useWorker,
        "loader=" + (LoaderCls ? "GM" : "default"));
      setStatus("manifest OK, loading...", "#6f6");
    });

    hls.on(HlsCtor.Events.LEVEL_LOADED, function (e, d) {
      var segs = d.details ? d.details.details : null;
      if (!segs || !segs.length) return;
      segUrls = [];
      for (var i = 0; i < segs.length; i++) {
        segUrls[i] = resolveSegUrl(sanitizeUrl(segs[i].relurl), url);
      }
      log("LEVEL_LOADED:", segs.length, "segments");
      setStatus(segs.length + " seg, preloading...", "#fc0");
      ensurePreload(0, preloadAhead);
    });

    hls.on(HlsCtor.Events.FRAG_LOADED, function (e, d) {
      if (d.frag) {
        log("FRAG_LOADED:", d.frag.sn, d.payload ? d.payload.byteLength + "B" : "?");
        if (retryState.visible) hideRetry();
      }
    });

    hls.on(HlsCtor.Events.FRAG_PARSED, function (e, d) {
      if (!d.frag) return;
      parsedCount++;
      log("FRAG_PARSED:", d.frag.sn, "OK");
      if (!playTriggered && d.frag.sn >= 1) {
        playTriggered = true;
        log(">>> play()");
        video.muted = true;
        autoPlay(video);
        setStatus("playing...", "#6f6");
        startPreloadTimer();
      }
    });

    hls.on(HlsCtor.Events.ERROR, function (e, data) {
      if (!data) return;
      var info = data.type + "/" + data.details + (data.fatal ? " [FATAL]" : "");
      log("ERROR:", info);

      if (data.details === "internalException" && useWorker && parsedCount === 0) {
        log("worker fail, fallback main thread");
        setStatus("worker fail, fallback...", "#fc0");
        showRetry("worker unavailable, fallback", "reloading in main thread");
        setTimeout(function () {
          if (hlsRef === hls) { try { hls.destroy(); } catch (e2) {} }
          hideRetry();
          startPlay(url, "noworker");
        }, 150);
        return;
      }

      if (!data.fatal) {
        if (data.type === HlsCtor.ErrorTypes.MEDIA_ERROR &&
            data.details === "bufferStalledError") {
          stallCount++;
          var ct = video.currentTime;
          var seekTo = findGapAhead(video);
          if (seekTo >= 0 && seekTo > ct) {
            log("stall: seek " + ct.toFixed(2) + " -> " + seekTo.toFixed(2));
            try { video.currentTime = seekTo; } catch (err) {}
            setStatus("skip gap -> " + seekTo.toFixed(1) + "s", "#fc0");
          } else if (stallCount <= 8) {
            var idx = Math.floor(video.currentTime / 4);
            preloadReset();
            ensurePreload(idx, 30);
            showRetry("buffer stall, refilling",
              "pos " + ct.toFixed(1) + "s\npreload " + Math.min(30, Math.max(0, segUrls.length - idx)) + " seg");
            setStatus("buffer stall, refilling...", "#fc0");
            setTimeout(function () {
              if (hlsRef !== hls) return;
              try { hls.startLoad(); } catch (e2) {}
              autoPlay(video);
            }, 120);
          }
        }
        return;
      }

      if (data.type === HlsCtor.ErrorTypes.NETWORK_ERROR && netRetry < 10) {
        netRetry++;
        setStatus("net retry #" + netRetry, "#fc0");
        log("net retry:", data.details);
        showRetry("net retry #" + netRetry,
          "reason: " + data.details + "\nURL: " + ((data.url || "-").split("/").pop().split("?")[0]),
          1);
        setTimeout(function () {
          if (hlsRef === hls) hls.startLoad();
        }, 500);
        return;
      }

      if (data.type === HlsCtor.ErrorTypes.MEDIA_ERROR && mediaRetry < 5) {
        mediaRetry++;
        setStatus("media recover #" + mediaRetry, "#fc0");
        log("media recover:", data.details);
        showRetry("media recover #" + mediaRetry, "reason: " + data.details, 1);
        try { hls.recoverMediaError(); } catch (e2) { log("recover fail:", e2 && e2.message); }
        return;
      }

      setStatus("fatal: " + data.details, "#f66");
      log("fatal:", data);
      showRetry("fatal: " + data.details,
        "net retry " + netRetry + " / media recover " + mediaRetry + " exhausted");
    });

    log("=== start:", url, "===  loader=" + (LoaderCls ? "GM" : "default") + " worker=" + useWorker);
    hls.loadSource(url);
    hls.attachMedia(video);
  }

  function boot() {
    log("v1.0.0 ready");

    var style = document.createElement("style");
    style.textContent = "@keyframes m3u8Spin{100%{transform:rotate(360deg)}}";
    (document.head || document.documentElement).appendChild(style);

    build();

    try {
      W.__m3u8Player = {
        version: "1.0.0",
        play: startPlay,
        getUrl: function () { return currentUrl; }
      };
    } catch (e) {}
  }

  boot();
})();