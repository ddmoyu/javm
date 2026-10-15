import { Fragment, createElement } from "react";
import type { ReactNode } from "react";
import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Checkbox,
  CloseButton,
  Drawer,
  Menu,
  Modal,
  MultiSelect,
  Paper,
  PasswordInput,
  Select,
  Tooltip,
  createTheme,
} from "@mantine/core";
import type { CSSVariablesResolver, MantineColorsTuple } from "@mantine/core";
import { Icon } from "../components/icons";

function CheckboxIcon({
  indeterminate,
  className,
}: {
  indeterminate: boolean | undefined;
  className: string;
}) {
  return createElement(Icon, {
    name: indeterminate ? "minimize" : "check",
    weight: "bold",
    className,
  });
}

function PasswordVisibilityIcon({ reveal }: { reveal: boolean }) {
  return createElement(Icon, { name: reveal ? "eyeSlash" : "eye", size: 16 });
}

function renderSelectOption({
  option,
  checked,
}: {
  option: { label: ReactNode };
  checked?: boolean;
}) {
  return createElement(
    Fragment,
    null,
    checked && createElement(Icon, { name: "check", size: 14, style: { flexShrink: 0 } }),
    createElement("span", null, option.label),
  );
}

// Velvet：深夜酒廊式的配色。丝绒黑紫做底，玫瑰霓虹做主色，香槟金只用于评分和收藏。
const rouge: MantineColorsTuple = [
  "#ffe9f1",
  "#ffd0e0",
  "#ffa0c0",
  "#ff6d9f",
  "#ff4283",
  "#ff2672",
  "#f5156a",
  "#d90b5b",
  "#c20050",
  "#aa0045",
];
const orchid: MantineColorsTuple = [
  "#f8ecff",
  "#ebd4fd",
  "#d3a6f7",
  "#ba76f2",
  "#a44dee",
  "#9733eb",
  "#9024ea",
  "#7c18d1",
  "#6e12bb",
  "#5f09a5",
];
const champagne: MantineColorsTuple = [
  "#fff8e6",
  "#fbeed3",
  "#f4dba6",
  "#edc674",
  "#e7b54b",
  "#e4aa31",
  "#e2a423",
  "#c88f16",
  "#b27f0d",
  "#9a6c00",
];
const wine: MantineColorsTuple = [
  "#ffeaee",
  "#f6d3d9",
  "#e8a6b1",
  "#da7586",
  "#ce4c62",
  "#c7324b",
  "#c4243f",
  "#ad1631",
  "#9b0e2b",
  "#880024",
];
// 带紫调的暗色阶，替换 Mantine 默认的中性灰。
const dark: MantineColorsTuple = [
  "#f3e8ef",
  "#d6c3cf",
  "#ab93a5",
  "#85697e",
  "#4d3449",
  "#3a2539",
  "#2b1a2c",
  "#21121f",
  "#180c18",
  "#0f0710",
];

const sans = '"Segoe UI Variable", "Segoe UI", "Microsoft YaHei UI", "PingFang SC", sans-serif';
export const display =
  '"Bodoni MT", "Didot", "Playfair Display", "Noto Serif SC", "Source Han Serif SC", "SimSun", serif';

export const theme = createTheme({
  primaryColor: "rouge",
  primaryShade: { light: 7, dark: 5 },
  colors: { rouge, orchid, champagne, wine, dark },
  defaultRadius: "md",
  cursorType: "pointer",
  fontFamily: sans,
  fontFamilyMonospace: '"Cascadia Mono", "JetBrains Mono", Consolas, monospace',
  fontSizes: { xs: "12px", sm: "13px", md: "14px", lg: "16px", xl: "20px" },
  headings: { fontFamily: display, fontWeight: "600" },
  defaultGradient: { from: "rouge.5", to: "orchid.6", deg: 125 },
  shadows: {
    md: "0 10px 30px -12px rgba(255, 38, 114, 0.28), 0 4px 12px rgba(0, 0, 0, 0.35)",
    xl: "0 24px 60px -18px rgba(255, 38, 114, 0.35), 0 12px 28px rgba(0, 0, 0, 0.5)",
  },
  components: {
    CloseButton: CloseButton.extend({
      defaultProps: { icon: createElement(Icon, { name: "close", size: 14 }) },
    }),
    Checkbox: Checkbox.extend({ defaultProps: { icon: CheckboxIcon } }),
    Select: Select.extend({
      defaultProps: {
        rightSection: createElement(Icon, { name: "down", size: 14 }),
        renderOption: renderSelectOption,
      },
    }),
    MultiSelect: MultiSelect.extend({
      defaultProps: {
        rightSection: createElement(Icon, { name: "down", size: 14 }),
        renderOption: renderSelectOption,
      },
    }),
    PasswordInput: PasswordInput.extend({
      defaultProps: { visibilityToggleIcon: PasswordVisibilityIcon },
    }),
    Button: Button.extend({ defaultProps: { radius: "xl" } }),
    ActionIcon: ActionIcon.extend({ defaultProps: { variant: "subtle", color: "gray" } }),
    Badge: Badge.extend({ defaultProps: { radius: "sm" } }),
    Card: Card.extend({ defaultProps: { radius: "lg" } }),
    Paper: Paper.extend({ defaultProps: { radius: "lg" } }),
    Tooltip: Tooltip.extend({ defaultProps: { withArrow: true, openDelay: 300 } }),
    Menu: Menu.extend({ defaultProps: { shadow: "xl", radius: "md", width: 200 } }),
    Modal: Modal.extend({
      defaultProps: {
        radius: "lg",
        closeButtonProps: { "aria-label": "关闭对话框" },
        overlayProps: { backgroundOpacity: 0.7, blur: 6 },
      },
    }),
    Drawer: Drawer.extend({
      defaultProps: {
        closeButtonProps: { "aria-label": "关闭面板" },
        overlayProps: { backgroundOpacity: 0.6, blur: 4 },
      },
    }),
  },
});

export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {},
  light: {
    "--mantine-color-body": "#fbf3f6",
    "--velvet-surface": "#ffffff",
    "--velvet-sunken": "#f5e7ee",
    "--velvet-line": "rgba(170, 0, 69, 0.12)",
    "--velvet-glow": "rgba(245, 21, 106, 0.16)",
  },
  dark: {
    "--mantine-color-body": "#110813",
    "--velvet-surface": "#1a0e1b",
    "--velvet-sunken": "#0b050c",
    "--velvet-line": "rgba(255, 110, 160, 0.12)",
    "--velvet-glow": "rgba(255, 38, 114, 0.22)",
  },
});
