import { useState, useSyncExternalStore } from "react";
import { Alert, Button, Group, NumberInput, Stack, Text, TextInput } from "@mantine/core";
import { os } from "@neutralinojs/lib";
import { useWorkspace } from "../../app/state";
import { Icon } from "../../components/icons";
import { describeError } from "../../services/downloads/DownloadService";
import type { DownloadSettings } from "../../contracts/downloads";
import { SettingCard, SettingNote, SettingRow } from "../settings/SettingsPrimitives";
import classes from "../settings/Settings.module.css";

export function DownloadSettingsPanel() {
  const { downloads, notice } = useWorkspace();
  const current = useSyncExternalStore(downloads.subscribe, downloads.getControls);
  const [edited, setEdited] = useState<DownloadSettings | null>(null);
  const draft = edited ?? current.settings;
  const [action, setAction] = useState<"pick" | "check" | "save" | null>(null);
  const busy = action !== null;
  const [error, setError] = useState("");
  const [toolsChecked, setToolsChecked] = useState(false);
  const dirty =
    edited !== null &&
    (Object.keys(edited) as (keyof DownloadSettings)[]).some(
      (field) => edited[field] !== current.settings[field],
    );
  const update = (field: "directory" | "concurrency", value: string | number) => {
    setEdited((previous) => ({ ...(previous ?? current.settings), [field]: value }));
    setError("");
    setToolsChecked(false);
  };
  const perform = async (kind: NonNullable<typeof action>, operation: () => Promise<void>) => {
    if (busy) return;
    setAction(kind);
    setError("");
    try {
      await operation();
    } catch (error) {
      setError(describeError(error));
    } finally {
      setAction(null);
    }
  };
  const pickDirectory = async () => {
    const result = await os.showFolderDialog("选择默认下载目录", {
      defaultPath: draft.directory,
    });
    if (result) update("directory", result);
  };
  const save = () => {
    if (!dirty || !current.available || !current.ready || current.error) return;
    void perform("save", async () => {
      await downloads.updateSettings(draft);
      setEdited(null);
      notice("下载设置已保存");
    });
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
      aria-label="下载设置"
    >
      <Stack gap="lg">
        {!current.available && (
          <SettingNote>
            浏览器中可预览和编辑表单；选择本地目录、检查工具与保存设置请使用桌面端。
          </SettingNote>
        )}
        {current.available && !current.ready && !current.error && (
          <SettingNote>正在读取下载设置，请稍候。</SettingNote>
        )}
        {current.error && (
          <Alert color="red" title="下载服务不可用" icon={<Icon name="alert" />}>
            {current.error}
          </Alert>
        )}
        <SettingCard title="保存位置" icon="folder">
          <div className={classes.fields}>
            <div className={classes.pathField}>
              <TextInput
                label="默认下载目录"
                placeholder="选择或输入保存目录"
                value={draft.directory}
                onChange={(event) => update("directory", event.currentTarget.value)}
                disabled={busy}
              />
              <Button
                variant="default"
                aria-label="选择默认下载目录"
                leftSection={<Icon name="folder" size={16} />}
                disabled={!current.available || busy}
                onClick={() => void perform("pick", pickDirectory)}
              >
                选择目录
              </Button>
            </div>
            <Text size="xs" c="dimmed" mt={8}>
              新建任务默认使用此目录，也可为单个任务另选保存位置。
            </Text>
          </div>
        </SettingCard>
        <SettingCard title="下载任务" icon="download">
          <SettingRow
            title="同时下载数"
            hint="支持 1–5 个任务并行；调低后，正在运行的任务会继续完成。"
          >
            <NumberInput
              aria-label="同时下载数"
              min={1}
              max={5}
              allowDecimal={false}
              allowNegative={false}
              value={draft.concurrency || ""}
              onChange={(value) => update("concurrency", Number(value))}
              disabled={busy}
              w={100}
            />
          </SettingRow>
        </SettingCard>
        <SettingCard title="下载工具" icon="settings">
          <SettingRow title="内置下载组件" hint="随软件提供，无需配置程序路径。">
            <Button
              variant="default"
              size="xs"
              loading={action === "check"}
              disabled={!current.available || busy}
              onClick={() =>
                void perform("check", async () => {
                  setToolsChecked(false);
                  await downloads.checkTools(draft);
                  setToolsChecked(true);
                })
              }
            >
              检查工具
            </Button>
          </SettingRow>
          {toolsChecked && (
            <Text component="output" size="xs" c="teal" py="md" display="block">
              下载工具检查通过
            </Text>
          )}
        </SettingCard>
        {error && (
          <Alert color="red" title="操作未完成" icon={<Icon name="alert" />} role="alert">
            {error}
          </Alert>
        )}
        <div className={classes.saveBar}>
          <Text component="output" size="xs" c={dirty ? undefined : "dimmed"}>
            {busy
              ? action === "check"
                ? "正在检查工具…"
                : action === "save"
                  ? "正在保存…"
                  : "正在选择路径…"
              : dirty
                ? "有未保存的修改"
                : "修改后点击保存"}
          </Text>
          <Group gap="xs">
            <Button
              variant="default"
              size="sm"
              disabled={!dirty || busy}
              onClick={() => {
                setEdited(null);
                setError("");
                setToolsChecked(false);
              }}
            >
              撤销修改
            </Button>
            <Button
              type="submit"
              size="sm"
              loading={action === "save"}
              disabled={!dirty || busy || !current.available || !current.ready || !!current.error}
            >
              保存下载设置
            </Button>
          </Group>
        </div>
      </Stack>
    </form>
  );
}
