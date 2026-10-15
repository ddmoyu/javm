import { useState } from "react";
import { Button, Popover, Stack, Text } from "@mantine/core";
import type { FilmLayout } from "../../contracts/library";
import { Icon } from "../../components/icons";
import type { IconName } from "../../components/icons";
import { LibraryLayoutControl } from "./LibraryLayoutControl";

const layouts: Record<FilmLayout, { label: string; icon: IconName }> = {
  poster: { label: "海报", icon: "viewPoster" },
  landscape: { label: "封面", icon: "viewLandscape" },
  list: { label: "列表", icon: "list" },
};

export function LibraryViewMenu({
  layout,
  onLayoutChange,
}: {
  layout: FilmLayout;
  onLayoutChange: (value: FilmLayout) => void;
}) {
  const [opened, setOpened] = useState(false);
  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      position="bottom-end"
      width={280}
      shadow="xl"
      radius="lg"
      trapFocus
      returnFocus
    >
      <Popover.Target>
        <Button
          size="xs"
          h={32}
          px={9}
          variant={opened ? "light" : "subtle"}
          color={opened ? "rouge" : "gray"}
          aria-label="显示方式"
          title={`显示方式 · 当前${layouts[layout].label}视图`}
          aria-expanded={opened}
          rightSection={<Icon name="down" size={12} />}
          onClick={() => setOpened(!opened)}
        >
          <Icon name={layouts[layout].icon} size={18} />
        </Button>
      </Popover.Target>
      <Popover.Dropdown p="md">
        <Stack gap={8}>
          <Text size="xs" fw={600}>
            显示方式
          </Text>
          <LibraryLayoutControl value={layout} onChange={onLayoutChange} />
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
