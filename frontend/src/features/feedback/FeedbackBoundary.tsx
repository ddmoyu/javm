import { subscribeLocale, t } from "../../i18n/index";
import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { Alert, Button, Center, Group, Stack, Text } from "@mantine/core";
import type { FeedbackService } from "../../services/feedback/FeedbackService";
import type { FailureInput } from "../../services/feedback/events";
import { logEvent } from "../../services/logging/events";
import { finishStartup } from "../../app/startup";

export class FeedbackBoundary extends Component<
  { children: ReactNode; service?: FeedbackService },
  { failed: boolean }
> {
  state = { failed: false };
  private failure?: FailureInput;
  private reportId?: string;
  private unsubscribeLocale?: () => void;
  componentDidMount() {
    this.unsubscribeLocale = subscribeLocale(() => this.forceUpdate());
  }
  componentWillUnmount() {
    this.unsubscribeLocale?.();
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    finishStartup();
    this.failure = {
      module: "frontend",
      title: "界面发生异常",
      message: `${error.stack ?? error.message}\n${info.componentStack ?? ""}`,
    };
    logEvent(
      this.props.service ? "warn" : "error",
      "frontend",
      "render_failed",
      this.failure.message,
    );
    this.reportId = this.props.service?.capture(this.failure);
  }
  openFeedback = () => {
    const service = this.props.service;
    if (!service || !this.failure) return;
    if (service.getSnapshot().reports.some((item) => item.id === this.reportId))
      service.open(this.reportId!);
    else this.reportId = service.capture(this.failure, true);
  };
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <Center h="100vh" p="xl">
        <Stack maw={560}>
          <Alert title={t("界面发生异常")} color="red" role="alert">
            {t("界面无法继续显示，诊断信息已记录。")}
          </Alert>
          <Text size="sm">
            {t("可以复制反馈信息，或重新加载界面。重新加载会中断当前界面操作。")}
          </Text>
          <Group>
            {this.props.service && <Button onClick={this.openFeedback}>{t("反馈问题")}</Button>}
            <Button
              variant="default"
              onClick={() =>
                void (async () => {
                  await this.props.service?.prepareExit();
                  location.reload();
                })()
              }
            >
              {t("重新加载")}
            </Button>
          </Group>
        </Stack>
      </Center>
    );
  }
}
