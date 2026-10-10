import { useState, useSyncExternalStore } from "react";
import { Alert, Button, Group, Modal, Stack, Text } from "@mantine/core";
import { os } from "@neutralinojs/lib";
import type { LibraryDocumentsService } from "../../services/library/LibraryDocumentsService";
export function LibraryDocumentsPanel({
  service,
  workId,
}: {
  service: LibraryDocumentsService;
  workId?: string;
}) {
  const state = useSyncExternalStore(service.subscribe, service.getSnapshot);
  const [opened, setOpened] = useState(false),
    [choosing, setChoosing] = useState(false),
    [error, setError] = useState("");
  const start = async (kind: "export" | "import") => {
    setChoosing(true);
    setError("");
    try {
      if (kind === "export") {
        const root = await os.showFolderDialog("导出 NFO 的位置");
        if (root) {
          setOpened(true);
          await service.exportNfo(root, workId);
        }
      } else {
        const paths = await os.showOpenDialog("导入 STRM 网络资源", {
          multiSelections: true,
          filters: [{ name: "STRM", extensions: ["strm"] }],
        });
        if (paths.length) {
          setOpened(true);
          await service.importStreams(paths);
        }
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "资料文件操作失败。");
      setOpened(true);
    } finally {
      setChoosing(false);
    }
  };
  return (
    <>
      <Group gap="xs">
        <Button
          size="xs"
          variant="default"
          disabled={state.running || choosing}
          onClick={() => void start("export")}
        >
          {workId ? "导出 NFO" : "批量导出 NFO"}
        </Button>
        {!workId && (
          <Button
            size="xs"
            variant="default"
            disabled={state.running || choosing}
            onClick={() => void start("import")}
          >
            导入 STRM
          </Button>
        )}
        {(state.running || state.processed > 0) && (
          <Button size="xs" variant="subtle" onClick={() => setOpened(true)}>
            资料任务 {state.processed}
          </Button>
        )}
      </Group>
      <Modal
        opened={opened}
        onClose={() => setOpened(false)}
        title={state.mode || "资料文件"}
        centered
      >
        <Stack>
          <Text size="sm" role="status">
            {state.running ? "正在处理" : state.cancelled ? "已停止" : "已结束"} · 成功{" "}
            {state.succeeded} · 失败 {state.failed}
          </Text>
          {state.directory && (
            <Text size="xs" style={{ overflowWrap: "anywhere" }}>
              保存位置：{state.directory}
            </Text>
          )}
          <Text size="xs" c="dimmed">
            导出保存在独立的新目录，停止后保留已导出的文件。导入 STRM
            只读取网络地址，不访问或下载视频。
          </Text>
          {(error || state.error) && (
            <Alert color="red" role="alert">
              {error || state.error}
            </Alert>
          )}
          {!!state.failures.length && (
            <Alert color="yellow">
              {state.failures.map((failure, i) => (
                <Text size="xs" key={i} style={{ overflowWrap: "anywhere" }}>
                  {failure}
                </Text>
              ))}
            </Alert>
          )}
          {state.running && (
            <Button variant="default" onClick={service.cancel} disabled={state.cancelled}>
              停止任务
            </Button>
          )}
        </Stack>
      </Modal>
    </>
  );
}
