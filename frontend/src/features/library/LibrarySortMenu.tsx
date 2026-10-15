import { t, useLocale } from "../../i18n/index";
import { useState } from "react";
import { Button, Menu } from "@mantine/core";
import type { LibrarySort, SortDirection } from "../../contracts/library";
import { Icon } from "../../components/icons";
import { librarySortOptions } from "./libraryQuery";

export function LibrarySortMenu({
  sort,
  direction,
  onSortChange,
  onDirectionChange,
}: {
  sort: LibrarySort;
  direction: SortDirection;
  onSortChange: (value: LibrarySort) => void;
  onDirectionChange: (value: SortDirection) => void;
}) {
  useLocale();
  const [opened, setOpened] = useState(false);
  const current = librarySortOptions.find((option) => option.value === sort);
  const description = t(
    "当前按{0}排序，{1}",
    t(current?.label),
    t(direction === "desc" ? "降序" : "升序"),
  );

  return (
    <Menu
      opened={opened}
      onChange={setOpened}
      position="bottom-end"
      width={180}
      returnFocus
      checkIcon={<Icon name="check" size={14} />}
    >
      <Menu.Target>
        <Button
          size="xs"
          h={32}
          variant={opened ? "light" : "subtle"}
          color={opened ? "rouge" : "gray"}
          aria-label={t("排序影片，{0}", t(description))}
          title={t(description)}
          leftSection={<Icon name={direction === "desc" ? "sortDesc" : "sortAsc"} size={16} />}
        >
          {t("排序")}
        </Button>
      </Menu.Target>
      <Menu.Dropdown aria-label={t("影片排序")}>
        <Menu.Label>{t("排序方式")}</Menu.Label>
        <Menu.RadioGroup
          value={sort}
          onChange={(value) => {
            const option = librarySortOptions.find((item) => item.value === value);
            if (option) {
              onSortChange(option.value);
              onDirectionChange(option.direction);
            }
          }}
        >
          {librarySortOptions.map((option) => (
            <Menu.RadioItem key={option.value} value={option.value} closeMenuOnClick>
              {t(option.label)}
            </Menu.RadioItem>
          ))}
        </Menu.RadioGroup>
        <Menu.Divider />
        <Menu.Label>{t("排列顺序")}</Menu.Label>
        <Menu.RadioGroup
          value={direction}
          onChange={(value) => {
            if (value === "asc" || value === "desc") onDirectionChange(value);
          }}
        >
          <Menu.RadioItem value="asc" closeMenuOnClick>
            {t("升序")}
          </Menu.RadioItem>
          <Menu.RadioItem value="desc" closeMenuOnClick>
            {t("降序")}
          </Menu.RadioItem>
        </Menu.RadioGroup>
      </Menu.Dropdown>
    </Menu>
  );
}
