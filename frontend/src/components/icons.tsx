import type { Icon as PhosphorIcon, IconProps as PhosphorIconProps } from "@phosphor-icons/react";
import { ArrowLeftIcon } from "@phosphor-icons/react/dist/csr/ArrowLeft";
import { ArrowUpIcon } from "@phosphor-icons/react/dist/csr/ArrowUp";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import { ArrowsDownUpIcon } from "@phosphor-icons/react/dist/csr/ArrowsDownUp";
import { BellIcon } from "@phosphor-icons/react/dist/csr/Bell";
import { BooksIcon } from "@phosphor-icons/react/dist/csr/Books";
import { BuildingsIcon } from "@phosphor-icons/react/dist/csr/Buildings";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CaretLeftIcon } from "@phosphor-icons/react/dist/csr/CaretLeft";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { ClockIcon } from "@phosphor-icons/react/dist/csr/Clock";
import { CompassIcon } from "@phosphor-icons/react/dist/csr/Compass";
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { CopySimpleIcon } from "@phosphor-icons/react/dist/csr/CopySimple";
import { CornersOutIcon } from "@phosphor-icons/react/dist/csr/CornersOut";
import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import { DotsThreeIcon } from "@phosphor-icons/react/dist/csr/DotsThree";
import { DownloadSimpleIcon } from "@phosphor-icons/react/dist/csr/DownloadSimple";
import { EyeIcon } from "@phosphor-icons/react/dist/csr/Eye";
import { EyeSlashIcon } from "@phosphor-icons/react/dist/csr/EyeSlash";
import { FilmStripIcon } from "@phosphor-icons/react/dist/csr/FilmStrip";
import { FolderIcon } from "@phosphor-icons/react/dist/csr/Folder";
import { FunnelIcon } from "@phosphor-icons/react/dist/csr/Funnel";
import { GaugeIcon } from "@phosphor-icons/react/dist/csr/Gauge";
import { GearSixIcon } from "@phosphor-icons/react/dist/csr/GearSix";
import { GitMergeIcon } from "@phosphor-icons/react/dist/csr/GitMerge";
import { GlobeIcon } from "@phosphor-icons/react/dist/csr/Globe";
import { HardDriveIcon } from "@phosphor-icons/react/dist/csr/HardDrive";
import { HeartIcon } from "@phosphor-icons/react/dist/csr/Heart";
import { ImageIcon } from "@phosphor-icons/react/dist/csr/Image";
import { InfoIcon } from "@phosphor-icons/react/dist/csr/Info";
import { KeyIcon } from "@phosphor-icons/react/dist/csr/Key";
import { KeyboardIcon } from "@phosphor-icons/react/dist/csr/Keyboard";
import { LightningIcon } from "@phosphor-icons/react/dist/csr/Lightning";
import { LinkSimpleIcon } from "@phosphor-icons/react/dist/csr/LinkSimple";
import { ListBulletsIcon } from "@phosphor-icons/react/dist/csr/ListBullets";
import { LockSimpleIcon } from "@phosphor-icons/react/dist/csr/LockSimple";
import { MagnetIcon } from "@phosphor-icons/react/dist/csr/Magnet";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { MinusIcon } from "@phosphor-icons/react/dist/csr/Minus";
import { MoonIcon } from "@phosphor-icons/react/dist/csr/Moon";
import { PauseIcon } from "@phosphor-icons/react/dist/csr/Pause";
import { PencilSimpleIcon } from "@phosphor-icons/react/dist/csr/PencilSimple";
import { PlayIcon } from "@phosphor-icons/react/dist/csr/Play";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { BroadcastIcon } from "@phosphor-icons/react/dist/csr/Broadcast";
import { ScanIcon } from "@phosphor-icons/react/dist/csr/Scan";
import { ShieldIcon } from "@phosphor-icons/react/dist/csr/Shield";
import { SidebarSimpleIcon } from "@phosphor-icons/react/dist/csr/SidebarSimple";
import { SkipBackIcon } from "@phosphor-icons/react/dist/csr/SkipBack";
import { SkipForwardIcon } from "@phosphor-icons/react/dist/csr/SkipForward";
import { SortAscendingIcon } from "@phosphor-icons/react/dist/csr/SortAscending";
import { SortDescendingIcon } from "@phosphor-icons/react/dist/csr/SortDescending";
import { SparkleIcon } from "@phosphor-icons/react/dist/csr/Sparkle";
import { SpeakerHighIcon } from "@phosphor-icons/react/dist/csr/SpeakerHigh";
import { SquareIcon } from "@phosphor-icons/react/dist/csr/Square";
import { SquaresFourIcon } from "@phosphor-icons/react/dist/csr/SquaresFour";
import { StackIcon } from "@phosphor-icons/react/dist/csr/Stack";
import { StarIcon } from "@phosphor-icons/react/dist/csr/Star";
import { StopIcon } from "@phosphor-icons/react/dist/csr/Stop";
import { SubtitlesIcon } from "@phosphor-icons/react/dist/csr/Subtitles";
import { SunIcon } from "@phosphor-icons/react/dist/csr/Sun";
import { TagIcon } from "@phosphor-icons/react/dist/csr/Tag";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import { UploadSimpleIcon } from "@phosphor-icons/react/dist/csr/UploadSimple";
import { UserIcon } from "@phosphor-icons/react/dist/csr/User";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";

// 统一语义名称，按图标路径导入，避免开发时处理整个图标库。
const icons = {
  library: BooksIcon,
  compass: CompassIcon,
  folder: FolderIcon,
  download: DownloadSimpleIcon,
  radar: BroadcastIcon,
  settings: GearSixIcon,
  play: PlayIcon,
  pause: PauseIcon,
  stop: StopIcon,
  search: MagnifyingGlassIcon,
  heart: HeartIcon,
  star: StarIcon,
  grid: SquaresFourIcon,
  list: ListBulletsIcon,
  filter: FunnelIcon,
  plus: PlusIcon,
  x: XIcon,
  check: CheckIcon,
  dots: DotsThreeIcon,
  refresh: ArrowsClockwiseIcon,
  trash: TrashIcon,
  alert: WarningIcon,
  info: InfoIcon,
  link: LinkSimpleIcon,
  copy: CopyIcon,
  user: UserIcon,
  building: BuildingsIcon,
  layers: StackIcon,
  tag: TagIcon,
  film: FilmStripIcon,
  sun: SunIcon,
  moon: MoonIcon,
  chevronLeft: CaretLeftIcon,
  chevronRight: CaretRightIcon,
  chevronDown: CaretDownIcon,
  minimize: MinusIcon,
  maximize: SquareIcon,
  volume: SpeakerHighIcon,
  fullscreen: CornersOutIcon,
  skipBack: SkipBackIcon,
  skipForward: SkipForwardIcon,
  sparkles: SparkleIcon,
  globe: GlobeIcon,
  key: KeyIcon,
  cpu: CpuIcon,
  clock: ClockIcon,
  drive: HardDriveIcon,
  external: ArrowSquareOutIcon,
  edit: PencilSimpleIcon,
  image: ImageIcon,
  magnet: MagnetIcon,
  upload: UploadSimpleIcon,
  sort: ArrowsDownUpIcon,
  eye: EyeIcon,
  eyeSlash: EyeSlashIcon,
  bolt: LightningIcon,
  merge: GitMergeIcon,
  shield: ShieldIcon,
  bell: BellIcon,
  keyboard: KeyboardIcon,
  subtitles: SubtitlesIcon,
  gauge: GaugeIcon,
  scan: ScanIcon,
  chevron: CaretRightIcon,
  sidebar: SidebarSimpleIcon,
  down: CaretDownIcon,
  more: DotsThreeIcon,
  sortAsc: SortAscendingIcon,
  sortDesc: SortDescendingIcon,
  warning: WarningIcon,
  close: XIcon,
  arrow: ArrowLeftIcon,
  arrowUp: ArrowUpIcon,
  lock: LockSimpleIcon,
  restore: CopySimpleIcon,
} as const satisfies Record<string, PhosphorIcon>;

export type IconName = keyof typeof icons;

interface IconProps extends Omit<PhosphorIconProps, "size"> {
  name: IconName;
  size?: number;
  filled?: boolean;
}

export function Icon({
  name,
  size = 18,
  filled = false,
  weight = filled ? "fill" : "regular",
  ...rest
}: IconProps) {
  const Component = icons[name];
  return <Component size={size} weight={weight} aria-hidden="true" focusable="false" {...rest} />;
}

/** 沿用旧版 JAVM 的品牌图标。 */
export function BrandMark({ size = 20 }: { size?: number }) {
  return <img src="/logo.png" width={size} height={size} alt="" draggable={false} />;
}
