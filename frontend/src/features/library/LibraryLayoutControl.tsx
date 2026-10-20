import { t, localizeOptions, useLocale } from "../../i18n/index";
import { SegmentedControl } from "@mantine/core";
import type { FilmLayout } from "../../contracts/library";
import { Icon } from "../../components/icons";
import type { IconName } from "../../components/icons";
import classes from "./LibraryLayoutControl.module.css";

const layouts: { value: FilmLayout; label: string; icon: IconName }[] = [
  { value: "poster", label: "海报", icon: "viewPoster" },
  { value: "landscape", label: "封面", icon: "viewLandscape" },
  { value: "list", label: "列表", icon: "list" },
];

export function LibraryLayoutControl({
  value,
  onChange,
}: {
  value: FilmLayout;
  onChange: (value: FilmLayout) => void;
}) {
  useLocale();
  return (
    <SegmentedControl<FilmLayout>
      aria-label={t("媒体库显示方式")}
      value={value}
      onChange={onChange}
      size="xs"
      fullWidth
      radius="md"
      withItemsBorders={false}
      transitionDuration={140}
      classNames={classes}
      data={localizeOptions(
        layouts.map((layout) => ({
          value: layout.value,
          label: (
            <span className={classes.option}>
              <Icon name={layout.icon} size={17} filled={value === layout.value} />
              <span>{t(layout.label)}</span>
            </span>
          ),
        })),
      )}
    />
  );
}
