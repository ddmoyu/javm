import { useState, useSyncExternalStore } from "react";
import { Alert, Button, Code, Group, Stack, Switch, Text, TextInput } from "@mantine/core";
import { useWorkspace } from "../../app/state";
import { Icon } from "../../components/icons";
import type { NetworkSettings } from "../../contracts/network";
import { describeError } from "../../services/downloads/DownloadService";
import { SettingCard, SettingNote, SettingRow } from "./SettingsPrimitives";
import classes from "./Settings.module.css";
import { openExternalLink } from "../../platform/neutralino/externalLinks";

const recommendedProxyUrl = "https://mojie.app/register?aff=6U9kDSoZ";
const proxyInvitationCode = "6U9kDSoZ";

export function NetworkSettingsPanel() {
  const { network, notice, runtime } = useWorkspace();
  const current = useSyncExternalStore(network.subscribe, network.getSnapshot);
  const [edited, setEdited] = useState<NetworkSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const draft = edited ?? current.settings;
  const busy = saving || current.testing;
  const testResult = current.testResult?.proxy === draft.proxy.trim() ? current.testResult : null;
  const dirty =
    draft.proxy !== current.settings.proxy || draft.proxyEnabled !== current.settings.proxyEnabled;
  const update = (patch: Partial<NetworkSettings>) => {
    setEdited({ ...draft, ...patch });
    setError("");
    network.clearTestResult();
  };
  const test = async () => {
    if (busy || !current.available || !current.ready) return;
    setError("");
    try {
      await network.testProxy(draft.proxy);
    } catch (error) {
      setError(describeError(error));
    }
  };
  const save = async () => {
    if (busy || !current.available || !current.ready || (!dirty && !current.error)) return;
    setSaving(true);
    setError("");
    try {
      await network.update(draft);
      setEdited(null);
      notice("网络设置已保存");
    } catch (error) {
      setError(describeError(error));
    } finally {
      setSaving(false);
    }
  };
  const copyInvitationCode = async () => {
    try {
      await navigator.clipboard.writeText(proxyInvitationCode);
      notice("邀请码已复制");
    } catch {
      notice("复制失败，请手动复制邀请码。");
    }
  };
  return (
    <form
      aria-label="网络设置"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Stack gap="lg">
        {!current.available && (
          <SettingNote>浏览器中可预览和编辑表单；测试代理和保存网络设置请使用桌面端。</SettingNote>
        )}
        {!current.ready && <SettingNote>正在读取网络设置，请稍候。</SettingNote>}
        <SettingCard title="网络代理" icon="globe">
          <SettingRow title="启用代理" hint="统一管理代理地址，连接失败时自动使用">
            <Switch
              aria-label="启用代理"
              checked={draft.proxyEnabled}
              disabled={busy || !current.ready}
              onChange={(event) => update({ proxyEnabled: event.currentTarget.checked })}
            />
          </SettingRow>
          <div className={classes.fields}>
            <TextInput
              label="代理地址"
              description="支持 HTTP、HTTPS 和 SOCKS5。"
              placeholder="http://127.0.0.1:7890"
              value={draft.proxy}
              autoComplete="off"
              spellCheck={false}
              disabled={!draft.proxyEnabled || busy || !current.ready}
              onChange={(event) => update({ proxy: event.currentTarget.value })}
            />
            <Group gap="xs" mt="md">
              <Button
                type="button"
                variant="light"
                leftSection={<Icon name="globe" size={16} />}
                loading={current.testing}
                disabled={
                  !draft.proxyEnabled ||
                  !draft.proxy.trim() ||
                  busy ||
                  !current.available ||
                  !current.ready
                }
                onClick={() => void test()}
              >
                测试代理
              </Button>
              {current.testing && (
                <Button type="button" variant="subtle" onClick={network.cancelTest}>
                  取消测试
                </Button>
              )}
              <Text component="output" size="xs" c="dimmed" aria-live="polite">
                {current.testing
                  ? "正在测试 HTTPS 连通性…"
                  : "使用当前地址测试 HTTPS 连通性，无需先保存。"}
              </Text>
            </Group>
            {testResult && (
              <Alert
                mt="md"
                color={
                  testResult.status === "success"
                    ? "green"
                    : testResult.status === "failed"
                      ? "red"
                      : "gray"
                }
                title={
                  testResult.status === "success"
                    ? "代理可用"
                    : testResult.status === "failed"
                      ? "代理测试失败"
                      : "测试已取消"
                }
                role={testResult.status === "failed" ? "alert" : "status"}
              >
                {testResult.message}
              </Alert>
            )}
          </div>
        </SettingCard>
        <SettingCard title="推荐科学上网" icon="globe">
          <div className={classes.proxyRecommendation}>
            <Stack gap={8} className={classes.proxyProvider}>
              <Group gap="xs">
                <Text component="h4" size="sm" fw={600} m={0}>
                  魔戒
                </Text>
                <Text size="xs" c="dimmed">
                  mojie.app
                </Text>
              </Group>
              <Group gap={6}>
                <Text size="xs" c="dimmed">
                  邀请码
                </Text>
                <Code>{proxyInvitationCode}</Code>
                <Button
                  type="button"
                  variant="subtle"
                  size="compact-xs"
                  leftSection={<Icon name="copy" size={13} />}
                  aria-label="复制魔戒邀请码"
                  onClick={() => void copyInvitationCode()}
                >
                  复制
                </Button>
              </Group>
            </Stack>
            <Button
              component="a"
              href={recommendedProxyUrl}
              target="_blank"
              rel="noopener noreferrer"
              variant="default"
              size="xs"
              rightSection={<Icon name="external" size={14} />}
              aria-label="访问魔戒官网（在浏览器中打开）"
              onClick={(event) => {
                if (runtime !== "desktop") return;
                event.preventDefault();
                void openExternalLink(recommendedProxyUrl).catch(() =>
                  notice("打开链接失败，请检查默认浏览器后重试。"),
                );
              }}
            >
              访问官网
            </Button>
          </div>
        </SettingCard>
        {(error || current.error) && (
          <Alert color="red" title="网络设置未完成" icon={<Icon name="alert" />} role="alert">
            {error || current.error}
          </Alert>
        )}
        <div className={classes.saveBar}>
          <Text component="output" size="xs" c={dirty ? undefined : "dimmed"}>
            {saving ? "正在保存…" : dirty ? "有未保存的修改" : "修改后点击保存"}
          </Text>
          <Group gap="xs">
            <Button
              variant="default"
              size="sm"
              disabled={!dirty || busy}
              onClick={() => {
                setEdited(null);
                setError("");
                network.clearTestResult();
              }}
            >
              撤销修改
            </Button>
            <Button
              type="submit"
              size="sm"
              loading={saving}
              disabled={(!dirty && !current.error) || busy || !current.available || !current.ready}
            >
              保存网络设置
            </Button>
          </Group>
        </div>
      </Stack>
    </form>
  );
}
