import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Group,
  Modal,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import type { LibraryService } from "../../services/library/LibraryService";
type Alias = { alias: string; canonical: string; blocked: number; label: string };
export function EntityAliasesModal({
  library,
  onClose,
}: {
  library: LibraryService;
  onClose(): void;
}) {
  const [dimension, setDimension] = useState("actors"),
    [query, setQuery] = useState(""),
    [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<Alias[]>([]),
    [alias, setAlias] = useState(""),
    [canonical, setCanonical] = useState(""),
    [label, setLabel] = useState("");
  const [blocked, setBlocked] = useState(false),
    [busy, setBusy] = useState(false),
    [restoring, setRestoring] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let alive = true;
    setError("");
    void library
      .manageAliases<Alias[]>("list", { dimension, query, offset })
      .then((items) => {
        if (alive) setRows(items);
      })
      .catch((reason: unknown) => {
        if (alive) setError(reason instanceof Error ? reason.message : "读取失败");
      });
    return () => {
      alive = false;
    };
  }, [library, dimension, query, offset, reload]);
  const run = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await operation();
      setReload((n) => n + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "名称管理失败");
    } finally {
      setBusy(false);
      setRestoring(false);
    }
  };
  return (
    <Modal
      opened
      onClose={() => !busy && onClose()}
      title="名称与别名管理"
      size="lg"
      centered
      closeOnEscape={!busy}
      closeOnClickOutside={!busy}
    >
      <Stack>
        <Text size="sm">
          将同一实体的不同语言名称归并到规范名称。屏蔽规则会让该名称独立显示；移除规则后恢复原始关联。原始资料与
          NFO 保留。
        </Text>
        <Select
          label="类型"
          value={dimension}
          disabled={busy}
          allowDeselect={false}
          data={[
            { value: "actors", label: "演员" },
            { value: "studios", label: "制作商" },
            { value: "labels", label: "发行商" },
            { value: "directors", label: "导演" },
            { value: "series", label: "系列" },
            { value: "genres", label: "分类" },
          ]}
          onChange={(value) => {
            setDimension(value!);
            setOffset(0);
          }}
        />
        <TextInput
          label="原名称／别名"
          value={alias}
          disabled={busy}
          onChange={(event) => setAlias(event.currentTarget.value)}
        />
        <TextInput
          label="规范名称"
          value={canonical}
          disabled={busy || blocked}
          onChange={(event) => setCanonical(event.currentTarget.value)}
        />
        <TextInput
          label="中文显示名称（可选）"
          value={label}
          disabled={busy || blocked}
          onChange={(event) => setLabel(event.currentTarget.value)}
        />
        <Checkbox
          label="屏蔽这个名称的归并"
          checked={blocked}
          disabled={busy}
          onChange={(event) => setBlocked(event.currentTarget.checked)}
        />
        <Button
          disabled={busy || !alias.trim() || (!blocked && !canonical.trim())}
          onClick={() =>
            void run(async () => {
              await library.manageAliases("save", {
                dimension,
                alias,
                canonical: blocked ? alias : canonical,
                label,
                blocked,
              });
              setMessage("名称规则已保存。");
            })
          }
        >
          保存规则
        </Button>
        <TextInput
          label="搜索已有规则"
          value={query}
          disabled={busy}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setOffset(0);
          }}
        />
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>原名称</Table.Th>
              <Table.Th>规范名称</Table.Th>
              <Table.Th>操作</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((row) => (
              <Table.Tr key={row.alias}>
                <Table.Td>{row.alias}</Table.Td>
                <Table.Td>
                  {row.blocked
                    ? "已屏蔽"
                    : row.label
                      ? `${row.canonical} · ${row.label}`
                      : row.canonical}
                </Table.Td>
                <Table.Td>
                  <Group gap="xs">
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      disabled={busy}
                      onClick={() => {
                        setAlias(row.alias);
                        setCanonical(row.canonical);
                        setLabel(row.label);
                        setBlocked(!!row.blocked);
                      }}
                    >
                      编辑
                    </Button>
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      color="red"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await library.manageAliases("remove", { dimension, alias: row.alias });
                        })
                      }
                    >
                      移除规则
                    </Button>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        <Group justify="space-between">
          <Button
            size="xs"
            variant="default"
            disabled={!offset || busy}
            onClick={() => setOffset((n) => Math.max(0, n - 50))}
          >
            上一页
          </Button>
          <Button
            size="xs"
            variant="default"
            disabled={rows.length < 50 || busy}
            onClick={() => setOffset((n) => n + 50)}
          >
            下一页
          </Button>
        </Group>
        <Text size="xs" c="dimmed">
          旧归档恢复只补充当前没有的规则与收藏，冲突或缺少规范名称的分组保留在归档中供核对。
        </Text>
        <Button
          variant="light"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              setRestoring(true);
              const result = await library.manageAliases<{
                favorites: number;
                aliases: number;
                skipped: number;
              }>("restore");
              setMessage(
                `恢复收藏 ${result.favorites} 项、别名 ${result.aliases} 项，跳过待核对记录 ${result.skipped} 项。`,
              );
            })
          }
        >
          恢复旧收藏／别名
        </Button>
        {restoring && (
          <Button
            variant="default"
            onClick={() => void library.cancelAliasRestore().catch(() => {})}
          >
            取消恢复
          </Button>
        )}
        {message && (
          <Alert color="blue" role="status">
            {message}
          </Alert>
        )}
        {error && (
          <Alert color="red" role="alert">
            {error}
          </Alert>
        )}
      </Stack>
    </Modal>
  );
}
