import { getLocale, t, useLocale } from "../i18n/index";
import type { ReactNode } from "react";
import { ActionIcon, Badge, EmptyState, Tabs, Text, Tooltip } from "@mantine/core";
import { Icon } from "./icons";
import type { IconName } from "./icons";

export function IconButton({
  icon,
  label,
  onClick,
  active,
  disabled = false,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  useLocale();
  return (
    <Tooltip label={t(label)}>
      <ActionIcon
        aria-label={t(label)}
        aria-pressed={active}
        onClick={onClick}
        variant={active ? "light" : "subtle"}
        color={active ? "rouge" : "gray"}
        size={34}
        disabled={disabled}
      >
        <Icon name={icon} />
      </ActionIcon>
    </Tooltip>
  );
}

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger";
const toneColor: Record<Tone, string> = {
  neutral: "gray",
  accent: "rouge",
  success: "teal",
  warning: "champagne",
  danger: "red",
};

/** 状态标签统一走 Mantine Badge，只按语义换色。 */
export function Pill({ children, tone = "neutral" }: { children: ReactNode; tone?: Tone }) {
  useLocale();
  return (
    <Badge
      variant="light"
      color={toneColor[tone]}
      radius="sm"
      size="sm"
      tt="none"
      fw={500}
      style={{ flex: "none" }}
    >
      {children}
    </Badge>
  );
}

export function Empty({
  title,
  description,
  icon = "search",
  children,
}: {
  title: string;
  description: string;
  icon?: IconName;
  children?: ReactNode;
}) {
  useLocale();
  return (
    <EmptyState
      py={56}
      icon={<Icon name={icon} size={28} />}
      withIndicatorBackground
      title={t(title)}
      description={t(description)}
    >
      {children && <EmptyState.Actions>{children}</EmptyState.Actions>}
    </EmptyState>
  );
}

/** 第一版的“文字页签”：下划线页签，标签后跟数量。 */
export function CountTabs<T extends string>({
  value,
  onChange,
  items,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  items: readonly (readonly [T, string, number])[];
  label: string;
}) {
  useLocale();
  return (
    <Tabs
      value={value}
      onChange={(next) => next && onChange(next as T)}
      className="count-tabs"
      activateTabWithKeyboard
    >
      <Tabs.List aria-label={t(label)}>
        {items.map(([key, text, count]) => (
          <Tabs.Tab key={key} value={key}>
            {t(text)}
            <Text span fz={12} lh="inherit" c={value === key ? "rouge.4" : "dimmed"}>
              {count.toLocaleString(getLocale())}
            </Text>
          </Tabs.Tab>
        ))}
      </Tabs.List>
    </Tabs>
  );
}
