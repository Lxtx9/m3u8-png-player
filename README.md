# M3U8 PNG Player

基于 [hls.js](https://github.com/videojs/hls.js) 的 **M3U8 / HLS 播放器油猴脚本**（Tampermonkey / Greasemonkey）。

核心特性：支持解析**伪装 / 封装在 PNG 文件尾部**的 HLS 视频分片，并配合预加载与卡顿自愈机制流畅播放。

## 功能

- 注入任意网页，提供悬浮播放盒（URL 输入 + 播放 + 状态栏）。
- **PNG 剥壳**：识别 PNG 魔数并逐块扫描 chunk 直至 `IEND`，把追加在 PNG 末尾的真正视频分片数据剥离出来交给 hls.js。
- **跨域分片获取**：通过 `GM_xmlhttpRequest` 绕过浏览器 CORS 限制拉取分片。
- **分片预加载 + LRU/TTL 缓存**：提前预载后续分片，降低卡顿。
- **卡顿自愈**：监听 buffer stall，自动定位 buffer 空隙并 seek 跳过；worker 失败回退主线程；网络重试。
- **URL 清洗**：去除零宽字符、多余前缀与重复链接。

## 使用方法

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)（需支持 `GM_xmlhttpRequest`）。
2. 新建脚本，粘贴 [`m3u8-png-player.user.js`](./m3u8-png-player.user.js) 全部内容并保存。
3. 打开任意网页，出现播放盒后粘贴 M3U8 地址，回车 / 点击 play。

> 脚本通过 `@require` 自动从 CDN 加载 hls.js 1.6.15，请确保可访问 jsDelivr。

## 说明

本工具仅用于解析、播放合法授权的视频流。请遵守目标内容的版权与相关法规，勿用于侵权用途。
