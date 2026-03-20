// 资源搜索相关类型定义

/** 资源搜索结果项 */
export interface ResourceItem {
  code: string          // 番号
  title: string         // 名称
  actors: string        // 演员（逗号分隔）
  duration: string      // 时长（如 "120分钟"）
  studio: string        // 制作商
  source?: string       // 数据来源（数据源名称）
  coverUrl?: string     // 封面图 URL（可能是本地缓存路径）
  remoteCoverUrl?: string // 原始远程封面 URL（代理后保留）
  remoteThumbs?: string[] // 原始远程预览图 URL（代理后保留）
  director?: string     // 导演
  tags?: string         // 标签/分类（逗号分隔）
  premiered?: string    // 发行日期
  rating?: number       // 评分
  thumbs?: string[] // 预览图 URL 列表
}

/** 数据源定义 */
export interface DataSource {
  name: string                                  // 数据源名称
  buildUrl: (code: string) => string            // URL 构建函数
  parse: (html: string) => ResourceItem | null  // HTML 解析函数
}
