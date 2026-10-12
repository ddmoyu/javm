# JavBus 重定向处理与离线包验证

日期：2026-10-11。后台真实请求已获用户授权；全程不显示来源内容，不打开浏览器或真实片库，不加载图片和视频。

## 修改

- 发现页 HTTP 适配器接入逐跳处理，支持 301、302、303、307、308，最多跟随 3 次。
- 仅允许已确认的 JavBus 裸域名与 `www` 域名，检查来源路径、实体／作品身份、搜索词及页号。兼容末尾斜杠、第一页和域名规范化；不将数字来源 ID 误认为页号。
- 真实来源的斜杠规范化会返回同站 HTTP `Location`。请求只使用其 HTTPS 等价地址，不发送明文请求。
- 每一跳都进入已有常驻 HTTP 调度器，保留连接复用、限频、取消和文件清理。全链共用 25 秒请求预算及 2 MiB 正文预算；底层 `maxRedirects` 始终为 0，由 TypeScript 校验后决定下一跳。
- 缺失／重复 Location、循环、超限、跳错实体、外站及验证入口均明确结束。域名变更不转发显式 Cookie 或 Authorization。诊断只含状态、次数、固定原因和是否升级 HTTPS。
- 验证入口仍不能保证自动通过，未伪造验证 Cookie，也未将验证页当成成功作品页。旧版特定的年龄验证 302 本次没有复现。

实现参考 libcurl 官方对 [FOLLOWLOCATION](https://curl.se/libcurl/c/CURLOPT_FOLLOWLOCATION.html) 和 [MAXREDIRS](https://curl.se/libcurl/c/CURLOPT_MAXREDIRS.html) 的说明；业务端主动检查每一跳，不启用无条件自动跟随。

## 本机后台结果

通过当前代理、Release 原生 HTTP Extension 和正式重定向处理函数进行 4 组请求。临时 HTML 只用于后台结构解析，文件与隔离目录均已删除，没有创建测试数据库。

| 场景 | 修复后响应链 | 解析结果 |
| --- | --- | --- |
| 规范分类地址 | 200 | 337 个分类 |
| 分类地址带末尾斜杠 | 301 → 200 | 337 个分类；HTTP Location 改用 HTTPS |
| 裸域名分类地址 | 301 → 200 | 337 个分类；规范化到 www |
| 演员目录带末尾斜杠 | 301 → 200 | 50 张演员卡；HTTP Location 改用 HTTPS |

本次真实站点复现的是 301。302 的成功链与失败分支由下列安全 mock 验证，不能据此声称所有真实 302 或验证入口均已解决。

## 定向检查

- `tests/javbus-redirects.test.ts`：新增 31 项通过，涵盖重定向状态、地址约束、身份一致性、循环、次数、总时限、大小预算、取消和日志脱敏。
- `tests/javbus-redirect-native.integration.test.ts`：新增 3 项通过。正式目录适配器、HTTP 调度器与 Release libcurl 共同请求回环 mock，验证 302 → 200、验证入口结束、第二跳取消及响应文件清理。成功链新连接数为 `[1, 0]`。
- 本轮涉及的 6 个 TypeScript 文件通过定向 lint 与类型检查。
- Release 原生构建、前端构建和 Neutralino 嵌入资源打包成功。前端保留原有大分块及 React 指令构建警告。
- 未运行全量测试、真实 UI、封面加载或下载验收。

## 交付

- 压缩包：`dist/offline/JAVM-1.0.0-windows-x64-offline-20261011T022344Z.zip`
- 大小：37,436,179 字节。
- SHA-256：`3b0f39d17a786f8b7da46ce03d843604b9b3930cb77143b0559a6ffab7927e82`
- 包含上一轮 JavBus 名称定位、分类、作品分页与详情接入，以及本次重定向处理和已有隐藏读取诊断修正。
- 包含原生 Extension、MediaInfo、FFmpeg、curl、N_m3u8DL-RE、MetaTube 及许可证。WebView2 使用系统安装的运行时，本包不携带。
- 目录校验脚本通过 76 个文件。另使用 .NET ZIP 读取器逐一解压流校验 76 个成员的长度与 SHA-256，确认无额外文件，整包 SHA-256 与交付记录一致。ZIP 内 Windows 路径分隔符在独立校验时归一化处理。
- 嵌入宿主中确认存在重定向代码、JavBus Worker 分支和人工验证识别代码；包内 Extension 与本轮测试的 Release 二进制一致，嵌入宿主与桌面构建一致。
- 未运行正式应用窗口，也未修改个人配置或数据库。
