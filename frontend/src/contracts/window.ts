/** 桌面坐标统一使用物理像素，允许副屏位于主屏左侧或上方。 */
export interface DesktopRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowDisplay {
  primary: boolean;
  bounds: DesktopRect;
  workArea: DesktopRect;
}
