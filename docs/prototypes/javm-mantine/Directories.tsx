import { useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Collapse,
  Group,
  Menu,
  Modal,
  Paper,
  Progress,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Title,
} from "@mantine/core";
import { usePrototype } from "./state";
import { Icon } from "./icons";
import { Pill } from "./ui";
import { ObjectMenu, ObjectMenuButton } from "./ObjectMenu";

export function Directories() {
  const { add, notice, films } = usePrototype();
  const [health, setHealth] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const directories = [
    {
      name: "主片库",
      path: "D:\\Media\\Library",
      count: Math.ceil((films.length * 2) / 3),
      used: 36,
      space: "40.9 TB 可用 / 64 TB",
    },
    {
      name: "精选收藏",
      path: "E:\\Collections",
      count: Math.floor(films.length / 3),
      used: 61,
      space: "12.5 TB 可用 / 32 TB",
    },
  ];
  return (
    <>
      <Group justify="flex-end" gap="sm" mb="md">
        <Button
          variant="default"
          size="xs"
          leftSection={<Icon name="scan" size={15} />}
          onClick={() => setHealth(true)}
        >
          检查片库
        </Button>
        <Button
          variant="default"
          size="xs"
          leftSection={<Icon name="refresh" size={15} />}
          onClick={() => notice("扫描完成，未发现新增文件")}
        >
          扫描变化
        </Button>
        <Button
          size="xs"
          leftSection={<Icon name="plus" size={15} />}
          onClick={() => add("import")}
        >
          添加目录
        </Button>
      </Group>
      <Group justify="space-between" mb="sm">
        <Title order={3} fz={16}>
          媒体目录
        </Title>
        <Button
          variant="subtle"
          size="compact-sm"
          rightSection={<Icon name="down" size={14} />}
          aria-expanded={advanced}
          onClick={() => setAdvanced(!advanced)}
        >
          扫描规则
        </Button>
      </Group>
      <Collapse expanded={advanced}>
        <Paper withBorder radius="lg" p="md" mb="sm">
          <Group align="flex-end" gap="lg">
            <Checkbox label="包含子目录" defaultChecked />
            <Checkbox label="跳过已入库文件" defaultChecked />
            <TextInput label="视频扩展名" defaultValue="mp4, mkv, avi, ts" w={260} />
            <Button variant="light" size="sm" onClick={() => notice("扫描规则已保存")}>
              保存规则
            </Button>
          </Group>
        </Paper>
      </Collapse>
      <Stack gap="sm">
        {directories.map((directory) => (
          <ObjectMenu
            key={directory.path}
            items={
              <>
                <Menu.Label>{directory.name}</Menu.Label>
                <Menu.Item
                  leftSection={<Icon name="refresh" />}
                  onClick={() => notice(`${directory.name}：扫描完成`)}
                >
                  扫描变化
                </Menu.Item>
                <Menu.Item leftSection={<Icon name="settings" />} onClick={() => setAdvanced(true)}>
                  扫描规则
                </Menu.Item>
                <Menu.Item
                  leftSection={<Icon name="folder" />}
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(directory.path);
                      notice("目录路径已复制");
                    } catch {
                      notice("复制失败，请重试");
                    }
                  }}
                >
                  复制目录路径
                </Menu.Item>
              </>
            }
          >
            <Paper withBorder radius="lg" p="lg" component="section">
              <Group wrap="nowrap" gap="lg">
                <ThemeIcon size={56} radius="md" variant="light">
                  <Icon name="folder" size={28} />
                </ThemeIcon>
                <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
                  <Group gap="xs">
                    <Text fw={700}>{directory.name}</Text>
                    <Pill tone="success">可访问</Pill>
                  </Group>
                  <Text size="sm" c="dimmed" ff="monospace">
                    {directory.path}
                  </Text>
                  <Group gap="md">
                    <Text size="xs" c="dimmed">
                      {directory.count} 部影片
                    </Text>
                    <Text size="xs" c="dimmed">
                      包含子目录
                    </Text>
                    <Text size="xs" c="dimmed">
                      增量扫描
                    </Text>
                  </Group>
                </Stack>
                <Stack gap={6} w={150}>
                  <Text size="xs" c="dimmed">
                    {directory.space}
                  </Text>
                  <Progress value={directory.used} size={4} color="rouge.7" />
                </Stack>
                <Button variant="default" onClick={() => notice(`${directory.name}：扫描完成`)}>
                  扫描
                </Button>
                <ObjectMenuButton label={`${directory.name} 目录选项`} />
              </Group>
            </Paper>
          </ObjectMenu>
        ))}
      </Stack>
      <Modal opened={health} onClose={() => setHealth(false)} title="片库检查" centered>
        <Group gap="xs">
          <Pill tone="success">文件路径正常</Pill>
          <Pill tone="warning">{films.filter((film) => film.missing).length} 部资料待补全</Pill>
          <Pill>1 组可能重复</Pill>
        </Group>
        <Text size="sm" c="dimmed" mt="md">
          重复项会按番号、文件大小与所在位置对照，确认保留项后才执行整理。
        </Text>
        <Alert variant="light" color="champagne" mt="md" icon={<Icon name="info" size={16} />}>
          检查只生成建议，不自动删除文件。
        </Alert>
        <Group justify="flex-end" mt="lg">
          <Button
            onClick={() => {
              setHealth(false);
              notice("检查结果已保留");
            }}
          >
            了解了
          </Button>
        </Group>
      </Modal>
    </>
  );
}
