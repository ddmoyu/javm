# 真实公开视频取链、下载与解码验证

2026-10-11 23:08（Asia/Shanghai）开始本次成功验证。只使用官方播放器演示页及公开、非露骨的测试视频，没有连接成人来源、输入成人影片番号或读取用户媒体库。

## 真实链路

- 页面：[hls.js 官方演示页](https://hlsjs.video-dev.org/demo/)，使用其 `src` 参数选择公开样本。
- 视频：[Shaka 官方样本目录](https://github.com/shaka-project/shaka-player/blob/main/demo/common/assets.js)中的 Angel One HLS、MP4 测试片段。
- 应用实际模块：`createHiddenWebview` → `captureStreams` → `ResolutionService` → `ResolutionWorkerPool` → `createResolutionHttp`/常驻 libcurl → `ToolDownloadEngine` → `nativeDownloadHost`。
- 实际执行随项目的 Neutralino、数据库/媒体 Extension、N_m3u8DL-RE、精简 FFmpeg 和 MediaInfo；最后使用开发机完整 FFmpeg/ffprobe 对下载文件独立检查。
- 网页、清单与媒体分片全部来自真实公网；没有替换成 mock。取流与 HLS 检查使用本机已有代理配置；下载器沿用应用自己的直连及代理回退策略。

## 发现与修复

真实演示页地址的查询参数以 `.m3u8` 结束，旧判断对完整 URL 使用后缀正则，把网页本身加入候选并在 650ms 收集窗口后退出。保留的失败报告 `.tmp/public-resource-download-sGypVj/result.json` 显示：唯一候选是 HTML 网页，HTTP 200、`text/html`、20,963 字节，随后返回 `parse_failed`。

现仅检查 URL pathname 是否以 `.m3u8` 结尾，继续保留响应 MIME 的无后缀清单识别。新增延迟播放器用例通过：网页参数不会成为候选，直到真正的清单请求才返回。本轮只执行该新增用例；未重跑既有回归测试或全量测试。

## 产物证据

成功报告：`.tmp/public-resource-download-So1oiP/result.json`。

| 项目                                 | 实际结果                                                           |
| ------------------------------------ | ------------------------------------------------------------------ |
| 取链与 HLS 验证                      | 10,169ms，主清单与变体 HTTP 200，初始化段与分片 Range HTTP 206     |
| 应用取链、下载、合并、MediaInfo 检查 | 164,748ms 完成                                                     |
| 文件                                 | `downloads/Public-Angel-One-d7984e4c/Public-Angel-One.mp4`         |
| 大小                                 | 13,690,873 字节                                                    |
| 封装                                 | MP4                                                                |
| 视频                                 | H.264，768×576，25fps，一条视频轨                                  |
| 音频                                 | AAC，6 声道，一条音频轨                                            |
| 时长                                 | 60.000 秒，与清单一致                                              |
| 完整解码                             | FFmpeg `-xerror`，视频及音频全程解码，1,500 帧，stderr 为空        |
| SHA-256                              | `4c89b69c8c11a39a98e554804ba04659ef7533d9726621c46d932ea480b17d8c` |

取流实例在返回候选前按应用原有流程退出并清理，测试主宿主结束后监督器回收其进程树。测试文件和报告保留在本次独立 `.tmp` 目录。

## 可重复执行与边界

显式运行 `node scripts/test-public-resource-download.mjs` 才访问公网。脚本固定样本，不接受任意来源或番号；使用隔离宿主和数据库路径，不打开正式应用界面或用户数据库。脚本会调用 `scripts/verify-public-resource-file.mjs` 完整解码，开发机需提供完整 FFmpeg/ffprobe；也可用 `JAVM_VERIFY_FFMPEG`、`JAVM_VERIFY_FFPROBE` 指定验证工具。

本轮通过了新增用例、真实公网闭环、定向类型与 lint 检查。仅构建验证用前端宿主，未执行应用全量构建、发布打包或全量测试。结果证明上述公开样本可取链、可下载且为完整有效的视频；不证明成人来源、其他网站、会话依赖资源或指定成人影片可用。
