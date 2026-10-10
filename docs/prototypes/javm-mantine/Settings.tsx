import { useState } from "react";
import type { ReactNode } from "react";
import {
  Button,
  Collapse,
  Divider,
  Group,
  NavLink,
  Paper,
  PasswordInput,
  Select,
  Slider,
  Stack,
  Switch,
  Text,
  TextInput,
  UnstyledButton,
  SegmentedControl,
} from "@mantine/core";
import { usePrototype } from "./state";
import { Icon } from "./icons";
import { Pill } from "./ui";

const sections = [
  "常规与外观",
  "下载与存储",
  "刮削与资料",
  "播放器",
  "网络与代理",
  "AI 辅助",
  "MetaTube",
  "日志与更新",
] as const;
type Section = (typeof sections)[number];

/** 设置行：左侧标题与说明，右侧控件。行与行之间用分隔线。 */
function Row({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <Group justify="space-between" wrap="nowrap" gap="xl" py={14} className="setting-row">
      <div>
        <Text size="sm" fw={600}>
          {title}
        </Text>
        {hint && (
          <Text size="xs" c="dimmed" mt={2}>
            {hint}
          </Text>
        )}
      </div>
      <div style={{ flex: "none" }}>{children}</div>
    </Group>
  );
}
function Block({ children }: { children: ReactNode }) {
  return (
    <Stack gap="sm" py={14} className="setting-row">
      {children}
    </Stack>
  );
}

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
  const [section, setSection] = useState<Section>("常规与外观");
  const [advanced, setAdvanced] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [metatube, setMetatube] = useState(true);
  const markDirty = () => setDirty(true);
  const panel: Record<Section, ReactNode> = {
    常规与外观: (
      <>
        <Row title="界面主题" hint="一套视觉，深浅两种氛围">
          <Group gap="xs">
            {(
              [
                ["dark", "夜幕", "linear-gradient(135deg,#2a0617,#110813 60%,#7c18d1)"],
                ["light", "晨光", "linear-gradient(135deg,#fff,#fbf3f6 60%,#ffd0e0)"],
              ] as const
            ).map(([value, label, swatch]) => (
              <UnstyledButton
                key={value}
                className="theme-choice"
                data-chosen={theme === value || undefined}
                aria-pressed={theme === value}
                onClick={() => setTheme(value)}
              >
                <span className="theme-swatch" style={{ background: swatch }} />
                <Text span size="sm">
                  {label}
                </Text>
                {theme === value && <Icon name="check" size={13} />}
              </UnstyledButton>
            ))}
          </Group>
        </Row>
        <Row title="单击卡片">
          <SegmentedControl
            aria-label="单击卡片"
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
        </Row>
        <Row title="关闭窗口后留在托盘" hint="后台任务继续运行，主动退出时结束">
          <Switch
            aria-label="关闭窗口后留在托盘"
            checked={closeToTray}
            onChange={(event) => setCloseToTray(event.currentTarget.checked)}
          />
        </Row>
        <Row title="记住上次浏览位置" hint="下次打开时回到熟悉的页面">
          <Switch aria-label="记住上次浏览位置" defaultChecked />
        </Row>
        <Row title="显示语言" hint="应用界面的语言">
          <Select
            onChange={markDirty}
            aria-label="显示语言"
            defaultValue="简体中文"
            data={["简体中文", "English"]}
            w={150}
          />
        </Row>
      </>
    ),
    下载与存储: (
      <>
        <Block>
          <TextInput
            label="默认下载目录"
            defaultValue="D:\Media\Downloads"
            description="新任务自动使用此位置"
          />
        </Block>
        <Row title="同时下载" hint="其余任务自动排队">
          <Select
            onChange={markDirty}
            aria-label="同时下载任务数"
            defaultValue="2 个任务"
            data={["1 个任务", "2 个任务", "3 个任务", "4 个任务"]}
            w={150}
          />
        </Row>
        <Row title="下载后自动补全资料" hint="视频下载成功后继续刮削">
          <Switch aria-label="下载后自动补全资料" defaultChecked />
        </Row>
        <Row title="完成后自动加入片库" hint="减少手动导入步骤">
          <Switch aria-label="完成后自动加入片库" defaultChecked />
        </Row>
        <Row title="记住单次修改的目录" hint="下次新建时沿用">
          <Switch aria-label="记住单次修改的目录" defaultChecked />
        </Row>
      </>
    ),
    刮削与资料: (
      <>
        <Row title="已有资料" hint="默认保留手动整理的内容">
          <Select
            onChange={markDirty}
            aria-label="已有资料处理策略"
            defaultValue="只补全缺失"
            data={["只补全缺失", "每次确认", "按来源优先级更新"]}
            w={170}
          />
        </Row>
        <Row title="自动选择最佳匹配" hint="番号一致时直接推荐，否则让你确认">
          <Switch aria-label="自动选择最佳匹配" defaultChecked />
        </Row>
        <Row title="写入本地 NFO" hint="将影片资料保存在视频目录">
          <Switch aria-label="写入本地 NFO" defaultChecked />
        </Row>
        <Row title="保存封面" hint="优先保留已有高清图片">
          <Switch aria-label="保存封面" defaultChecked />
        </Row>
        <Block>
          <Select
            onChange={markDirty}
            label="默认资料来源"
            defaultValue="自动（按优先级）"
            data={["自动（按优先级）", "资料源 A", "MetaTube", "本地 NFO"]}
          />
        </Block>
      </>
    ),
    播放器: (
      <>
        <Row title="默认播放器" hint="不支持的格式提示外部打开">
          <Select
            onChange={markDirty}
            aria-label="默认播放器"
            defaultValue="内置播放器"
            data={["内置播放器", "系统默认", "自定义外部播放器"]}
            w={190}
          />
        </Row>
        <Row title="记住播放进度" hint="下次从上次位置继续">
          <Switch aria-label="记住播放进度" defaultChecked />
        </Row>
        <Block>
          <TextInput label="外部播放器路径" placeholder="未指定时使用系统默认" />
        </Block>
        <Row title="默认音量" hint="播放前仍可随时调整">
          <Slider thumbLabel="默认音量" defaultValue={70} w={150} onChange={markDirty} />
        </Row>
      </>
    ),
    网络与代理: (
      <>
        <Block>
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
        </Block>
        <Row title="连接超时" hint="失败任务可单独重试">
          <Select
            onChange={markDirty}
            aria-label="连接超时"
            defaultValue="30 秒"
            data={["15 秒", "30 秒", "60 秒"]}
            w={140}
          />
        </Row>
        <Block>
          <Group>
            <Button variant="default" onClick={() => notice("连接超时，请检查网络设置")}>
              测试连接
            </Button>
          </Group>
        </Block>
      </>
    ),
    "AI 辅助": (
      <>
        <Row title="启用辅助识别与翻译" hint="用于标题翻译、番号识别和别名归一">
          <Switch aria-label="启用 AI 辅助" />
        </Row>
        <Block>
          <TextInput label="服务地址" placeholder="https://api.example.com/v1" />
          <TextInput label="模型名称" placeholder="输入服务提供的模型名称" />
          <PasswordInput label="API Key" placeholder="输入 API 密钥" autoComplete="off" />
        </Block>
      </>
    ),
    MetaTube: (
      <>
        <Row title="MetaTube 服务" hint="资料聚合工具的运行状态">
          <Pill tone={metatube ? "success" : "neutral"}>{metatube ? "运行中" : "已停止"}</Pill>
        </Row>
        <Block>
          <Group gap="xs">
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
            <Button variant="subtle" onClick={() => notice("暂时无法获取工具版本，请稍后重试")}>
              检查工具版本
            </Button>
          </Group>
          <Text size="xs" c="dimmed">
            服务异常时，可查看日志并重新启动。
          </Text>
        </Block>
      </>
    ),
    日志与更新: (
      <>
        <Row title="应用版本" hint="JAVM 0.6.0">
          <Button
            variant="default"
            size="sm"
            onClick={() => notice("暂时无法检查更新，请稍后重试")}
          >
            检查更新
          </Button>
        </Row>
        <Row title="任务日志" hint="查看失败原因与最近操作">
          <Button
            variant="default"
            size="sm"
            onClick={() => notice("14:20 下载开始；14:24 资料来源连接超时")}
          >
            查看日志
          </Button>
        </Row>
        <Row title="日志级别" hint="详细日志用于排查问题">
          <Select
            onChange={markDirty}
            aria-label="日志级别"
            defaultValue="常规"
            data={["常规", "详细", "仅错误"]}
            w={150}
          />
        </Row>
      </>
    ),
  };
  return (
    <>
      <Group justify="flex-end" mb="md">
        <Button
          variant="default"
          size="xs"
          disabled={!dirty}
          onClick={() => {
            setDirty(false);
            notice("设置已保存");
          }}
        >
          保存设置{dirty ? " · 有修改" : ""}
        </Button>
      </Group>
      <div className="settings-layout">
        <Paper
          component="nav"
          withBorder
          radius="lg"
          p={6}
          aria-label="设置分类"
          className="settings-nav"
        >
          {sections.map((name) => (
            <NavLink
              key={name}
              component="button"
              type="button"
              label={name}
              active={section === name}
              aria-current={section === name ? "page" : undefined}
              rightSection={<Icon name="chevron" size={14} />}
              variant="light"
              onClick={() => {
                setSection(name);
                setAdvanced(false);
              }}
            />
          ))}
        </Paper>
        <div>
          <Paper
            withBorder
            radius="lg"
            px="lg"
            py={4}
            aria-label={`${section}选项`}
            onChange={markDirty}
          >
            {panel[section]}
          </Paper>
          <UnstyledButton
            className="advanced-toggle"
            aria-expanded={advanced}
            onClick={() => setAdvanced(!advanced)}
          >
            <Text fw={600} size="sm">
              高级设置
            </Text>
            <Icon
              name="down"
              size={16}
              style={{ transform: advanced ? "rotate(180deg)" : undefined }}
            />
          </UnstyledButton>
          <Collapse expanded={advanced}>
            <Paper withBorder radius="lg" px="lg" py={4} onChange={markDirty}>
              <Block>
                <TextInput label="文件命名规则" defaultValue="{番号}/{番号} - {标题}" />
                <TextInput label="FFmpeg 路径" placeholder="自动发现，或指定本地工具" />
                <TextInput label="缓存目录" defaultValue="应用默认缓存目录" />
              </Block>
              <Divider />
              <Row title="失败自动重试" hint="超过次数后交由手动处理">
                <Select
                  onChange={markDirty}
                  aria-label="失败自动重试次数"
                  defaultValue="2 次"
                  data={["关闭", "1 次", "2 次", "3 次"]}
                  w={150}
                />
              </Row>
            </Paper>
          </Collapse>
        </div>
      </div>
    </>
  );
}
