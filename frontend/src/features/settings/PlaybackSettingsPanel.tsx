import { useState, useSyncExternalStore } from "react";
import { Alert, Button, Group, Select, Stack, Text, TextInput } from "@mantine/core";
import { useWorkspace } from "../../app/state";
import { Icon } from "../../components/icons";
import type { PlaybackSettings } from "../../services/playback/PlaybackSettingsService";
import { playbackError } from "../../services/playback/PlaybackService";
import { SettingCard, SettingNote, SettingRow } from "./SettingsPrimitives";
import classes from "./Settings.module.css";

export function PlaybackSettingsPanel() {
  const { playbackSettings, notice } = useWorkspace();
  const current = useSyncExternalStore(playbackSettings.subscribe, playbackSettings.getSnapshot);
  const [edited, setEdited] = useState<PlaybackSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState("");
  const draft = edited ?? current.settings;
  const dirty =
    draft.defaultPlayer !== current.settings.defaultPlayer ||
    draft.windowMode !== current.settings.windowMode ||
    draft.externalPlayerPath !== current.settings.externalPlayerPath;
  const busy = saving || choosing || !current.ready;
  const update = (patch: Partial<PlaybackSettings>) => {
    setEdited({ ...draft, ...patch });
    setError("");
  };
  const choose = async () => {
    if (busy || !current.available) return;
    setChoosing(true);
    setError("");
    try {
      const path = await playbackSettings.choosePlayer();
      if (path) update({ externalPlayerPath: path });
    } catch (reason) {
      setError(playbackError(reason));
    } finally {
      setChoosing(false);
    }
  };
  const save = async () => {
    if (busy || !current.available || (!dirty && !current.error)) return;
    setSaving(true);
    setError("");
    try {
      await playbackSettings.update(draft);
      setEdited(null);
      notice("播放设置已保存，下次打开影片时生效");
    } catch (reason) {
      setError(playbackError(reason));
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Stack gap="lg">
        {!current.available && <SettingNote>请在桌面端选择播放器并保存设置。</SettingNote>}
        <SettingCard title="默认播放器" icon="play">
          <SettingRow title="打开影片时使用" hint="用于片库、影片详情和已完成的下载">
            <Select
              aria-label="默认播放器"
              value={draft.defaultPlayer}
              allowDeselect={false}
              disabled={busy}
              data={[
                { value: "internal", label: "内置播放器" },
                { value: "external", label: "外部播放器" },
              ]}
              onChange={(value) => {
                if (value === "internal" || value === "external") update({ defaultPlayer: value });
              }}
            />
          </SettingRow>
          <div className={classes.fields}>
            <div className={classes.pathField}>
              <TextInput
                label="外部播放器路径"
                description="留空使用系统默认应用；也可指定播放器程序，macOS 支持选择 APP。"
                placeholder="选择或输入播放器路径"
                value={draft.externalPlayerPath}
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => update({ externalPlayerPath: event.currentTarget.value })}
              />
              <Button
                type="button"
                variant="default"
                disabled={!current.available || busy}
                loading={choosing}
                onClick={() => void choose()}
                leftSection={<Icon name="folder" size={15} />}
              >
                选择
              </Button>
            </div>
          </div>
        </SettingCard>
        <SettingCard title="播放偏好" icon="clock">
          <SettingRow
            title="播放窗口模式"
            hint="选择不同视频的打开方式；同一视频始终激活已有窗口。仅对内置播放器生效。"
          >
            <Select
              aria-label="播放窗口模式"
              value={draft.windowMode}
              allowDeselect={false}
              disabled={busy || draft.defaultPlayer === "external"}
              data={[
                { value: "reuse", label: "复用现有窗口" },
                { value: "new", label: "在新窗口中播放" },
              ]}
              onChange={(value) => {
                if (value === "reuse" || value === "new") update({ windowMode: value });
              }}
            />
          </SettingRow>
          <Text size="xs" c="dimmed" py="sm">
            内置播放器自动记住每个视频的播放位置，下次继续播放；最后 5
            秒视为已看完。外部播放器自行管理进度。
          </Text>
        </SettingCard>
        {(error || current.error) && (
          <Alert color="red" title="播放设置未完成" icon={<Icon name="alert" />} role="alert">
            {error || current.error}
          </Alert>
        )}
        <div className={classes.saveBar}>
          <Text component="output" size="xs" c={dirty ? undefined : "dimmed"} aria-live="polite">
            {saving ? "正在保存…" : dirty ? "有未保存的修改" : "修改后点击保存"}
          </Text>
          <Group gap="xs">
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={!dirty || busy}
              onClick={() => {
                setEdited(null);
                setError("");
              }}
            >
              撤销修改
            </Button>
            <Button
              type="submit"
              size="sm"
              loading={saving}
              disabled={(!dirty && !current.error) || busy || !current.available}
            >
              保存播放设置
            </Button>
          </Group>
        </div>
      </Stack>
    </form>
  );
}
