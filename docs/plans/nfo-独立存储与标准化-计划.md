# 功能计划:NFO 独立目录存储 + NFO 标准化

> 状态:**规划中(未动代码)**
> 创建日期:2026-06-17
> 含两个需求:① NFO+图片存到独立目录;② NFO 对齐标准 JAV NFO。

---

## 需求二:NFO 对齐标准 JAV NFO(改动小,先做)

当前 [generator.rs](../src-tauri/src/nfo/generator.rs) 生成的 NFO 已高度规范(`num`/`uniqueid`/`mpaa`/`set`/`maker`/`label`/`publisher`/`criticrating`/`countrycode` 齐全)。对照 JavSP / MDC / OpenAver 的标准 `movie.nfo`,**仅差 3 个字段**:

| 字段 | 标准 | 现状 | 改动 | 备注 |
|---|---|---|---|---|
| `<fanart>` | 独立横版背景图标签 | ❌ 仅 poster/cover/thumb | 小,立即可做 | 主要差异 |
| `<actor><thumb>` | 演员头像 URL | ❌ 仅 name+type | 小 | **依赖演员头像数据(暂无,后补)** |
| `<website>`/`<homepage>` | 详情页链接 | ❌ 无;`ScrapeMetadata` 未存 | 小 | 需在 `ScrapeMetadata` 加字段 |
| `uniqueid type` | 惯例 `type="num"` | `type="local"` | 极小 | 可选 |

**结论**:非重构,是「补字段」。集中在 `generator.rs`;`website` 需给 `ScrapeMetadata` 加字段;actor 头像待演员头像源就绪后补。

---

## 需求一:NFO + 图片存到独立目录

### 已确认的方向(经决策)
- **定位**:仍要兼容外部媒体库(Emby/Kodi/Jellyfin)。
- **目录结构**:每个番号一个子目录。

### ⚠️ 硬约束:必须配合 `.strm`
媒体库扫描目录时需看到「可播放项」才识别为影片。独立目录里没有视频,因此每个番号子目录需放一个 `.strm`(单行文本=视频真实路径),媒体库才会把它当影片并读取同目录 NFO/图片。

### 目标结构
```
<元数据根目录>/
  └─ ABC-123/
       ├─ ABC-123.strm        # 单行:视频真实绝对路径
       ├─ ABC-123.nfo
       ├─ ABC-123-poster.jpg  # NFO 内用相对文件名引用
       ├─ ABC-123-fanart.jpg
       ├─ ABC-123-thumb.jpg
       └─ extrafanart/        # 预览图
```
视频本体留原处不动;用户把媒体库指向 `<元数据根目录>`。

### 当前硬编码点(需改造)
- NFO 路径:`video_path.with_extension("nfo")`([generator.rs:246](../src-tauri/src/nfo/generator.rs))
- 图片:`{stem}-poster.jpg` 存视频父目录([assets.rs:49](../src-tauri/src/media/assets.rs))
- 预览图:视频同目录 `extrafanart/`(`EXTRAFANART_DIR_NAME`)

### 改动清单
1. **设置项**(`settings/`):新增「元数据存储模式」(跟随视频 / 独立目录)+「元数据根目录」路径。默认保持现状(跟随视频),不影响存量用户。
2. **NFO 保存**:`NfoGenerator::save()` 与 `save_nfo_for_video()` 增加「目标目录」参数;独立模式下目标=`<root>/<番号>/`,文件名 `<番号>.nfo`。
3. **图片下载/落地**:poster/thumb/fanart 与 extrafanart 的写入目录改为目标子目录;NFO 内继续用**相对文件名**引用(保证媒体库同目录可寻)。
4. **`.strm` 生成**:独立模式下,在子目录写 `<番号>.strm`,内容为视频真实绝对路径。
5. **数据库**:`videos` 表的 `dir_path`/`poster`/`thumb`/`fanart` 记录新位置(App 内展示仍能取到图)。
6. **复用**:已有 relocate/move 逻辑(assets.rs `build_artwork_target_path`/`move_optional_asset`)可部分复用。

### 改动量评估
中等。核心在 `generator.rs` + `assets.rs` + `settings/` + 数据库写入;新增 `.strm` 生成(很小)。无需重构现有同目录模式,作为可切换的第二模式叠加。

---

## 建议实施顺序
1. **先做需求二的 `<fanart>`**(最小、立即见效,独立于需求一)。
2. **需求一**:设置项 → 目标目录贯通 NFO/图片/extrafanart → `.strm` 生成 → 数据库路径。
3. 需求二的 `website` 字段(顺带 `ScrapeMetadata` 扩展)。
4. actor 头像:等演员头像数据源就绪后补(见竞品分析的演员头像提升点)。

## 待确认
- [ ] 番号子目录命名:用纯番号 `ABC-123/`,还是 `番号 标题/`?
- [ ] NFO 文件名:`<番号>.nfo` 还是 `movie.nfo`?(两者媒体库都认)
- [ ] `.strm` 是否仅在「视频不在元数据目录」时生成(同目录模式不需要)。
