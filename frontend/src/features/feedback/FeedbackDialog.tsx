import { t, useLocale } from "../../i18n/index";
import { useSyncExternalStore } from "react";
import { Modal } from "@mantine/core";
import type { FeedbackService } from "../../services/feedback/FeedbackService";
import { FeedbackDetails } from "./FeedbackDetails";
import { FeedbackDrawer } from "./FeedbackDrawer";

export function FeedbackDialog({ service }: { service: FeedbackService }) {
  useLocale();
  const state = useSyncExternalStore(service.subscribe, service.getSnapshot);
  const report = state.reports.find((item) => item.id === state.activeId);
  return (
    <>
      <Modal
        opened={state.enabled && !state.historyOpened && !!report}
        onClose={service.dismiss}
        title={t(report?.title ?? "问题反馈")}
        size="lg"
        centered
        closeOnClickOutside={false}
      >
        {report && !state.historyOpened && (
          <FeedbackDetails key={report.id} service={service} report={report} />
        )}
      </Modal>
      <FeedbackDrawer service={service} />
    </>
  );
}
