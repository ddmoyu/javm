// 下载相关类型定义

/** 下载任务状态 */
export enum TaskStatus {
    /** 排队中 */
    Queued = 'queued',
    /** 准备中 */
    Preparing = 'preparing',
    /** 下载中 */
    Downloading = 'downloading',
    /** 已暂停 */
    Paused = 'paused',
    /** 合并中 */
    Merging = 'merging',
    /** 已完成 */
    Completed = 'completed',
    /** 失败 */
    Failed = 'failed',
    /** 重试中 */
    Retrying = 'retrying',
    /** 已取消 */
    Cancelled = 'cancelled',
    /** 刮削中 */
    Scraping = 'scraping',
}

/** 下载器类型 */
export enum DownloaderType {
    NM3u8DLRE = 'N_m3u8DL-RE',
    FFmpeg = 'ffmpeg',
}

/** 下载任务 */
export interface DownloadTask {
    id: string
    url: string
    filename: string
    savePath: string
    status: TaskStatus
    progress: number
    speed: number
    downloaded: number
    total: number
    downloader: DownloaderType
    retryCount: number
    error?: string
    createdAt: string
    startedAt?: string
    completedAt?: string
    /** 下载链接来源站点 id（资源链接添加时记录，用于下载源成功评分） */
    sourceSite?: string
}

/** 下载进度事件 */
export interface DownloadProgress {
    taskId: string
    progress: number
    speed: number
    downloaded: number
    total: number
    status: TaskStatus | number // 支持后端的数字状态和前端的字符串状态
}

/** 批量操作类型 */
export type BatchAction = 'stop' | 'retry' | 'delete'
