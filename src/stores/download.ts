import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { DownloadTask, DownloadProgress, BatchAction } from '@/types'
import { TaskStatus } from '@/types'
import { useVideoStore } from './video'
import { useSettingsStore } from './settings'
import {
    getDownloadTasks,
    addDownloadTask,
    stopDownloadTask,
    retryDownloadTask,
    deleteDownloadTask,
    renameDownloadTask,
    changeDownloadSavePath,
    batchStopTasks,
    batchRetryTasks,
    batchDeleteTasks,
    syncCompletedDownloadToLibrary,
    getDirectories,
} from '@/lib/tauri'

export const useDownloadStore = defineStore('download', () => {
    // ============ State ============
    const tasks = ref<DownloadTask[]>([])
    const loading = ref(false)
    const error = ref<string | null>(null)
    const selectedIds = ref<string[]>([])

    // ============ Getters ============
    const downloadingTasks = computed(() =>
        tasks.value.filter(t => t.status === 'downloading')
    )

    const completedTasks = computed(() =>
        tasks.value.filter(t => t.status === 'completed')
    )

    const failedTasks = computed(() =>
        tasks.value.filter(t => t.status === 'failed')
    )

    const totalProgress = computed(() => {
        const downloading = downloadingTasks.value
        if (downloading.length === 0) return 0

        const totalDownloaded = downloading.reduce((sum, t) => sum + t.downloaded, 0)
        const totalSize = downloading.reduce((sum, t) => sum + t.total, 0)

        return totalSize > 0 ? (totalDownloaded / totalSize) * 100 : 0
    })

    const totalSpeed = computed(() =>
        downloadingTasks.value.reduce((sum, t) => sum + t.speed, 0)
    )

    const selectedTasks = computed(() =>
        tasks.value.filter(t => selectedIds.value.includes(t.id))
    )

    // ============ Actions ============

    /** 初始化：注册全局下载进度事件监听（应在 App.vue 中调用一次） */
    let _unlisten: UnlistenFn | null = null
    async function init() {
        if (_unlisten) return // 避免重复注册
        const isTauri = typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__)
        if (!isTauri) return
        _unlisten = await listen<DownloadProgress>('download-progress', (event) => {
            updateProgress(event.payload)
        })
    }

    async function fetchTasks() {
        loading.value = true
        error.value = null
        try {
            const fetchedTasks = await getDownloadTasks()
            tasks.value = fetchedTasks
            selectedIds.value = selectedIds.value.filter(id =>
                fetchedTasks.some(task => task.id === id)
            )
        } catch (e) {
            console.error('Failed to fetch download tasks:', e)
            error.value = String(e)
            tasks.value = []
            selectedIds.value = []
        } finally {
            loading.value = false
        }
    }

    async function addTask(url: string, savePath: string, filename?: string, sourceSite?: string) {
        // 前端预检查：是否存在相同 URL 的任务（不管任何状态）
        const existingTask = tasks.value.find(t => t.url === url)
        if (existingTask) {
            const statusText: Record<string, string> = {
                'queued': '排队中',
                'preparing': '准备中',
                'downloading': '下载中',
                'merging': '合并中',
                'paused': '已暂停',
                'retrying': '重试中',
                'completed': '已完成',
                'failed': '失败',
                'cancelled': '已取消'
            }
            throw `该下载链接已存在（状态：${statusText[existingTask.status] || existingTask.status}），请勿重复添加`
        }

        try {
            const taskId = await addDownloadTask(url, savePath, filename, sourceSite)
            await fetchTasks()
            return taskId
        } catch (e) {
            console.error('Failed to add download task:', e)
            throw e
        }
    }

    // 同一会话内已计过分的任务，避免完成事件重复触发（status 可能 6→4→6）导致重复加分
    const scoredDownloadIds = new Set<string>()

    /** 下载成功后，给来源下载源的成功次数 +1（用于资源链接下拉排序/下载源管理评分） */
    async function bumpDownloadSourceSuccess(task: DownloadTask) {
        const sourceId = task.sourceSite?.trim()
        if (!sourceId || scoredDownloadIds.has(task.id)) return
        scoredDownloadIds.add(task.id)

        const settingsStore = useSettingsStore()
        const sources = settingsStore.settings.download.sources
        if (!sources?.length) return
        const idx = sources.findIndex(s => s.id === sourceId)
        if (idx === -1) return

        const updated = sources.map((s, i) =>
            i === idx ? { ...s, successCount: (s.successCount ?? 0) + 1 } : s
        )
        await settingsStore.updateSettings({
            download: { ...settingsStore.settings.download, sources: updated },
        })
    }

    function updateProgress(progress: DownloadProgress) {
        const task = tasks.value.find(t => t.id === progress.taskId)
        if (task) {
            const oldStatus = task.status
            task.progress = progress.progress
            task.speed = progress.speed
            task.downloaded = progress.downloaded
            task.total = progress.total
            // 将数字状态转换为字符串状态
            const newStatus = convertStatusToString(progress.status) as TaskStatus
            task.status = newStatus

            // 检测任务刚完成：状态从非 completed 变为 completed
            if (newStatus === 'completed' && oldStatus !== 'completed') {
                onTaskCompleted(task)
            }
        }
    }

    // 下载任务完成后，检查保存目录是否在目录管理中，如果在则自动刷新
    async function onTaskCompleted(task: DownloadTask) {
        // 下载成功 → 给来源下载源加分（只加一次）
        bumpDownloadSourceSuccess(task).catch(e => console.error('[下载完成] 下载源加分失败:', e))
        try {
            const dirs = await getDirectories()
            const savePath = normalizePath(task.savePath)
            const videoStore = useVideoStore()

            // 检查下载目录是否在已管理的目录列表中（或是其子目录）
            const matchedDir = dirs.find(d => {
                const dirPath = normalizePath(d.path)
                return savePath === dirPath || savePath.startsWith(dirPath + '/')
            })

            if (matchedDir) {
                console.log(`[下载完成] 保存目录 "${task.savePath}" 在目录管理中，自动刷新: "${matchedDir.path}"`)
                await syncCompletedDownloadToLibrary(task.id)
                await videoStore.refreshLibrary(true)
            }
        } catch (e) {
            console.error('[下载完成] 自动刷新目录失败:', e)
        }
    }

    // 统一路径分隔符
    function normalizePath(p: string): string {
        return p.replace(/\\/g, '/').replace(/\/+$/, '')
    }

    // 将后端数字状态转换为前端字符串状态
    function convertStatusToString(status: number | string): string {
        if (typeof status === 'string') return status

        const statusMap: Record<number, string> = {
            0: 'queued',      // 排队中
            1: 'preparing',   // 准备中
            2: 'downloading', // 下载中
            3: 'merging',     // 合并中
            4: 'scraping',    // 刮削中
            5: 'paused',      // 已暂停
            6: 'completed',   // 已完成
            7: 'failed',      // 失败
            8: 'retrying',    // 重试中
            9: 'cancelled',   // 已取消
        }

        return statusMap[status] || 'queued'
    }

    async function stopTask(taskId: string) {
        try {
            await stopDownloadTask(taskId)
            const task = tasks.value.find(t => t.id === taskId)
            if (task) {
                task.status = 'cancelled' as TaskStatus
            }
        } catch (e) {
            console.error('Failed to stop task:', e)
        }
    }

    async function retryTask(taskId: string) {
        try {
            await retryDownloadTask(taskId)
            // 重新拉取以获取正确的状态，因为可能立即开始下载
            await fetchTasks()
        } catch (e) {
            console.error('Failed to retry task:', e)
        }
    }

    async function deleteTask(taskId: string) {
        try {
            await deleteDownloadTask(taskId)
            tasks.value = tasks.value.filter(t => t.id !== taskId)
            deselectTask(taskId)
        } catch (e) {
            console.error('Failed to delete task:', e)
        }
    }

    async function deleteTasks(taskIds: string[]) {
        if (taskIds.length === 0) {
            return { failed: [] as string[], deletedCount: 0 }
        }

        try {
            const failed = await batchDeleteTasks(taskIds)
            await fetchTasks()

            return {
                failed,
                deletedCount: taskIds.length - failed.length,
            }
        } catch (e) {
            console.error('Batch delete tasks failed:', e)
            throw e
        }
    }

    async function renameTask(taskId: string, newFilename: string) {
        try {
            await renameDownloadTask(taskId, newFilename)
            const task = tasks.value.find(t => t.id === taskId)
            if (task) {
                task.filename = newFilename
            }
        } catch (e) {
            console.error('Failed to rename task:', e)
            throw e
        }
    }

    async function changeSavePath(taskId: string, newSavePath: string) {
        try {
            await changeDownloadSavePath(taskId, newSavePath)
            const task = tasks.value.find(t => t.id === taskId)
            if (task) {
                task.savePath = newSavePath
            }
        } catch (e) {
            console.error('Failed to change save path:', e)
            throw e
        }
    }

    async function batchAction(action: BatchAction) {
        const ids = [...selectedIds.value]

        if (ids.length === 0) {
            return
        }

        let failed: string[] = []

        try {
            switch (action) {
                case 'stop':
                    failed = await batchStopTasks(ids)
                    break
                case 'retry':
                    failed = await batchRetryTasks(ids)
                    break
                case 'delete':
                    failed = await batchDeleteTasks(ids)
                    break
            }

            if (failed.length > 0) {
                console.error(`Failed to ${action} ${failed.length} tasks:`, failed)
            }

            // 刷新任务列表
            await fetchTasks()
        } catch (e) {
            console.error(`Batch ${action} failed:`, e)
            throw e
        }
    }

    async function batchStopAll(taskIds: string[]) {
        try {
            const failed = await batchStopTasks(taskIds)

            if (failed.length > 0) {
                console.error(`Failed to stop ${failed.length} tasks:`, failed)
            }

            // 刷新任务列表
            await fetchTasks()

            return failed
        } catch (e) {
            console.error('Batch stop all failed:', e)
            throw e
        }
    }

    async function batchRetryAll(taskIds: string[]) {
        try {
            const failed = await batchRetryTasks(taskIds)

            if (failed.length > 0) {
                console.error(`Failed to retry ${failed.length} tasks:`, failed)
            }

            // 刷新任务列表
            await fetchTasks()

            return failed
        } catch (e) {
            console.error('Batch retry all failed:', e)
            throw e
        }
    }

    function selectTask(id: string) {
        if (!selectedIds.value.includes(id)) {
            selectedIds.value.push(id)
        }
    }

    function deselectTask(id: string) {
        selectedIds.value = selectedIds.value.filter(i => i !== id)
    }

    function toggleSelect(id: string) {
        if (selectedIds.value.includes(id)) {
            deselectTask(id)
        } else {
            selectTask(id)
        }
    }

    function selectAll() {
        selectedIds.value = tasks.value.map(t => t.id)
    }

    function deselectAll() {
        selectedIds.value = []
    }

    return {
        // State
        tasks,
        loading,
        error,
        selectedIds,
        // Getters
        downloadingTasks,
        completedTasks,
        failedTasks,
        totalProgress,
        totalSpeed,
        selectedTasks,
        // Actions
        init,
        fetchTasks,
        addTask,
        updateProgress,
        stopTask,
        retryTask,
        deleteTask,
        deleteTasks,
        renameTask,
        changeSavePath,
        batchAction,
        batchStopAll,
        batchRetryAll,
        selectTask,
        deselectTask,
        toggleSelect,
        selectAll,
        deselectAll,
    }
})
