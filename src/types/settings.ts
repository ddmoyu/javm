// 设置相关类型定义

/** 主题类型 */
export type ThemeMode = 'light' | 'dark' | 'system'

/** 语言类型 */
export type Language = 'zh-CN' | 'zh-TW' | 'en' | 'ja'

/** 代理类型 */
export type ProxyType = 'system' | 'custom'

/** 代理配置 */
export interface ProxySettings {
    type: ProxyType
    host: string
    port: number
}

/** AI 提供商类型 */
export type AIProviderType = 'openai' | 'deepseek' | 'claude' | 'custom'

/** 下载工具配置 */
export interface DownloaderTool {
    name: string
    executable: string
    customPath?: string
    enabled: boolean
    status?: 'available' | 'not-found'
}

/** AI 提供商配置 */
export interface AIProvider {
    id: string
    provider: AIProviderType
    name: string
    apiKey: string
    endpoint?: string
    model: string
    priority: number
    active: boolean
    rateLimit: number
}

/** 基础设置 */
export interface ThemeSettings {
    mode: ThemeMode
    language: Language
    proxy: ProxySettings
}

/** 显示模式 */
export type ViewMode = 'card' | 'list' | 'waterfall'

/** 播放方式 */
export type PlayMethod = 'system' | 'software'

/** 封面类型（横屏/竖屏） */
export type CoverType = 'landscape' | 'portrait'

/** 通用设置 */
export interface GeneralSettings {
    scanPaths: string[]
    viewMode: ViewMode
    playMethod: PlayMethod
    coverClickToPlay: boolean
    coverType: CoverType
    /** 演员面板作品卡片大小（网格 min 列宽 px） */
    actorCardSize: number
}

/** 下载源（资源链接视频站） */
export interface DownloadSource {
    id: string
    name: string
    urlTemplate: string
    enabled: boolean
    /** 下载成功累计次数：越高排名越靠前 */
    successCount: number
}

/** 下载设置 */
export interface DownloadSettings {
    savePath: string
    concurrent: number
    autoRetry: boolean
    maxRetries: number
    downloaderPriority: string[]
    tools?: DownloaderTool[]
    autoScrape: boolean
    sources: DownloadSource[]
}

/** 资源网站配置 */
export interface ResourceSite {
    id: string           // 网站标识（如 "javbus"）
    name: string         // 显示名称
    enabled: boolean     // 是否启用
    /** 累计平均丰富度得分（0-100），多次刮削结果加权平均 */
    avgScore?: number
    /** 累计刮削次数（有效返回结果的次数） */
    scrapeCount?: number
}

/** 反爬工具箱设置 */
export interface AntiBlockSettings {
    enabled: boolean                // 总开关
    rateLimitEnabled: boolean       // 请求间隔限速
    minIntervalMs: number           // 同站点两次请求最小间隔（毫秒）
    maxIntervalMs: number           // 同站点两次请求最大间隔（毫秒）
    maxRetries: number              // 失败最大重试次数
    uaRotationEnabled: boolean      // UA / 指纹轮换
    mirrorRotationEnabled: boolean  // 多镜像域名轮换
    proxyPoolEnabled: boolean       // 成功率加权代理池
    proxies: string[]               // 代理 URL 列表
}

/** 刮削设置 */
export interface ScrapeSettings {
    concurrent: number
    scraperPriority: string[]
    maxWebviewWindows: number
    linkFinderConcurrency: number // 并行查找源的最大并发数（1-3）
    linkFinderSourceTimeoutSecs: number // 单个源最长查找秒数（无正片即放弃）
    webviewEnabled: boolean    // 是否启用 WebView 增强模式
    webviewFallbackEnabled: boolean // HTTP 失败后是否回退到 WebView（开发者选项）
    devShowWebview: boolean    // 开发调试时默认显示隐藏 WebView（开发者选项）
    defaultSite: string        // 默认刮削网站（如 "javbus"）
    sites: ResourceSite[]      // 资源网站列表
    linkFinderSite: string     // 资源链接查找器上次选择的视频站点 id
    antiBlock: AntiBlockSettings // 反爬工具箱配置
    uncensoredMode: boolean    // 一键无码模式：所有刮削强制走无码路由
}

/** AI 设置 */
export interface AISettings {
    providers: AIProvider[]
    cacheEnabled: boolean
    cacheDuration: number
    translateScrapeResult: boolean
}

/** 视频播放器设置 */
export interface VideoPlayerSettings {
    width?: number
    height?: number
    x?: number
    y?: number
    alwaysOnTop: boolean
}

/** 主窗口设置 */
export interface MainWindowSettings {
    width?: number
    height?: number
    x?: number
    y?: number
}

/** MetaTube sidecar 聚合源设置 */
export interface MetaTubeSettings {
    enabled: boolean        // 是否启用（默认开启）
    providers: string[]     // 偏好 provider 列表（空 = 服务端默认全部）
}

/** 更新通道：stable=仅正式版，rc=含 RC，beta=含 Beta 和 RC */
export type UpdateChannel = 'stable' | 'rc' | 'beta'

/** 应用更新设置 */
export interface UpdateSettings {
    channel: UpdateChannel
}

/** 元数据存储模式：follow_video=跟随视频同目录，independent=独立目录 */
export type MetadataStorageMode = 'follow_video' | 'independent'

/** 元数据（NFO + 图片）存储设置 */
export interface MetadataSettings {
    storageMode: MetadataStorageMode   // 存储模式
    rootDir: string                    // 独立目录模式下的元数据根目录
}

/** 完整应用设置 */
export interface AppSettings {
    theme: ThemeSettings
    general: GeneralSettings
    download: DownloadSettings
    scrape: ScrapeSettings
    ai: AISettings
    videoPlayer: VideoPlayerSettings
    mainWindow: MainWindowSettings
    metatube: MetaTubeSettings
    update: UpdateSettings
    metadata: MetadataSettings
}

/** 默认设置 */
export const defaultSettings: AppSettings = {
    theme: {
        mode: 'system',
        language: 'zh-CN',
        proxy: {
            type: 'system',
            host: '',
            port: 7890,
        },
    },
    general: {
        scanPaths: [],
        viewMode: 'card',
        playMethod: 'software',
        coverClickToPlay: true,
        coverType: 'landscape',
        actorCardSize: 160,
    },
    download: {
        savePath: '',
        concurrent: 3,
        autoRetry: true,
        maxRetries: 3,
        downloaderPriority: ['N_m3u8DL-RE', 'ffmpeg'],
        tools: [
            {
                name: 'N_m3u8DL-RE',
                executable: 'bin/N_m3u8DL-RE',
                enabled: true,
            },
            {
                name: 'ffmpeg',
                executable: 'bin/ffmpeg',
                enabled: true,
            },
        ],
        autoScrape: true,
        sources: [],
    },
    scrape: {
        concurrent: 5,
        scraperPriority: ['javbus', 'javmenu', 'javxx'],
        maxWebviewWindows: 3,
        linkFinderConcurrency: 3,
        linkFinderSourceTimeoutSecs: 60,
        webviewEnabled: false,
        webviewFallbackEnabled: false,
        devShowWebview: false,
        defaultSite: 'javbus',
        linkFinderSite: 'missav',
        uncensoredMode: false,
        sites: [
            { id: 'javbus', name: '数据源 1', enabled: true },
            { id: 'javmenu', name: '数据源 2', enabled: true },
            { id: 'javsb', name: '数据源 3', enabled: true },
            { id: 'javxx', name: '数据源 4', enabled: true },
            { id: 'javplace', name: '数据源 5', enabled: true },
            { id: 'projectjav', name: '数据源 6', enabled: true },
            { id: '3xplanet', name: '数据源 7', enabled: true },
            { id: 'freejavbt', name: '数据源 8', enabled: true },
            { id: 'javlibrary', name: '数据源 9', enabled: true },
        ],
        antiBlock: {
            enabled: true,
            rateLimitEnabled: true,
            minIntervalMs: 800,
            maxIntervalMs: 2000,
            maxRetries: 2,
            uaRotationEnabled: true,
            mirrorRotationEnabled: true,
            proxyPoolEnabled: false,
            proxies: [],
        },
    },
    ai: {
        providers: [],
        cacheEnabled: true,
        cacheDuration: 3600,
        translateScrapeResult: false,
    },
    videoPlayer: {
        alwaysOnTop: false,
    },
    mainWindow: {},
    metatube: {
        enabled: true,
        providers: [],
    },
    update: {
        channel: 'stable',
    },
    metadata: {
        storageMode: 'follow_video',
        rootDir: '',
    },
}
