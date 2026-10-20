import { useEffect, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import {
  Alert,
  Button,
  Center,
  FocusTrap,
  Group,
  Loader,
  Paper,
  PasswordInput,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { BrandMark, Icon } from "../../components/icons";
import { t, useLocale } from "../../i18n";
import type { PrivacyService } from "../../services/privacy/PrivacyService";
import type { Runtime } from "../../platform/neutralino/bootstrap";
import { exitApplication } from "../../platform/neutralino/lifecycle";
import "./privacy.css";

export function PrivacyBoundary({
  service,
  runtime,
  children,
}: {
  service: PrivacyService;
  runtime: Runtime;
  children: ReactNode;
}) {
  useLocale();
  const snapshot = useSyncExternalStore(service.subscribe, service.getSnapshot);
  const protectedContent = !snapshot.ready || snapshot.locked || snapshot.hidden;
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [dismissed, setDismissed] = useState("");
  useEffect(() => {
    setPassword("");
    setError("");
  }, [snapshot.hidden, snapshot.locked]);
  const warning = snapshot.shortcutError || (snapshot.ready ? snapshot.error : "");
  const report = (operation: Promise<unknown>) => {
    void operation.catch((reason: unknown) =>
      setError(reason instanceof Error ? reason.message : "操作失败，请重试。"),
    );
  };
  return (
    <>
      <div
        className="privacy-content"
        inert={protectedContent}
        aria-hidden={protectedContent || undefined}
      >
        {children}
        {warning && dismissed !== warning && (
          <Alert
            className="privacy-service-alert"
            title={t("请检查隐私设置")}
            color="orange"
            role="alert"
            withCloseButton
            closeButtonLabel={t("关闭提示")}
            onClose={() => setDismissed(warning)}
          >
            {t(warning)}
          </Alert>
        )}
      </div>
      {protectedContent && (
        <Center className="privacy-lock-screen" data-privacy-lock>
          <FocusTrap active>
            <Paper
              className="privacy-lock-card"
              withBorder
              radius="lg"
              p="xl"
              component="form"
              onSubmit={(event) => {
                event.preventDefault();
                setError("");
                const value = password;
                setPassword("");
                report(service.unlock(value));
              }}
            >
              <Stack gap="lg">
                <Group justify="center">
                  <BrandMark size={32} />
                  <Text fw={700}>JAVM</Text>
                </Group>
                <Stack gap={5} align="center">
                  <Icon name="lock" size={30} />
                  <Title order={2} size="h3">
                    {t(snapshot.locked ? "应用已锁定" : "内容已隐藏")}
                  </Title>
                  <Text size="sm" c="dimmed" ta="center">
                    {t("恢复后，播放器保持暂停和静音。")}
                  </Text>
                </Stack>
                {!snapshot.ready ? (
                  snapshot.error ? (
                    <>
                      <Alert color="red">{t(snapshot.error)}</Alert>
                      <Button onClick={() => report(service.initialize())}>{t("重试")}</Button>
                    </>
                  ) : (
                    <Loader size="sm" mx="auto" />
                  )
                ) : (
                  <>
                    {snapshot.locked && (
                      <PasswordInput
                        label={t("解锁密码")}
                        value={password}
                        onChange={(event) => setPassword(event.currentTarget.value)}
                        autoComplete="current-password"
                        data-autofocus
                        maxLength={256}
                      />
                    )}
                    <Button type="submit" loading={snapshot.busy}>
                      {t(snapshot.locked ? "解锁" : "恢复界面")}
                    </Button>
                  </>
                )}
                {error && (
                  <Alert color="red" role="alert">
                    {t(error)}
                  </Alert>
                )}
                {runtime === "desktop" && (
                  <Group justify="center">
                    <Button variant="subtle" size="xs" onClick={() => report(service.conceal())}>
                      {t("隐藏窗口")}
                    </Button>
                    <Button variant="subtle" size="xs" onClick={() => report(exitApplication())}>
                      {t("退出 JAVM")}
                    </Button>
                  </Group>
                )}
              </Stack>
            </Paper>
          </FocusTrap>
        </Center>
      )}
    </>
  );
}
