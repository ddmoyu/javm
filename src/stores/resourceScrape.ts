// 资源刮削统一状态管理
// 合并原有 scrape.ts 和 resourceSearch.ts 的状态和逻辑
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { toast } from 'vue-sonner'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { ScrapeTask, ScrapeLogEntry, ResourceItem } from '@/types'
import { ScrapeStatus } from '@/types'
import { useSettingsStore } from '@/stores/settings'

// ============ 开发模式配置 ============
// 开发阶段设置为 true 以移除时间限制
const DEV_MODE = true

// ============ 后端搜索结果类型（snake_case） ============
interface BackendSearchResult {
    code: string
    title: string
    actors: string
    page_url: string
    detail_level: string
    detail_score: number
    duration: string
    studio: string
    source: string
    cover_url: string
    director: string
    tags: string
    premiered: string
    rating: number | null
    thumbs: string[]
    remote_cover_url?: string | null
    remote_thumb_urls?: string[] | null
}

function sortResourceResults(items: ResourceItem[]): ResourceItem[] {
    return [...items].sort((left, right) => {
        const scoreDiff = (right.detailScore ?? 0) - (left.detailScore ?? 0)
        if (scoreDiff !== 0) return scoreDiff

        const previewDiff = (right.thumbs?.length ?? 0) - (left.thumbs?.length ?? 0)
        if (previewDiff !== 0) return previewDiff

        const ratingDiff = (right.rating ?? 0) - (left.rating ?? 0)
        if (ratingDiff !== 0) return ratingDiff

        return (left.source ?? '').localeCompare(right.source ?? '', 'zh-CN')
    })
}

/** 将后端 snake_case 结果转换为前端 camelCase ResourceItem */
function toResourceItem(r: BackendSearchResult): ResourceItem {
    return {
        code: r.code,
        title: r.title,
        actors: r.actors,
        detailLevel: r.detail_level,
        detailScore: r.detail_score,
        duration: r.duration,
        studio: r.studio,
        source: r.source,
        pageUrl: r.page_url,
        coverUrl: r.cover_url,
        remoteCoverUrl: r.remote_cover_url ?? undefined,
        director: r.director,
        tags: r.tags,
        premiered: r.premiered,
        rating: r.rating ?? undefined,
        thumbs: r.thumbs,
        remoteThumbs: r.remote_thumb_urls ?? undefined,
    }
}

// ============ 动态延迟控制器 ============
// 根据连续刮削次数动态调整延迟时间
class DynamicDelayController {
    private scrapeCount: number = 0
    private resetTimer: NodeJS.Timeout | null = null

    // 获取当前延迟时间（毫秒）
    getDelay(): number {
        if (DEV_MODE) return 0
        if (this.scrapeCount < 10) return 2000
        if (this.scrapeCount < 20) return 5000
        if (this.scrapeCount < 30) return 10000
        return 15000
    }

    // 记录一次刮削
    recordScrape(): void {
        this.scrapeCount++
        this.resetResetTimer()
    }

    // 重置计数器（5分钟无活动后）
    private resetResetTimer(): void {
        if (this.resetTimer) clearTimeout(this.resetTimer)
        this.resetTimer = setTimeout(() => {
            this.scrapeCount = 0
        }, 5 * 60 * 1000)
    }

    // 等待延迟
    async wait(): Promise<void> {
        const delay = this.getDelay()
        if (delay > 0) {
            await new Promise(resolve => setTimeout(resolve, delay))
        }
    }

    // 获取当前刮削次数
    getScrapeCount(): number {
        return this.scrapeCount
    }
}

// ============ 限流保护器 ============
// 跟踪每小时的刮削次数，防止 IP 被封
class RateLimiter {
    private readonly MAX_PER_HOUR = 50
    private scrapeHistory: number[] = []

    constructor() {
        this.loadFromStorage()
    }

    // 检查是否可以刮削
    canScrape(): boolean {
        if (DEV_MODE) return true
        this.cleanOldRecords()
        return this.scrapeHistory.length < this.MAX_PER_HOUR
    }

    // 记录一次刮削
    recordScrape(): void {
        this.scrapeHistory.push(Date.now())
        this.saveToStorage()
    }

    // 获取剩余配额
    getRemainingQuota(): number {
        if (DEV_MODE) return 999
        this.cleanOldRecords()
        return Math.max(0, this.MAX_PER_HOUR - this.scrapeHistory.length)
    }

    // 获取重置时间（分钟）
    getResetTime(): number {
        if (DEV_MODE) return 0
        if (this.scrapeHistory.length === 0) return 0
        const oldestTime = Math.min(...this.scrapeHistory)
        const resetTime = oldestTime + 60 * 60 * 1000
        return Math.max(0, Math.ceil((resetTime - Date.now()) / 60000))
    }

    // 清理1小时前的记录
    private cleanOldRecords(): void {
        const oneHourAgo = Date.now() - 60 * 60 * 1000
        this.scrapeHistory = this.scrapeHistory.filter(time => time > oneHourAgo)
    }

    // 持久化到 localStorage
    private saveToStorage(): void {
        localStorage.setItem('scrape_history', JSON.stringify(this.scrapeHistory))
    }

    // 从 localStorage 加载
    loadFromStorage(): void {
        const data = localStorage.getItem('scrape_history')
        if (data) {
            try {
                this.scrapeHistory = JSON.parse(data)
                this.cleanOldRecords()
            } catch (e) {
                console.error('Failed to load scrape history:', e)
                this.scrapeHistory = []
            }
        }
    }
}

/** 根据本次搜索结果，累计更新各数据源的平均丰富度得分 */
function accumulateSourceScores(searchResults: ResourceItem[]) {
    const settingsStore = useSettingsStore()
    const sites = settingsStore.settings.scrape.sites
    if (!sites?.length || !searchResults.length) return

    // 按来源聚合本次最高得分
    const scoreBySource = new Map<string, number>()
    for (const item of searchResults) {
        if (!item.source || item.detailScore == null) continue
        const prev = scoreBySource.get(item.source) ?? 0
        if (item.detailScore > prev) {
            scoreBySource.set(item.source, item.detailScore)
        }
    }

    if (scoreBySource.size === 0) return

    let changed = false
    const updatedSites = sites.map(site => {
        const score = scoreBySource.get(site.id)
        if (score == null) return site

        const prevAvg = site.avgScore ?? 0
        const prevCount = site.scrapeCount ?? 0
        const newCount = prevCount + 1
        // 增量平均：newAvg = prevAvg + (score - prevAvg) / newCount
        const newAvg = Math.round(prevAvg + (score - prevAvg) / newCount)

        changed = true
        return { ...site, avgScore: newAvg, scrapeCount: newCount }
    })

    if (changed) {
        settingsStore.updateSettings({
            scrape: { ...settingsStore.settings.scrape, sites: updatedSites }
        })
    }
}

export const useResourceScrapeStore = defineStore('resourceScrape', () => {
    // ============ 搜索状态 ============
    const keyword = ref('')
    const results = ref<ResourceItem[]>([])
    const searchLoading = ref(false)
    const searched = ref(false)
    const searchError = ref<string | null>(null)
    const cfChallengeActive = ref(false)

    // 当前搜索的取消函数
    let cancelCurrentSearch: (() => void) | null = null

    // ============ 刮削任务状态 ============
    const tasks = ref<ScrapeTask[]>([])
    const logs = ref<ScrapeLogEntry[]>([])
    const loading = ref(false)
    const error = ref<string | null>(null)
    // ============ 任务队列控制 ============
    const isProcessingQueue = ref(false)
    const delayController = new DynamicDelayController()
    const rateLimiter = new RateLimiter()

    // ============ Getters ============
    const runningTasks = computed(() =>
        tasks.value.filter(t => t.status === ScrapeStatus.Running)
    )

    const completedTasks = computed(() =>
        tasks.value.filter(t => t.status === ScrapeStatus.Completed || t.status === ScrapeStatus.PartialCompleted)
    )

    const stats = computed(() => ({
        total: tasks.value.length,
        waiting: tasks.value.filter(t => t.status === ScrapeStatus.Waiting).length,
        running: tasks.value.filter(t => t.status === ScrapeStatus.Running).length,
        completed: tasks.value.filter(t => t.status === ScrapeStatus.Completed).length,
        failed: tasks.value.filter(t => t.status === ScrapeStatus.Failed).length,
    }))

    const recentLogs = computed(() => logs.value.slice(0, 100))

    type CfStatePayload = {
        status: 'idle' | 'active' | 'passed' | 'timeout' | 'failed'
        active: boolean
        siteId?: string
        activeCount?: number
    }

    // ============ 搜索操作 ============

    /**
     * 执行流式搜索
     * 使用 Tauri 事件 search-result / search-done 实现流式推送
     * @param input 番号关键词
     * @param source 可选，指定单个数据源 ID（如 "javbus"），不传则搜索全部
     */
    async function search(input: string, source?: string) {
        const trimmed = input.trim()
        if (!trimmed) return

        // 取消上一次搜索
        if (cancelCurrentSearch) {
            cancelCurrentSearch()
            cancelCurrentSearch = null
        }

        keyword.value = trimmed
        results.value = []
        searchLoading.value = true
        searched.value = true
        searchError.value = null
        cfChallengeActive.value = false

        try {
            const unlisteners: UnlistenFn[] = []

            // 监听单个结果事件
            const unResult = await listen<BackendSearchResult>('search-result', (event) => {
                results.value = sortResourceResults([...results.value, toResourceItem(event.payload)])
            })
            unlisteners.push(unResult)

            // 监听搜索完成事件
            const unDone = await listen('search-done', () => {
                // 累计更新数据源丰富度得分
                accumulateSourceScores(results.value)
                searchLoading.value = false
                cfChallengeActive.value = false
                cancelCurrentSearch = null
                cleanup()
            })
            unlisteners.push(unDone)

            const unCf = await listen<CfStatePayload>('resource-scrape-cf-state', (event) => {
                const payload = event.payload
                if (!payload) return

                cfChallengeActive.value = Boolean(payload.active)
                const siteLabel = payload.siteId ? `（${payload.siteId}）` : ''

                if (payload.status === 'active') {
                    toast.info(`触发 Cloudflare 验证${siteLabel}，请在弹出的 WebView 中完成验证`)
                    return
                }

                if (payload.status === 'passed') {
                    toast.success(`Cloudflare 验证已通过${siteLabel}，继续刮削中`)
                    return
                }

                if (payload.status === 'timeout') {
                    toast.warning(`Cloudflare 验证超时${siteLabel}，该数据源已跳过`)
                    return
                }

                if (payload.status === 'failed') {
                    toast.warning(`Cloudflare 验证失败${siteLabel}，该数据源已跳过`)
                }
            })
            unlisteners.push(unCf)

            // 清理函数
            const cleanup = () => {
                cfChallengeActive.value = false
                unlisteners.forEach((fn) => fn())
            }

            cancelCurrentSearch = cleanup

            // 调用后端搜索命令（rs_ 前缀）
            invoke('rs_search_resource', { code: trimmed, source: source || null }).catch((err) => {
                searchError.value = String(err)
                searchLoading.value = false
                cfChallengeActive.value = false
                cancelCurrentSearch = null
                cleanup()
            })
        } catch (e) {
            searchError.value = (e as Error).message
            searchLoading.value = false
            cfChallengeActive.value = false
        }
    }

    /** 重置所有搜索状态 */
    function reset() {
        if (cancelCurrentSearch) {
            cancelCurrentSearch()
            cancelCurrentSearch = null
        }
        keyword.value = ''
        results.value = []
        searchLoading.value = false
        searched.value = false
        searchError.value = null
        cfChallengeActive.value = false
    }

    /** 取消当前搜索：通知后端取消 + 关闭 WebView + 清理前端状态 */
    async function cancelSearch() {
        try {
            await invoke('rs_cancel_search')
        } catch (e) {
            console.error('取消搜索失败:', e)
        }
        if (cancelCurrentSearch) {
            cancelCurrentSearch()
            cancelCurrentSearch = null
        }
        searchLoading.value = false
        cfChallengeActive.value = false
    }

    // ============ 刮削保存操作 ============

    /** 从搜索结果触发刮削保存 */
    async function scrapeSave(videoId: string, metadata: ResourceItem) {
        try {
            await invoke('rs_scrape_save', { videoId, metadata })
            toast.success('刮削保存成功', {
                description: `视频 ${videoId} 的元数据已保存`
            })
        } catch (e) {
            console.error('Failed to scrape save:', e)
            toast.error('刮削保存失败', {
                description: (e as Error).message
            })
            throw e
        }
    }

    // ============ 刮削任务操作 ============

    async function fetchTasks() {
        console.log('[ResourceScrapeStore] fetchTasks() called')
        loading.value = true
        error.value = null

        try {
            const fetched = await invoke<ScrapeTask[]>('rs_get_scrape_tasks')
            console.log('[ResourceScrapeStore] Fetched tasks from backend:', fetched.length)

            const existingById = new Map(tasks.value.map(t => [t.id, t]))
            tasks.value = fetched.map(ft => {
                const existing = existingById.get(ft.id)
                if (!existing) return ft

                let status = ft.status
                if (
                    (existing.status === ScrapeStatus.Completed ||
                        existing.status === ScrapeStatus.PartialCompleted ||
                        existing.status === ScrapeStatus.Failed) &&
                    (ft.status === ScrapeStatus.Running || ft.status === ScrapeStatus.Waiting)
                ) {
                    console.log('[ResourceScrapeStore] Preserving terminal status for task:', ft.id, 'existing:', existing.status, 'fetched:', ft.status)
                    status = existing.status
                }

                let progress = ft.progress
                if (existing.progress > progress) {
                    console.log('[ResourceScrapeStore] Preserving higher progress for task:', ft.id, 'existing:', existing.progress, 'fetched:', ft.progress)
                    progress = existing.progress
                }

                const merged: ScrapeTask = {
                    ...ft,
                    status,
                    progress,
                    startedAt: ft.startedAt ?? existing.startedAt,
                    completedAt: ft.completedAt ?? existing.completedAt,
                }

                // 完成状态判断逻辑
                if (merged.progress >= 5) {
                    if (merged.status !== ScrapeStatus.Completed && merged.status !== ScrapeStatus.PartialCompleted) {
                        console.log('[ResourceScrapeStore] Auto-correcting status to Completed for task:', merged.id)
                        merged.status = ScrapeStatus.Completed
                    }
                } else if (merged.status === ScrapeStatus.Completed && merged.progress < 5) {
                    console.log('[ResourceScrapeStore] Auto-correcting progress to 5 for task:', merged.id)
                    merged.progress = 5
                }

                return merged
            })

            console.log('[ResourceScrapeStore] Tasks updated, total:', tasks.value.length)
        } catch (e) {
            error.value = (e as Error).message
            console.error('[ResourceScrapeStore] Failed to fetch scrape tasks:', e)
        } finally {
            loading.value = false
        }
    }

    async function createTask(path: string): Promise<'created' | 'updated' | 'duplicate'> {
        try {
            const count = await invoke<number>('rs_create_filtered_scrape_tasks', { path })
            await fetchTasks()

            if (count > 0) {
                toast.success('新建任务成功', {
                    description: `已添加目录 "${path}"，共创建 ${count} 个视频刮削任务（已过滤已刮削视频）。`
                })
                return 'created'
            } else {
                toast.info('未创建新任务', {
                    description: `目录 "${path}" 中没有发现需要刮削的新视频文件。`
                })
                return 'duplicate'
            }
        } catch (e) {
            console.error('Failed to create scrape task:', e)
            toast.error('创建任务失败', {
                description: (e as Error).message
            })
            throw e
        }
    }

    async function createCoverCaptureTasks(path: string): Promise<number> {
        try {
            return await invoke<number>('rs_create_cover_capture_tasks', { path })
        } catch (e) {
            console.error('Failed to create cover capture tasks:', e)
            throw e
        }
    }

    async function startTask(path: string) {
        try {
            const taskId = await invoke<string>('rs_start_task_queue')

            const normalizePath = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
            const targetPath = normalizePath(path)

            const existingIndex = tasks.value.findIndex(t => normalizePath(t.path) === targetPath && t.status === ScrapeStatus.Waiting)

            const newTask: ScrapeTask = {
                id: taskId,
                path,
                progress: 0,
                status: ScrapeStatus.Waiting,
                startedAt: undefined,
            }

            if (existingIndex !== -1) {
                tasks.value.splice(existingIndex, 1, newTask)
            } else {
                tasks.value.push(newTask)
            }
        } catch (e) {
            console.error('Failed to start scrape task:', e)
            toast.error('启动任务失败', {
                description: (e as Error).message
            })
            throw e
        }
    }

    async function stopTask(taskId: string) {
        try {
            await invoke('rs_stop_scrape_task', { taskId })
            const task = tasks.value.find(t => t.id === taskId)
            if (task) {
                task.status = 'partial' as ScrapeStatus
                task.completedAt = new Date().toISOString()
                toast.info('任务已停止', {
                    description: `目录 "${task.path}" 的刮削任务已停止。`
                })
            }
        } catch (e) {
            console.error('Failed to stop scrape task:', e)
            toast.error('停止任务失败', {
                description: (e as Error).message
            })
        }
    }

    async function removeTask(taskId: string) {
        try {
            await invoke('rs_delete_scrape_task', { taskId })

            tasks.value = tasks.value.filter(t => t.id !== taskId)
        } catch (e) {
            console.error('Failed to delete scrape task:', e)
            throw e
        }
    }

    async function resetTask(taskId: string) {
        try {
            await invoke('rs_reset_scrape_task', { taskId })
            const task = tasks.value.find(t => t.id === taskId)
            if (task) {
                task.status = ScrapeStatus.Waiting
                task.progress = 0
                task.startedAt = undefined
                task.completedAt = undefined
            }
        } catch (e) {
            console.error('Failed to reset scrape task:', e)
            toast.error('重置任务失败', {
                description: (e as Error).message
            })
        }
    }

    // ============ 任务进度与日志 ============

    function updateTaskProgress(taskId: string, data: Partial<ScrapeTask>) {
        const task = tasks.value.find(t => t.id === taskId)
        if (task) {
            console.log('[ResourceScrapeStore] Updating task progress:', { taskId, currentProgress: task.progress, newData: data })

            const incomingProgress = typeof data.progress === 'number' ? data.progress : undefined
            if (incomingProgress !== undefined && incomingProgress < task.progress) {
                console.log('[ResourceScrapeStore] Ignoring progress downgrade:', { current: task.progress, incoming: incomingProgress })
                delete (data as Partial<ScrapeTask>).progress
            }

            const incomingStatus = data.status
            const isTerminal = task.status === ScrapeStatus.Completed || task.status === ScrapeStatus.PartialCompleted || task.status === ScrapeStatus.Failed
            if (isTerminal && (incomingStatus === ScrapeStatus.Running || incomingStatus === ScrapeStatus.Waiting)) {
                console.log('[ResourceScrapeStore] Ignoring status change from terminal state:', { current: task.status, incoming: incomingStatus })
                delete (data as Partial<ScrapeTask>).status
            }

            Object.assign(task, data)

            // 完成状态同步
            if (task.progress >= 5) {
                if (task.status !== ScrapeStatus.Completed && task.status !== ScrapeStatus.PartialCompleted) {
                    console.log('[ResourceScrapeStore] Auto-correcting status to Completed based on progress')
                    task.status = ScrapeStatus.Completed
                }
            } else if (task.status === ScrapeStatus.Completed && task.progress < 5) {
                console.log('[ResourceScrapeStore] Auto-correcting progress to 5 based on Completed status')
                task.progress = 5
            }

            console.log('[ResourceScrapeStore] Task updated:', { taskId, status: task.status, progress: task.progress })
        } else {
            console.warn('[ResourceScrapeStore] Task not found for progress update:', taskId)
        }
    }

    function addLog(entry: ScrapeLogEntry) {
        logs.value.unshift(entry)
        if (logs.value.length > 1000) {
            logs.value = logs.value.slice(0, 1000)
        }
    }

    function clearLogs() {
        logs.value = []
    }

    async function batchDelete(taskIds: string[]) {
        if (taskIds.length === 0) {
            return 0
        }

        for (const taskId of taskIds) {
            await removeTask(taskId)
        }

        return taskIds.length
    }

    // 删除所有已完成的任务
    async function deleteCompletedTasks() {
        try {
            const count = await invoke<number>('rs_delete_completed_scrape_tasks')
            await fetchTasks()

            if (count > 0) {
                toast.success('删除成功', {
                    description: `已删除 ${count} 个已完成的任务`
                })
            } else {
                toast.info('没有已完成的任务')
            }
        } catch (e) {
            console.error('Failed to delete completed tasks:', e)
            toast.error('删除失败', {
                description: (e as Error).message
            })
        }
    }

    async function deleteFailedTasks() {
        try {
            const count = await invoke<number>('rs_delete_failed_scrape_tasks')
            await fetchTasks()

            if (count > 0) {
                toast.success('删除成功', {
                    description: `已删除 ${count} 个失败的任务`
                })
            } else {
                toast.info('没有失败的任务')
            }
        } catch (e) {
            console.error('Failed to delete failed tasks:', e)
            toast.error('删除失败', {
                description: (e as Error).message
            })
        }
    }

    async function deleteAllTasks() {
        try {
            const count = await invoke<number>('rs_delete_all_scrape_tasks')
            tasks.value = []

            if (count > 0) {
                toast.success('删除成功', {
                    description: `已删除 ${count} 个任务`
                })
            } else {
                toast.info('没有任务可删除')
            }
        } catch (e) {
            console.error('Failed to delete all tasks:', e)
            toast.error('删除失败', {
                description: (e as Error).message
            })
        }
    }

    // ============ 批量操作 ============

    // 开始所有等待中的任务（使用任务队列管理器）
    async function startAll() {
        console.log('[ResourceScrapeStore] startAll() called')

        if (isProcessingQueue.value) {
            console.warn('[ResourceScrapeStore] Queue already processing')
            toast.warning('任务队列正在运行中')
            return
        }

        console.log('[ResourceScrapeStore] Fetching latest tasks before starting queue')
        await fetchTasks()

        const waitingTasks = tasks.value.filter(t => t.status === ScrapeStatus.Waiting)
        console.log('[ResourceScrapeStore] Found waiting tasks:', waitingTasks.length)

        if (waitingTasks.length === 0) {
            toast.info('没有等待中的任务')
            return
        }

        if (!rateLimiter.canScrape()) {
            const resetTime = rateLimiter.getResetTime()
            toast.error('已达到每小时刮削限制', {
                description: `已达到每小时刮削限制（50次），请在 ${resetTime} 分钟后再试`
            })
            return
        }

        isProcessingQueue.value = true
        console.log('[ResourceScrapeStore] Set isProcessingQueue = true')

        try {
            toast.info('开始批量刮削', {
                description: `共 ${waitingTasks.length} 个任务，将按顺序依次处理`
            })

            delayController.recordScrape()
            rateLimiter.recordScrape()

            addLog({
                id: `${Date.now()}-${Math.random()}`,
                timestamp: new Date().toISOString(),
                level: 'info',
                message: `已启动刮削任务`,
                taskId: ''
            })

            console.log('[ResourceScrapeStore] Calling rs_start_task_queue()')
            await invoke('rs_start_task_queue')
            console.log('[ResourceScrapeStore] rs_start_task_queue() completed successfully')

            toast.success('任务已启动', {
                description: '正在处理队列中的下一个任务'
            })
        } catch (e) {
            console.error('[ResourceScrapeStore] Failed to start task queue:', e)
            toast.error('启动任务队列失败', {
                description: (e as Error).message
            })
            isProcessingQueue.value = false
        }
    }

    // 停止所有运行中的任务（急停）
    async function stopAll() {
        try {
            await invoke('rs_stop_task_queue')
            isProcessingQueue.value = false

            const runningTasksList = runningTasks.value
            for (const task of runningTasksList) {
                task.status = 'partial' as ScrapeStatus
                task.completedAt = new Date().toISOString()
            }

            toast.success('已停止所有任务', {
                description: runningTasksList.length > 0 ? `已停止 ${runningTasksList.length} 个运行中的任务` : '任务队列已停止'
            })
        } catch (e) {
            console.error('Failed to stop all tasks:', e)
            toast.error('停止任务失败', {
                description: (e as Error).message
            })
            isProcessingQueue.value = false
        }
    }

    return {
        // 搜索状态
        keyword,
        results,
        searchLoading,
        searched,
        searchError,
        cfChallengeActive,
        // 刮削任务状态
        tasks,
        logs,
        loading,
        error,
        isProcessingQueue,
        // Getters
        runningTasks,
        completedTasks,
        stats,
        recentLogs,
        // 搜索操作
        search,
        reset,
        cancelSearch,
        // 刮削保存
        scrapeSave,
        // 任务操作
        fetchTasks,
        createTask,
        createCoverCaptureTasks,
        startTask,
        stopTask,
        updateTaskProgress,
        addLog,
        clearLogs,
        removeTask,
        resetTask,
        startAll,
        stopAll,
        batchDelete,
        deleteCompletedTasks,
        deleteFailedTasks,
        deleteAllTasks,
        // 控制器信息（调试用）
        getRateLimiterInfo: () => ({
            canScrape: rateLimiter.canScrape(),
            remainingQuota: rateLimiter.getRemainingQuota(),
            resetTime: rateLimiter.getResetTime()
        }),
        getDelayInfo: () => ({
            scrapeCount: delayController.getScrapeCount(),
            nextDelay: delayController.getDelay()
        })
    }
})
