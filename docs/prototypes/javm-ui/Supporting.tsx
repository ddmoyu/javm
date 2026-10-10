import { useState } from "react";
import {
  Button,
  Checkbox,
  Collapse,
  Menu,
  Modal,
  Progress,
  SegmentedControl,
  Select,
  Slider,
  Switch,
  TextInput,
} from "@mantine/core";
import { usePrototype } from "./state";
import { Icon } from "./visuals";
import { PageActions, Pill } from "./ui";
import { ObjectMenu, ObjectMenuButton } from "./ObjectMenu";

export function Directories() {
  const { add, notice, films } = usePrototype();
  const [health, setHealth] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  return (
    <>
      <PageActions>
        <Button
          variant="default"
          leftSection={<Icon name="scan" />}
          onClick={() => setHealth(true)}
        >
          检查片库
        </Button>
        <Button
          variant="default"
          leftSection={<Icon name="refresh" />}
          onClick={() => {
            notice("扫描完成，未发现新增文件");
          }}
        >
          扫描变化
        </Button>
        <Button leftSection={<Icon name="plus" />} onClick={() => add("import")}>
          添加目录
        </Button>
      </PageActions>
      <div className="section-caption">
        <h3>媒体目录</h3>
        <button type="button" className="text-link" onClick={() => setAdvanced(!advanced)}>
          扫描规则
          <Icon name="down" size={14} />
        </button>
      </div>
      <Collapse expanded={advanced}>
        <div className="panel inline-form">
          <Checkbox label="包含子目录" defaultChecked />
          <Checkbox label="跳过已入库文件" defaultChecked />
          <TextInput label="视频扩展名" defaultValue="mp4, mkv, avi, ts" />
          <Button variant="light" size="sm" onClick={() => notice("扫描规则已保存")}>
            保存规则
          </Button>
        </div>
      </Collapse>
      {[
        {
          name: "主片库",
          path: "D:\\Media\\Library",
          count: Math.ceil((films.length * 2) / 3),
          used: 36,
          space: "40.9 TB 可用 / 64 TB",
        },
        {
          name: "精选收藏",
          path: "E:\\Collections",
          count: Math.floor(films.length / 3),
          used: 61,
          space: "12.5 TB 可用 / 32 TB",
        },
      ].map((directory) => (
        <ObjectMenu
          key={directory.path}
          items={
            <>
              <Menu.Label>{directory.name}</Menu.Label>
              <Menu.Item
                leftSection={<Icon name="refresh" />}
                onClick={() => {
                  notice(`${directory.name}：扫描完成`);
                }}
              >
                扫描变化
              </Menu.Item>
              <Menu.Item leftSection={<Icon name="settings" />} onClick={() => setAdvanced(true)}>
                扫描规则
              </Menu.Item>
              <Menu.Item
                leftSection={<Icon name="folder" />}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(directory.path);
                    notice("目录路径已复制");
                  } catch {
                    notice("复制失败，请重试");
                  }
                }}
              >
                复制目录路径
              </Menu.Item>
            </>
          }
        >
          <section className="directory-row panel">
            <div className="directory-icon">
              <Icon name="folder" size={30} />
            </div>
            <div className="directory-info">
              <h3>
                {directory.name}
                <Pill tone="success">可访问</Pill>
              </h3>
              <p className="path-text">{directory.path}</p>
              <div className="row small muted">
                <span>{directory.count} 部影片</span>
                <span>包含子目录</span>
                <span>增量扫描</span>
              </div>
            </div>
            <div className="disk-space">
              <span>{directory.space}</span>
              <Progress value={directory.used} size={4} color="gray" />
            </div>
            <Button
              variant="default"
              size="sm"
              onClick={() => {
                notice(`${directory.name}：扫描完成`);
              }}
            >
              扫描
            </Button>
            <ObjectMenuButton label={`${directory.name} 目录选项`} />
          </section>
        </ObjectMenu>
      ))}
      <Modal opened={health} onClose={() => setHealth(false)} title="片库检查" centered>
        <div className="health-result">
          <Pill tone="success">文件路径正常</Pill>
          <Pill tone="warning">{films.filter((film) => film.missing).length} 部资料待补全</Pill>
          <Pill>1 组可能重复</Pill>
        </div>
        <p className="muted">重复项会按番号、文件大小与所在位置对照，确认保留项后才执行整理。</p>
        <div className="notice-strip">检查只生成建议，不自动删除文件。</div>
        <div className="modal-footer">
          <Button
            onClick={() => {
              setHealth(false);
              notice("检查结果已保留");
            }}
          >
            了解了
          </Button>
        </div>
      </Modal>
    </>
  );
}

const settingSections = [
  "常规与外观",
  "下载与存储",
  "刮削与资料",
  "播放器",
  "网络与代理",
  "AI 辅助",
  "MetaTube",
  "日志与更新",
];

export function Settings() {
  const {
    theme,
    setTheme,
    notice,
    closeToTray,
    setCloseToTray,
    cardClickToPlay,
    setCardClickToPlay,
  } = usePrototype();
  const [section, setSection] = useState("常规与外观");
  const [advanced, setAdvanced] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [metatube, setMetatube] = useState(true);
  const markDirty = () => setDirty(true);
  return (
    <>
      <PageActions>
        <Button
          variant="default"
          disabled={!dirty}
          onClick={() => {
            setDirty(false);
            notice("设置已保存");
          }}
        >
          保存设置{dirty ? " · 有修改" : ""}
        </Button>
      </PageActions>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分类">
          {settingSections.map((name) => (
            <button
              key={name}
              type="button"
              className={section === name ? "active" : ""}
              aria-current={section === name ? "page" : undefined}
              onClick={() => {
                setSection(name);
                setAdvanced(false);
              }}
            >
              {name}
              <Icon name="chevron" size={14} />
            </button>
          ))}
        </nav>
        <div className="settings-content">
          <section
            className="panel settings-panel"
            aria-label={`${section}选项`}
            onChange={markDirty}
          >
            <div hidden={section !== "常规与外观"}>
              <div className="setting-row">
                <div>
                  <strong>界面主题</strong>
                  <p>一套视觉，深浅两种氛围</p>
                </div>
                <div className="theme-choices">
                  <button
                    type="button"
                    aria-pressed={theme === "dark"}
                    className={theme === "dark" ? "chosen" : ""}
                    onClick={() => setTheme("dark")}
                  >
                    <span className="theme-swatch dark-swatch" />
                    <span>夜幕</span>
                    {theme === "dark" && <Icon name="check" size={13} />}
                  </button>
                  <button
                    type="button"
                    aria-pressed={theme === "light"}
                    className={theme === "light" ? "chosen" : ""}
                    onClick={() => setTheme("light")}
                  >
                    <span className="theme-swatch light-swatch" />
                    <span>晨光</span>
                    {theme === "light" && <Icon name="check" size={13} />}
                  </button>
                </div>
              </div>
              <div className="setting-row">
                <div>
                  <strong id="card-click-label">单击卡片</strong>
                </div>
                <SegmentedControl
                  aria-labelledby="card-click-label"
                  value={cardClickToPlay ? "play" : "details"}
                  data={[
                    { value: "play", label: "播放影片" },
                    { value: "details", label: "打开详情" },
                  ]}
                  onChange={(value) => {
                    setCardClickToPlay(value === "play");
                    markDirty();
                  }}
                />
              </div>
              <div className="setting-row">
                <div>
                  <strong>关闭窗口后留在托盘</strong>
                  <p>后台任务继续运行，主动退出时结束</p>
                </div>
                <Switch
                  aria-label="关闭窗口后留在托盘"
                  checked={closeToTray}
                  onChange={(event) => setCloseToTray(event.currentTarget.checked)}
                />
              </div>
              <div className="setting-row">
                <div>
                  <strong>记住上次浏览位置</strong>
                  <p>下次打开时回到熟悉的页面</p>
                </div>
                <Switch aria-label="记住上次浏览位置" defaultChecked />
              </div>
              <div className="setting-row">
                <div>
                  <strong>显示语言</strong>
                  <p>应用界面的语言</p>
                </div>
                <Select
                  onChange={markDirty}
                  aria-label="显示语言"
                  defaultValue="简体中文"
                  data={["简体中文", "English"]}
                  w={150}
                />
              </div>
            </div>
            <div hidden={section !== "下载与存储"}>
              <div className="setting-block">
                <TextInput
                  label="默认下载目录"
                  defaultValue="D:\Media\Downloads"
                  description="新任务自动使用此位置"
                />
              </div>
              <div className="setting-row">
                <div>
                  <strong>同时下载</strong>
                  <p>其余任务自动排队</p>
                </div>
                <Select
                  onChange={markDirty}
                  aria-label="同时下载任务数"
                  defaultValue="2 个任务"
                  data={["1 个任务", "2 个任务", "3 个任务", "4 个任务"]}
                  w={150}
                />
              </div>
              <div className="setting-row">
                <div>
                  <strong>下载后自动补全资料</strong>
                  <p>视频下载成功后继续刮削</p>
                </div>
                <Switch aria-label="下载后自动补全资料" defaultChecked />
              </div>
              <div className="setting-row">
                <div>
                  <strong>完成后自动加入片库</strong>
                  <p>减少手动导入步骤</p>
                </div>
                <Switch aria-label="完成后自动加入片库" defaultChecked />
              </div>
              <div className="setting-row">
                <div>
                  <strong>记住单次修改的目录</strong>
                  <p>下次新建时沿用</p>
                </div>
                <Switch aria-label="记住单次修改的目录" defaultChecked />
              </div>
            </div>
            <div hidden={section !== "刮削与资料"}>
              <div className="setting-row">
                <div>
                  <strong>已有资料</strong>
                  <p>默认保留手动整理的内容</p>
                </div>
                <Select
                  onChange={markDirty}
                  aria-label="已有资料处理策略"
                  defaultValue="只补全缺失"
                  data={["只补全缺失", "每次确认", "按来源优先级更新"]}
                  w={170}
                />
              </div>
              <div className="setting-row">
                <div>
                  <strong>自动选择最佳匹配</strong>
                  <p>番号一致时直接推荐，否则让你确认</p>
                </div>
                <Switch aria-label="自动选择最佳匹配" defaultChecked />
              </div>
              <div className="setting-row">
                <div>
                  <strong>写入本地 NFO</strong>
                  <p>将影片资料保存在视频目录</p>
                </div>
                <Switch aria-label="写入本地 NFO" defaultChecked />
              </div>
              <div className="setting-row">
                <div>
                  <strong>保存封面</strong>
                  <p>优先保留已有高清图片</p>
                </div>
                <Switch aria-label="保存封面" defaultChecked />
              </div>
              <div className="setting-block">
                <Select
                  onChange={markDirty}
                  label="默认资料来源"
                  defaultValue="自动（按优先级）"
                  data={["自动（按优先级）", "资料源 A", "MetaTube", "本地 NFO"]}
                />
              </div>
            </div>
            <div hidden={section !== "播放器"}>
              <div className="setting-row">
                <div>
                  <strong>默认播放器</strong>
                  <p>不支持的格式提示外部打开</p>
                </div>
                <Select
                  onChange={markDirty}
                  aria-label="默认播放器"
                  defaultValue="内置播放器"
                  data={["内置播放器", "系统默认", "自定义外部播放器"]}
                  w={190}
                />
              </div>
              <div className="setting-row">
                <div>
                  <strong>记住播放进度</strong>
                  <p>下次从上次位置继续</p>
                </div>
                <Switch aria-label="记住播放进度" defaultChecked />
              </div>
              <div className="setting-block">
                <TextInput label="外部播放器路径" placeholder="未指定时使用系统默认" />
              </div>
              <div className="setting-row">
                <div>
                  <strong>默认音量</strong>
                  <p>播放前仍可随时调整</p>
                </div>
                <Slider thumbLabel="默认音量" defaultValue={70} w={150} onChange={markDirty} />
              </div>
            </div>
            <div hidden={section !== "网络与代理"}>
              <div className="setting-block">
                <Select
                  onChange={markDirty}
                  label="连接方式"
                  defaultValue="跟随系统"
                  data={["跟随系统", "直接连接", "手动代理"]}
                />
                <TextInput
                  label="代理地址"
                  placeholder="http://127.0.0.1:7890"
                  description="手动代理时使用"
                />
              </div>
              <div className="setting-row">
                <div>
                  <strong>连接超时</strong>
                  <p>失败任务可单独重试</p>
                </div>
                <Select
                  onChange={markDirty}
                  aria-label="连接超时"
                  defaultValue="30 秒"
                  data={["15 秒", "30 秒", "60 秒"]}
                  w={140}
                />
              </div>
              <div className="setting-block">
                <Button variant="default" onClick={() => notice("连接超时，请检查网络设置")}>
                  测试连接
                </Button>
              </div>
            </div>
            <div hidden={section !== "AI 辅助"}>
              <div className="setting-row">
                <div>
                  <strong>启用辅助识别与翻译</strong>
                  <p>用于标题翻译、番号识别和别名归一</p>
                </div>
                <Switch aria-label="启用 AI 辅助" />
              </div>
              <div className="setting-block">
                <TextInput label="服务地址" placeholder="https://api.example.com/v1" />
                <TextInput label="模型名称" placeholder="输入服务提供的模型名称" />
                <TextInput
                  label="API Key"
                  type="password"
                  placeholder="输入 API 密钥"
                  autoComplete="off"
                />
              </div>
            </div>
            <div hidden={section !== "MetaTube"}>
              <div className="setting-row">
                <div>
                  <strong>MetaTube 服务</strong>
                  <p>资料聚合工具的运行状态</p>
                </div>
                <Pill tone={metatube ? "success" : "neutral"}>
                  {metatube ? "运行中" : "已停止"}
                </Pill>
              </div>
              <div className="setting-block">
                <div className="row">
                  <Button
                    variant="default"
                    onClick={() => {
                      setMetatube(!metatube);
                      notice(metatube ? "服务已停止" : "服务已启动");
                    }}
                  >
                    {metatube ? "停止服务" : "启动服务"}
                  </Button>
                  <Button
                    variant="light"
                    onClick={() => {
                      setMetatube(true);
                      notice("服务已重新启动");
                    }}
                  >
                    重新启动
                  </Button>
                  <Button
                    variant="subtle"
                    onClick={() => notice("暂时无法获取工具版本，请稍后重试")}
                  >
                    检查工具版本
                  </Button>
                </div>
                <p className="muted small">服务异常时，可查看日志并重新启动。</p>
              </div>
            </div>
            <div hidden={section !== "日志与更新"}>
              <div className="setting-row">
                <div>
                  <strong>应用版本</strong>
                  <p>JAVM 0.6.0</p>
                </div>
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => notice("暂时无法检查更新，请稍后重试")}
                >
                  检查更新
                </Button>
              </div>
              <div className="setting-row">
                <div>
                  <strong>任务日志</strong>
                  <p>查看失败原因与最近操作</p>
                </div>
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => notice("14:20 下载开始；14:24 资料来源连接超时")}
                >
                  查看日志
                </Button>
              </div>
              <div className="setting-row">
                <div>
                  <strong>日志级别</strong>
                  <p>详细日志用于排查问题</p>
                </div>
                <Select
                  onChange={markDirty}
                  aria-label="日志级别"
                  defaultValue="常规"
                  data={["常规", "详细", "仅错误"]}
                  w={150}
                />
              </div>
            </div>
          </section>
          <button
            className="advanced-setting-toggle"
            type="button"
            aria-expanded={advanced}
            onClick={() => setAdvanced(!advanced)}
          >
            <strong>高级设置</strong>
            <Icon name="down" />
          </button>
          <Collapse expanded={advanced}>
            <section className="panel settings-panel" onChange={markDirty}>
              <div className="setting-block">
                <TextInput label="文件命名规则" defaultValue="{番号}/{番号} - {标题}" />
                <TextInput label="FFmpeg 路径" placeholder="自动发现，或指定本地工具" />
                <TextInput label="缓存目录" defaultValue="应用默认缓存目录" />
              </div>
              <div className="setting-row">
                <div>
                  <strong>失败自动重试</strong>
                  <p>超过次数后交由手动处理</p>
                </div>
                <Select
                  onChange={markDirty}
                  aria-label="失败自动重试次数"
                  defaultValue="2 次"
                  data={["关闭", "1 次", "2 次", "3 次"]}
                  w={150}
                />
              </div>
            </section>
          </Collapse>
        </div>
      </div>
    </>
  );
}
