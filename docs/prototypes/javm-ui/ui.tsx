import type { ReactNode } from "react";
import { ActionIcon, Tooltip } from "@mantine/core";
import { Icon } from "./visuals";
import type { IconName } from "./visuals";

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
  return (
    <Tooltip label={label} withArrow>
      <ActionIcon
        aria-label={label}
        aria-pressed={active}
        onClick={onClick}
        variant={active ? "light" : "subtle"}
        color={active ? "rose" : "gray"}
        size={34}
        disabled={disabled}
      >
        <Icon name={icon} />
      </ActionIcon>
    </Tooltip>
  );
}
export function PageActions({ children }: { children: ReactNode }) {
  return <div className="page-actions">{children}</div>;
}
export function Pill({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "accent" | "success" | "warning" | "danger";
}) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}
export function Empty({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <Icon name="search" size={32} />
      <h3>{title}</h3>
      <p>{description}</p>
      {children}
    </div>
  );
}
