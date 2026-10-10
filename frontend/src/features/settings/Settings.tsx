import { useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Button,
  Group,
  Kbd,
  NavLink,
  SegmentedControl,
  Select,
  Stack,
  Text,
  UnstyledButton,
} from "@mantine/core";
import { useWorkspace } from "../../app/state";
import { BrandMark, Icon } from "../../components/icons";
import type { IconName } from "../../components/icons";
import { DownloadSettingsPanel } from "../downloads/DownloadSettingsPanel";
import { SettingCard, SettingRow } from "./SettingsPrimitives";
import packageInfo from "../../../../package.json";
import classes from "./Settings.module.css";
import { NetworkSettingsPanel } from "./NetworkSettingsPanel";
import { PlaybackSettingsPanel } from "./PlaybackSettingsPanel";
import { AiSettingsPanel } from "./AiSettingsPanel";
import { MetaTubeSettingsPanel } from "./MetaTubeSettingsPanel";
import { BackgroundSettingsPanel } from "./BackgroundSettingsPanel";
import { LogsPanel } from "./LogsPanel";
import { LegacyImportSettingsPanel } from "./LegacyImportSettingsPanel";
import { openExternalLink } from "../../platform/neutralino/externalLinks";
import { ApplicationUpdatePanel } from "./ApplicationUpdatePanel";

const contactLinks = [
  { title: "Telegram 群", label: "点击加入", url: "https://t.me/+5VEFnb2U_xgyNWY1" },
  { title: "问题反馈", label: "GitHub Issues", url: "https://github.com/ddmoyu/javm/issues" },
] as const;

const sections = [
  { id: "appearance", label: "外观与交互", icon: "sun", group: "偏好设置" },
  { id: "downloads", label: "下载与存储", icon: "download", group: "偏好设置" },
  { id: "player", label: "播放设置", icon: "play", group: "偏好设置" },
  { id: "library", label: "片库与迁移", icon: "folder", group: "偏好设置" },
  { id: "scrape", label: "刮削与资料", icon: "layers", group: "服务配置" },
  { id: "network", label: "网络与代理", icon: "globe", group: "服务配置" },
  { id: "ai", label: "AI 辅助", icon: "sparkles", group: "服务配置" },
  { id: "about", label: "关于 JAVM", icon: "info", group: "应用" },
] as const satisfies readonly { id: string; label: string; icon: IconName; group: string }[];
type Section = (typeof sections)[number]["id"];

function AppearanceSettings() {
  const { theme, setTheme, cardClickToPlay, setCardClickToPlay } = useWorkspace();
  return (
    <Stack gap="lg">
      <SettingCard title="界面外观" icon="sun">
        <fieldset className={classes.themeOptions} aria-label="界面主题">
          {(
            [
              ["light", "晨光", "明亮、清晰的浅色界面", "sun"],
              ["dark", "夜幕", "柔和、沉浸的深色界面", "moon"],
            ] as const
          ).map(([value, label, description, icon]) => (
            <UnstyledButton
              key={value}
              className={classes.themeOption}
              data-selected={theme === value || undefined}
              aria-label={label + "主题"}
              aria-pressed={theme === value}
              onClick={() => setTheme(value)}
            >
              <span className={classes.themePreview} data-tone={value} aria-hidden="true">
                <span className={classes.previewNav}>
                  <span />
                  <span />
                  <span />
                </span>
                <span className={classes.previewBody}>
                  <span className={classes.previewToolbar} />
                  <span className={classes.previewPosters}>
                    <span />
                    <span />
                    <span />
                  </span>
                </span>
              </span>
              <span className={classes.themeCaption}>
                <Icon name={icon} size={18} />
                <span className={classes.themeLabel}>
                  <Text span size="sm" fw={600}>
                    {label}
                  </Text>
                  <Text span size="xs" c="dimmed">
                    {description}
                  </Text>
                </span>
                <span className={classes.themeCheck}>
                  {theme === value && <Icon name="check" size={13} weight="bold" />}
                </span>
              </span>
            </UnstyledButton>
          ))}
        </fieldset>
        <SettingRow title="显示语言">
          <Text size="sm">简体中文</Text>
        </SettingRow>
      </SettingCard>
      <SettingCard title="浏览与交互" icon="sidebar">
        <SettingRow title="单击影片卡片" hint="收藏与更多操作按钮保持独立">
          <SegmentedControl
            aria-label="单击影片卡片"
            value={cardClickToPlay ? "play" : "details"}
            onChange={(value) => setCardClickToPlay(value === "play")}
            data={[
              { value: "play", label: "播放影片" },
              { value: "details", label: "打开详情" },
            ]}
          />
        </SettingRow>
        <SettingRow title="展开或折叠导航">
          <Group gap={4}>
            <Kbd>Ctrl</Kbd>
            <Text size="xs" c="dimmed">
              +
            </Text>
            <Kbd>B</Kbd>
          </Group>
        </SettingRow>
      </SettingCard>
      <BackgroundSettingsPanel />
    </Stack>
  );
}

export function Settings() {
  const { runtime, notice, legacyImport } = useWorkspace();
  const [section, setSection] = useState<Section>("appearance");
  const contentRef = useRef<HTMLDivElement>(null);
  const current = sections.find((item) => item.id === section)!;
  const selectSection = (value: string | null) => {
    if (!sections.some((item) => item.id === value)) return;
    setSection(value as Section);
    // 分类共享页面滚动容器；切换后从新分类的顶部开始。
    contentRef.current?.closest(".page-content")?.scrollTo({ top: 0 });
  };
  const panels: Record<Section, ReactNode> = {
    appearance: <AppearanceSettings />,
    downloads: <DownloadSettingsPanel key={runtime} />,
    player: <PlaybackSettingsPanel />,
    library: legacyImport ? (
      <LegacyImportSettingsPanel service={legacyImport} />
    ) : (
      <Text size="sm" c="dimmed">
        请在桌面应用中导入旧版片库。
      </Text>
    ),
    scrape: <MetaTubeSettingsPanel />,
    network: <NetworkSettingsPanel />,
    ai: <AiSettingsPanel />,
    about: (
      <Stack gap="lg">
        <div className={classes.aboutBrand}>
          <BrandMark size={56} />
          <div>
            <Text fz={24} fw={650}>
              JAVM
            </Text>
            <Text size="sm" c="dimmed">
              你的私人媒体库
            </Text>
          </div>
        </div>
        <SettingCard title="应用信息" icon="info">
          <SettingRow title="当前版本">
            <Text size="sm">{packageInfo.version}</Text>
          </SettingRow>
          <SettingRow title="开源许可">
            <Text size="sm">{packageInfo.license}</Text>
          </SettingRow>
          <ApplicationUpdatePanel />
        </SettingCard>
        <LogsPanel />
        <SettingCard title="联系方式" icon="link">
          {contactLinks.map((link) => (
            <SettingRow key={link.url} title={link.title}>
              <Button
                component="a"
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                variant="default"
                size="xs"
                rightSection={<Icon name="external" size={14} />}
                aria-label={`${link.title}：${link.label}（在浏览器中打开）`}
                onClick={(event) => {
                  if (runtime !== "desktop") return;
                  event.preventDefault();
                  void openExternalLink(link.url).catch(() =>
                    notice("打开链接失败，请检查默认浏览器后重试。"),
                  );
                }}
              >
                {link.label}
              </Button>
            </SettingRow>
          ))}
        </SettingCard>
      </Stack>
    ),
  };

  return (
    <div className={classes.layout}>
      <aside className={classes.sidebar}>
        <Text component="h1" className={classes.title}>
          设置
        </Text>
        <nav aria-label="设置分类" className={classes.navigation}>
          {(["偏好设置", "服务配置", "应用"] as const).map((group) => (
            <div key={group} className={classes.navGroup}>
              <Text className={classes.groupLabel}>{group}</Text>
              {sections
                .filter((item) => item.group === group)
                .map((item) => (
                  <NavLink
                    key={item.id}
                    component="button"
                    type="button"
                    label={item.label}
                    leftSection={<Icon name={item.icon} size={18} />}
                    active={section === item.id}
                    aria-current={section === item.id ? "page" : undefined}
                    aria-controls={"settings-" + item.id}
                    variant="light"
                    className={classes.navItem}
                    onClick={() => selectSection(item.id)}
                  />
                ))}
            </div>
          ))}
        </nav>
        <Select
          className={classes.mobileNavigation}
          aria-label="设置分类"
          value={section}
          onChange={selectSection}
          allowDeselect={false}
          data={sections.map((item) => ({ value: item.id, label: item.label }))}
        />
      </aside>
      <div className={classes.content} ref={contentRef}>
        <Group className={classes.pageHeading} justify="space-between" gap="sm">
          <Text component="h2" className={classes.sectionTitle}>
            {current.label}
          </Text>
          {section === "appearance" && (
            <Group gap={5} c="dimmed">
              <Icon name="check" size={14} />
              <Text size="xs">即时生效</Text>
            </Group>
          )}
        </Group>
        {/* 保持下载表单挂载，切换分类不会丢失未保存的输入或工具检查结果。 */}
        {sections.map((item) => (
          <section
            key={item.id}
            id={"settings-" + item.id}
            hidden={section !== item.id}
            aria-label={item.label + "选项"}
          >
            {panels[item.id]}
          </section>
        ))}
      </div>
    </div>
  );
}
