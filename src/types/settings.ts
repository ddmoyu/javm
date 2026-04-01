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
export type ViewMode = 'card' | 'list'

/** 播放方式 */
export type PlayMethod = 'system' | 'software'

/** 通用设置 */
export interface GeneralSettings {
    scanPaths: string[]
    viewMode: ViewMode
    playMethod: PlayMethod
    coverClickToPlay: boolean
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

/** 刮削设置 */
export interface ScrapeSettings {
    concurrent: number
    scraperPriority: string[]
    maxWebviewWindows: number
    webviewEnabled: boolean    // 是否启用 WebView 增强模式
    webviewFallbackEnabled: boolean // HTTP 失败后是否回退到 WebView（开发者选项）
    devShowWebview: boolean    // 开发调试时默认显示隐藏 WebView（开发者选项）
    defaultSite: string        // 默认刮削网站（如 "javbus"）
    sites: ResourceSite[]      // 资源网站列表
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

/** 完整应用设置 */
export interface AppSettings {
    theme: ThemeSettings
    general: GeneralSettings
    download: DownloadSettings
    scrape: ScrapeSettings
    ai: AISettings
    videoPlayer: VideoPlayerSettings
    mainWindow: MainWindowSettings
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
    },
    scrape: {
        concurrent: 5,
        scraperPriority: ['javbus', 'javmenu', 'javxx'],
        maxWebviewWindows: 3,
        webviewEnabled: false,
        webviewFallbackEnabled: false,
        devShowWebview: false,
        defaultSite: 'javbus',
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
    mainWindow: {}
}
