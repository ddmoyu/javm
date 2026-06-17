// 常量定义

/** 支持的视频文件扩展名 */
export const VIDEO_EXTENSIONS = [
    'mp4', 'mkv', 'avi', 'wmv', 'mov', 'flv', 'webm', 'm4v', 'rmvb', 'ts'
]

/** 扫描状态文本映射 */
export const SCAN_STATUS_TEXT: Record<number, string> = {
    0: '待识别',
    1: '未刮削',
    2: '已完成',
    3: '识别失败',
    4: '刮削失败',
}

/** 扫描状态颜色映射 */
export const SCAN_STATUS_VARIANT: Record<number, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    0: 'secondary',
    1: 'outline',
    2: 'default',
    3: 'destructive',
    4: 'destructive',
}

/** 下载状态文本映射 */
export const DOWNLOAD_STATUS_TEXT: Record<string, string> = {
    queued: '排队中',
    preparing: '准备中',
    downloading: '下载中',
    paused: '已暂停',
    merging: '合并中',
    completed: '已完成',
    failed: '失败',
    retrying: '重试中',
    cancelled: '已取消',
    scraping: '刮削中',
}

/** 下载状态颜色映射 */
export const DOWNLOAD_STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    queued: 'secondary',
    preparing: 'outline',
    downloading: 'default',
    paused: 'outline',
    merging: 'outline',
    completed: 'default',
    failed: 'destructive',
    retrying: 'outline',
    cancelled: 'secondary',
    scraping: 'outline',
}

/** 刮削状态文本映射 */
export const SCRAPE_STATUS_TEXT: Record<string, string> = {
    waiting: '等待中',
    running: '进行中',
    completed: '已完成',
    partial: '部分完成',
    failed: '失败',
}

/** 导航菜单配置 */
export const NAV_ITEMS = [
    {
        title: '媒体库',
        icon: 'Film',
        path: '/',
    },
    {
        title: '下载管理',
        icon: 'Download',
        path: '/download',
    },
    {
        title: '刮削中心',
        icon: 'Search',
        path: '/scrape',
    },
    {
        title: '系统设置',
        icon: 'Settings',
        path: '/settings',
    },
]

/** AI 提供商选项 */
export const AI_PROVIDER_OPTIONS = [
    { label: 'OpenAI', value: 'openai' },
    { label: 'DeepSeek', value: 'deepseek' },
    { label: 'Claude', value: 'claude' },
    { label: '自定义', value: 'custom' },
]

/** 主题选项 */
export const THEME_OPTIONS = [
    { label: '浅色', value: 'light' },
    { label: '深色', value: 'dark' },
    { label: '跟随系统', value: 'system' },
]

/** 显示模式选项 */
export const VIEW_MODE_OPTIONS = [
    { label: '卡片模式', value: 'card' },
    { label: '瀑布流', value: 'waterfall' },
    { label: '列表模式', value: 'list' },
]

/** 瀑布流(等高画廊)模式：封面固定高度，宽度按自身比例自适应
 *  取值约等于卡片模式横屏封面高度(280×536/800≈188)，保证两种模式卡片大小一致 */
export const WATERFALL_ROW_HEIGHT = 190
/** 瀑布流模式下无封面卡片的占位宽度（窄占位，少占空间） */
export const WATERFALL_NO_COVER_WIDTH = 120

/** 封面类型选项 */
export const COVER_TYPE_OPTIONS = [
    { label: '横屏', value: 'landscape' },
    { label: '竖屏', value: 'portrait' },
]

/**
 * 封面卡片布局配置
 * - landscape：横屏封面，沿用 800x536 比例（JAV fanart 大封面）
 * - portrait：竖屏封面，参考 JAV 海报（DMM 封面右侧裁切）约 378x538 比例
 */
export const COVER_LAYOUTS: Record<'landscape' | 'portrait', {
    cardWidth: number
    /** 封面区高宽比（height / width），用于虚拟列表行高计算 */
    coverAspectRatio: number
    /** CSS aspect-ratio 值（width / height） */
    aspectStyle: string
}> = {
    landscape: { cardWidth: 280, coverAspectRatio: 536 / 800, aspectStyle: '800 / 536' },
    portrait: { cardWidth: 230, coverAspectRatio: 538 / 378, aspectStyle: '378 / 538' },
}
