# M3U8 PNG Player

基于 [hls.js](https://github.com/videojs/hls.js) 的 **M3U8 / HLS 播放器油猴脚本**（Tampermonkey / Greasemonkey）。

核心特性：支持解析**伪装 / 封装在 PNG 文件尾部**的 HLS 视频分片，并配合预加载与卡顿自愈机制流畅播放。

## 功能

### 一、核心能力

#### 1. PNG 伪装分片剥壳
- 识别 PNG 文件魔数（`89 50 4E 47`）
- 逐块扫描 PNG chunk（IHDR → IDAT → ... → IEND）
- 把**追加在 PNG 末尾的真正视频分片数据**剥离出来，交给 hls.js 解码播放
- 适用场景：服务端把 HLS 分片伪装成 PNG 图片下发（规避 CDN 嗅探 / 防盗链）

#### 2. 跨域分片获取
- 通过 `GM_xmlhttpRequest` 绕过浏览器 CORS 跨域限制
- 自定义 `GMLoader` 替换 hls.js 默认 XHR loader，所有请求走油猴通道

#### 3. AES 密钥跨域获取
- 自动识别 M3U8 中的 AES-128 加密密钥请求（URL 含 `key`，非 `.m3u8`）
- 密钥请求同样通过 `GM_xmlhttpRequest` 跨域获取，确保加密流正常解密
- 解密运算由 hls.js 内部完成，脚本负责打通跨域密钥获取通道

#### 4. M3U8 解析与播放
- 基于 hls.js（通过 `@require` 从 jsDelivr CDN 自动加载 1.6.15 版）
- 支持多清晰度切换（manifest parsed 后自动加载 levels）
- 兼容标准 M3U8 和 PNG 伪装 M3U8 两种源

---

### 二、性能优化

#### 5. 分片预加载
- 提前预载后续 8 个分片（`preloadAhead = 8`）
- 最多 6 个并发预加载请求（`maxPreload = 6`）
- 每 2 秒轮询一次，根据播放进度动态补充预加载

#### 6. LRU + TTL 缓存
- `fragCache` 最多缓存 200 个分片
- 缓存过期时间 30 分钟（`fragCacheTTL = 1800000`）
- 超量时按时间戳淘汰最旧条目
- hls.js 请求分片时优先命中缓存，直接返回

#### 7. Seek 跳转加速
- 用户拖动进度条时临时提升并发上限到 12，预加载 24 个分片
- 10 秒后恢复默认配置

---

### 三、卡顿自愈

#### 8. Buffer 空隙跳过
- `findGapAhead` 检测 buffered ranges 之间的空隙（< 1.5 秒）
- 自动 seek 跳过空隙，避免卡死

#### 9. 卡顿重载
- 监听 `waiting` 事件和 `bufferStalledError`
- 重置预加载、批量预载 30 个分片、调用 `hls.startLoad()` 恢复
- 最多容忍 8 次 stall

#### 10. 网络错误重试
- 网络错误自动重试，最多 10 次，每次间隔 500ms
- 带 UI 倒计时提示

#### 11. 媒体错误恢复
- 调用 `hls.recoverMediaError()` 恢复解码错误，最多 5 次

#### 12. Worker 失败回退
- 如果 hls.js Web Worker 解码失败（`internalException`）
- 自动销毁并重新以主线程模式（`enableWorker: false`）重启播放

---

### 四、用户体验

#### 13. 悬浮播放器 UI
- 固定居中悬浮盒（580px 宽，最大 94vw）
- 包含：URL 输入框 + play 按钮 + 关闭按钮 + 视频区域 + 状态栏
- 16:9 宽高比，深色主题

#### 14. 重试遮罩
- 卡顿 / 重试时显示半透明遮罩 + 旋转动画 + 标题 + 详情
- 支持倒计时显示（如 "1s" 后重试）
- 恢复播放后自动隐藏

#### 15. 实时状态栏
- 显示当前播放时间 / 总时长
- 显示 buffer 缓冲长度
- 显示分片总数、缓存数量
- 不同状态用不同颜色（绿色 = 播放中，黄色 = 缓冲中，红色 = 错误）

#### 16. URL 清洗
- 去除零宽字符（`\u200b`-`\u200f`, `\ufeff`）
- 去除多余前缀（粘贴时混入的垃圾字符）
- 多个 URL 拼接时自动取最后一个有效 URL

#### 17. 全局 API 暴露
- `window.__m3u8Player` 对象，提供 `play(url)` 和 `getUrl()` 方法
- 可被页面其他脚本或控制台调用

---

### 五、自动播放

- 首个分片解析完成后自动 `play()`
- 浏览器阻止自动播放时自动 mute 后重试

---

### 六、hls.js 调优参数

| 参数 | 值 | 作用 |
|---|---|---|
| `maxBufferLength` | 60s | 前端最大缓冲 |
| `maxMaxBufferLength` | 1200s | 缓冲上限 |
| `maxBufferHole` | 1.0s | 允许的缓冲空洞 |
| `fragLoadingMaxRetry` | 8 | 分片加载重试 |
| `nudgeMaxRetry` | 200 | nudge 重试 |
| `appendErrorMaxRetry` | 5 | MSE 追加错误重试 |
| `backBufferLength` | 60s | 后向缓冲保留 |
| `startLevel` | 0 | 从最低清晰度开始 |

---

## 使用方法

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)（需支持 `GM_xmlhttpRequest`）。
2. 新建脚本，粘贴 [`m3u8-png-player.user.js`](./m3u8-png-player.user.js) 全部内容并保存。
3. 打开任意网页，出现播放盒后粘贴 M3U8 地址，回车 / 点击 play。

> 脚本通过 `@require` 自动从 CDN 加载 hls.js 1.6.15，请确保可访问 jsDelivr。

## 说明

本工具仅用于解析、播放合法授权的视频流。请遵守目标内容的版权与相关法规，勿用于侵权用途。