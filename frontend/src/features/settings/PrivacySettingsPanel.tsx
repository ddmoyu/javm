import { useEffect, useState, useSyncExternalStore } from "react";
import { Alert, Button, Group, PasswordInput, Select, Stack, Switch, Text } from "@mantine/core";
import { useWorkspace } from "../../app/state";
import { t, useLocale } from "../../i18n";
import { createPrivacyService } from "../../platform/neutralino/privacy";
import { defaultPrivacySettings } from "../../services/privacy/PrivacyService";
import type { PrivacySettings } from "../../services/privacy/PrivacyService";
import type { PrivacyShortcut } from "../../services/privacy/shortcuts";
import { SettingCard, SettingFields, SettingNote, SettingRow } from "./SettingsPrimitives";

function ShortcutEditor({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: PrivacyShortcut;
  onChange: (value: PrivacyShortcut) => void;
  disabled: boolean;
}) {
  const keys = [
    ...Array.from({ length: 11 }, (_, i) => `F${i + 1}`),
    ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  ];
  return (
    <Group gap="xs" wrap="nowrap" data-privacy-shortcut>
      <Select
        w={135}
        aria-label={t("{0}修饰键", label)}
        disabled={disabled}
        value={value.modifier || "none"}
        data={[{ value: "none", label: t("无修饰键") }, "Ctrl", "Alt", "Shift"]}
        allowDeselect={false}
        onChange={(modifier) => {
          if (modifier)
            onChange({
              ...value,
              modifier: modifier === "none" ? "" : (modifier as PrivacyShortcut["modifier"]),
            });
        }}
      />
      <Select
        w={100}
        aria-label={label}
        disabled={disabled}
        value={value.key}
        searchable
        data={keys.map((key) => ({ value: key, label: key === "Escape" ? "Esc" : key }))}
        allowDeselect={false}
        onChange={(key) => {
          if (key) onChange({ ...value, key });
        }}
      />
    </Group>
  );
}

export function PrivacySettingsPanel() {
  useLocale();
  const { runtime } = useWorkspace();
  const service = createPrivacyService(runtime);
  const snapshot = useSyncExternalStore(service.subscribe, service.getSnapshot);
  const settings = snapshot.settings;
  const [draft, setDraft] = useState(settings);
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const windows = runtime === "desktop" && window.NL_OS === "Windows";
  useEffect(() => setDraft(settings), [settings]);
  useEffect(() => {
    if (snapshot.locked || snapshot.hidden) {
      setCurrentPassword("");
      setPassword("");
      setConfirmation("");
      setError("");
      setMessage("");
    }
  }, [snapshot.locked, snapshot.hidden]);
  const perform = (operation: () => Promise<void>) => {
    setError("");
    setMessage("");
    void operation()
      .then(() => setMessage("设置已保存。"))
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : "设置保存失败，请重试。"),
      );
  };
  const update = (patch: Partial<PrivacySettings>) =>
    perform(() => service.saveSettings({ ...settings, ...patch }));
  const passwordAction = (remove: boolean) => {
    if (!remove && password !== confirmation) {
      setError("两次输入的密码不一致。");
      return;
    }
    const old = currentPassword,
      next = password;
    setCurrentPassword("");
    setPassword("");
    setConfirmation("");
    perform(() => service.changePassword(old, remove ? null : next));
  };
  return (
    <Stack gap="lg">
      {runtime === "browser" && (
        <Alert color="blue">
          {t(
            "浏览器预览仅演示隐私设置，关闭页面后密码不保留；全局快捷键和系统最近文件保护需要 Windows 桌面端。",
          )}
        </Alert>
      )}
      <SettingCard title={t("老板键")} icon="keyboard">
        <SettingRow
          title={t("应用内老板键")}
          hint={t("默认 F1；按下后隐藏窗口、暂停并静音内置播放器。Esc 保留关闭弹框的行为。")}
        >
          <Switch
            aria-label={t("启用应用内老板键")}
            checked={draft.localEnabled}
            disabled={snapshot.busy}
            onChange={(event) => setDraft({ ...draft, localEnabled: event.currentTarget.checked })}
          />
        </SettingRow>
        <SettingRow title={t("应用内快捷键")}>
          <ShortcutEditor
            label={t("应用内快捷键")}
            value={draft.localShortcut}
            disabled={snapshot.busy || !draft.localEnabled}
            onChange={(localShortcut) => setDraft({ ...draft, localShortcut })}
          />
        </SettingRow>
        <SettingRow
          title={t("全局老板键")}
          hint={t(
            windows ? "默认 F9；使用其他软件时仍可隐藏 JAVM。" : "全局老板键目前仅支持 Windows。",
          )}
        >
          <Switch
            aria-label={t("启用全局老板键")}
            checked={draft.globalEnabled && windows}
            disabled={!windows || snapshot.busy}
            onChange={(event) => setDraft({ ...draft, globalEnabled: event.currentTarget.checked })}
          />
        </SettingRow>
        <SettingRow title={t("全局快捷键")}>
          <ShortcutEditor
            label={t("全局快捷键")}
            value={draft.globalShortcut}
            disabled={!windows || snapshot.busy || !draft.globalEnabled}
            onChange={(globalShortcut) => setDraft({ ...draft, globalShortcut })}
          />
        </SettingRow>
        <SettingFields>
          <Group justify="flex-end">
            <Button
              variant="default"
              disabled={snapshot.busy}
              onClick={() =>
                setDraft({
                  ...draft,
                  localShortcut: defaultPrivacySettings.localShortcut,
                  globalShortcut: defaultPrivacySettings.globalShortcut,
                })
              }
            >
              {t("恢复默认快捷键")}
            </Button>
            <Button
              loading={snapshot.busy}
              onClick={() => perform(() => service.saveSettings(draft))}
            >
              {t("检测冲突并保存")}
            </Button>
          </Group>
          <SettingNote>
            {t(
              "最多两个按键。检测本应用保留快捷键及系统全局热键占用；其他软件自己的窗口内快捷键无法由系统统一查询。冲突时保留原设置。",
            )}
          </SettingNote>
          {snapshot.shortcutError && <Alert color="red">{t(snapshot.shortcutError)}</Alert>}
        </SettingFields>
      </SettingCard>
      <SettingCard title={t("密码与锁屏")} icon="lock">
        <SettingFields>
          {snapshot.hasPassword && (
            <PasswordInput
              label={t("当前密码")}
              autoComplete="current-password"
              value={currentPassword}
              maxLength={256}
              disabled={snapshot.busy}
              onChange={(event) => setCurrentPassword(event.currentTarget.value)}
            />
          )}
          <PasswordInput
            label={t(snapshot.hasPassword ? "新密码" : "设置密码")}
            description={t("6 至 256 个字符，支持粘贴。请妥善保存密码。")}
            autoComplete="new-password"
            value={password}
            maxLength={256}
            disabled={snapshot.busy}
            onChange={(event) => setPassword(event.currentTarget.value)}
          />
          <PasswordInput
            label={t("确认密码")}
            autoComplete="new-password"
            value={confirmation}
            maxLength={256}
            disabled={snapshot.busy}
            onChange={(event) => setConfirmation(event.currentTarget.value)}
          />
          <Group justify="flex-end">
            {snapshot.hasPassword && (
              <Button
                variant="default"
                disabled={snapshot.busy || !currentPassword}
                onClick={() => passwordAction(true)}
              >
                {t("移除密码")}
              </Button>
            )}
            <Button
              disabled={
                snapshot.busy ||
                !password ||
                !confirmation ||
                (snapshot.hasPassword && !currentPassword)
              }
              onClick={() => passwordAction(false)}
            >
              {t(snapshot.hasPassword ? "修改密码" : "设置密码")}
            </Button>
          </Group>
        </SettingFields>
        <SettingRow title={t("启动时需要密码")}>
          <Switch
            aria-label={t("启动时需要密码")}
            checked={settings.lockOnStartup}
            disabled={!snapshot.hasPassword || snapshot.busy}
            onChange={(event) => update({ lockOnStartup: event.currentTarget.checked })}
          />
        </SettingRow>
        <SettingRow title={t("老板键恢复时需要密码")}>
          <Switch
            aria-label={t("老板键恢复时需要密码")}
            checked={settings.lockOnBossKey}
            disabled={!snapshot.hasPassword || snapshot.busy}
            onChange={(event) => update({ lockOnBossKey: event.currentTarget.checked })}
          />
        </SettingRow>
        <SettingRow title={t("立即锁定")} hint={t("下载、扫描等后台任务继续运行。")}>
          <Button
            variant="default"
            disabled={!snapshot.hasPassword || snapshot.busy}
            onClick={() => perform(() => service.conceal(true))}
          >
            {t("锁定应用")}
          </Button>
        </SettingRow>
        <SettingFields>
          <SettingNote>
            {t(
              "请先设置密码，再分别选择启动锁和老板键恢复锁。此功能保护应用界面，不加密磁盘中的媒体文件和数据库。",
            )}
          </SettingNote>
        </SettingFields>
      </SettingCard>
      <SettingCard title={t("图片与最近文件")} icon="eyeSlash">
        <SettingRow
          title={t("封面模糊模式")}
          hint={t(
            "封面、截图和图片预览默认模糊，仅鼠标悬停的图片显示清晰内容；移出或切换窗口后立即恢复。",
          )}
        >
          <Switch
            aria-label={t("封面模糊模式")}
            checked={settings.blurImages}
            disabled={snapshot.busy}
            onChange={(event) => update({ blurImages: event.currentTarget.checked })}
          />
        </SettingRow>
        <SettingRow
          title={t("不写入系统最近文件")}
          hint={t("Windows 文件与目录选择不加入最近项目，外部播放避开 Shell 文件打开记录。")}
        >
          <Switch
            aria-label={t("不写入系统最近文件")}
            checked={settings.protectRecentFiles}
            disabled={!windows || snapshot.busy}
            onChange={(event) => update({ protectRecentFiles: event.currentTarget.checked })}
          />
        </SettingRow>
        <SettingFields>
          <SettingNote>
            {t(
              "老板键仅控制 JAVM 和内置播放器。外部播放器、资源管理器及浏览器可能自行记录历史；已有系统记录不会被清空。",
            )}
          </SettingNote>
        </SettingFields>
      </SettingCard>
      {error && (
        <Alert color="red" role="alert">
          {t(error)}
        </Alert>
      )}
      {message && (
        <Text role="status" size="sm" c="dimmed">
          {t(message)}
        </Text>
      )}
    </Stack>
  );
}
