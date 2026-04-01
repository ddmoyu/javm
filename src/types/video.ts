// 视频相关类型定义

/** 视频扫描状态 */
export enum ScanStatus {
    /** 待识别 */
    Pending = 0,
    /** 未刮削 */
    Identified = 1,
    /** 已完成 */
    Completed = 2,
    /** 识别失败 */
    IdentifyFailed = 3,
    /** 刮削失败 */
    ScrapeFailed = 4,
}

/** 视频信息 */
export interface Video {
    id: string // 视频唯一标识 (videos.id)
    localId?: string // 本地番号 (videos.local_id)
    title: string // 视频标题 (videos.title)
    originalTitle?: string // 原始标题 (videos.original_title)
    studio?: string // 制作商名称 (videos.studio)
    director?: string // 导演名称 (videos.director)
    premiered?: string // 发行日期 (videos.premiered)
    duration?: number // 时长(秒) (videos.duration)
    rating?: number // 评分 (videos.rating)
    poster?: string // 同级 poster 图片路径 (videos.poster)
    thumb?: string // 同级 thumb 图片路径 (videos.thumb)
    fanart?: string // 同级 fanart 图片路径 (videos.fanart)
    fastHash?: string // 快速哈希值 (videos.fast_hash)
    resolution?: string // 分辨率 (videos.resolution)
    videoPath: string // 视频文件路径 (videos.video_path)
    dirPath?: string // 目录路径 (videos.dir_path)
    scanStatus: ScanStatus // 扫描状态 (videos.scan_status)
    fileSize?: number // 文件大小(字节) (videos.file_size)
    actors?: string // 演员列表(逗号分隔) (关联查询)
    tags?: string // 标签列表(逗号分隔) (关联查询)
    genres?: string // 题材列表(逗号分隔) (关联查询)
    createdAt: string // 创建时间 (videos.created_at)
    fileCreatedAt?: string // 文件创建时间（回退到文件修改时间）
    fileModifiedAt?: string // 文件修改时间
    updatedAt: string // 更新时间 (videos.updated_at)
    scrapedAt?: string // 刮削时间 (videos.scraped_at)
}

/** 视频过滤条件 */
export interface VideoFilter {
    search?: string
    tagIds?: number[]
    directoryPath?: string
    minRating?: number
    maxRating?: number
    status?: ScanStatus
    resolution?: string[]
    scraped?: string[] // 刮削状态筛选：'scraped' 已刮削, 'unscraped' 未刮削
    fileCreatedAfter?: string
    sortBy?: 'premiered' | 'rating' | 'createdAt' | 'fileCreatedAt' | 'title' | 'duration' | 'fileSize'
    sortOrder?: 'asc' | 'desc'
}

/** 发行商信息 */
export interface Publisher {
    id: number
    name: string
    nameEn?: string
    logoUrl?: string
    videoCount: number
}

/** 标签信息 */
export interface Tag {
    id: number
    name: string
    category?: string
    usageCount: number
}

/** 演员信息 */
export interface Actor {
    id: number
    name: string
    nameEn?: string
    avatarUrl?: string
    birthDate?: string
    videoCount: number
}
