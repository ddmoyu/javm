import { useId } from "react";
import type { ReactNode } from "react";
import { Group, Paper, Text } from "@mantine/core";
import { Icon } from "../../components/icons";
import type { IconName } from "../../components/icons";
import classes from "./Settings.module.css";

export function SettingCard({
  title,
  icon,
  extra,
  children,
}: {
  title: string;
  icon: IconName;
  extra?: ReactNode;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <Paper component="section" className={classes.card} aria-labelledby={headingId}>
      <Group className={classes.cardHeading} justify="space-between" gap="sm">
        <Group gap={9}>
          <Icon name={icon} size={18} />
          <Text component="h3" id={headingId} size="sm" fw={600}>
            {title}
          </Text>
        </Group>
        {extra}
      </Group>
      <div className={classes.cardBody}>{children}</div>
    </Paper>
  );
}

export function SettingRow({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className={classes.row}>
      <div className={classes.rowText}>
        <Text size="sm" fw={500}>
          {title}
        </Text>
        {hint && (
          <Text size="xs" c="dimmed" mt={4} lh={1.65}>
            {hint}
          </Text>
        )}
      </div>
      <div className={classes.rowControl}>{children}</div>
    </div>
  );
}

export function SettingNote({ children }: { children: ReactNode }) {
  return (
    <div className={classes.note}>
      <Icon name="info" size={17} />
      <Text component="div" size="xs" lh={1.7}>
        {children}
      </Text>
    </div>
  );
}
