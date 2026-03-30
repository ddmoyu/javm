<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { toImageSrc } from '@/utils/image'
import { openImagePreview, isFancyboxOpen } from '@/composables/useImagePreview'
import { usePreviewGallery } from '@/composables/usePreviewGallery'
import {
    Dialog,
    DialogContent,
    DialogTitle,
    DialogDescription,
} from '@/components/ui/dialog'
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
    Play,
    FolderOpen,
    RefreshCw,
    Star,
    Save,
    Image as ImageIcon,
    Loader2,
    Sparkles,
    Camera,
    MoreHorizontal,
    Trash2,
    Download,
    ShieldAlert
} from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import type { Video } from '@/types'
import { openInExplorer, openWithPlayer, updateVideo, openVideoPlayerWindow } from '@/lib/tauri'
import { useVideoStore } from '@/stores'
import { useResourceScrapeStore } from '@/stores/resourceScrape'
import { useSettingsStore } from '@/stores/settings'
import { invoke } from '@tauri-apps/api/core'
import CaptureCoverDialog from './CaptureCoverDialog.vue'
import DeleteVideoDialog from './DeleteVideoDialog.vue'

interface Props {
    open: boolean
    video: Video | null
}

interface VideoPreviewSource {
    src: string
    localPath?: string | null
    remoteUrl?: string | null
}

const props = defineProps<Props>()
const emit = defineEmits<{
    (e: 'update:open', value: boolean): void
    (e: 'video-updated', value: Video): void
}>()

const videoStore = useVideoStore()
const scrapeStore = useResourceScrapeStore()
const settingsStore = useSettingsStore()

// Local state for editing
const formData = ref<Partial<Video>>({})
const isDirty = ref(false)
const isSaving = ref(false)
const isScraping = ref(false)
const hasScrapedData = ref(false) // 标记是否刮削了新数据
const aiRecognizing = ref(false) // AI识别番号状态
const captureCoverDialogOpen = ref(false) // 截取封面对话框状态
const captureThumbsDialogOpen = ref(false) // 截取预览图对话框状态
const showDeleteConfirm = ref(false) // 删除确认对话框状态
const coverCacheBuster = ref(0) // 封面缓存刷新标记
const resolvedPreviewSources = ref<VideoPreviewSource[]>([])
const pendingPreviewThumbs = ref<string[]>([])
const pendingRemotePreviewThumbs = ref<string[]>([])
const pendingPosterSource = ref<string | undefined>(undefined)
const pendingRemoteCoverUrl = ref('')

const INVALID_TITLE_CHARS = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*'])
const RESERVED_TITLE_PATTERN = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

function resetPendingPreviewState() {
    pendingPreviewThumbs.value = []
    pendingRemotePreviewThumbs.value = []
}

function resetPendingCoverState() {
    pendingPosterSource.value = undefined
    pendingRemoteCoverUrl.value = ''
}

function resetScrapePendingState(options: { previews?: boolean } = {}) {
    const { previews = true } = options
    resetPendingCoverState()
    if (previews) {
        resetPendingPreviewState()
    }
}

const isOpen = computed({
    get: () => props.open,
    set: (val) => emit('update:open', val),
})

// 始终使用最新的视频路径（截取预览图后视频可能被迁移到同名目录）
const currentVideoPath = computed(() => formData.value.videoPath || props.video?.videoPath || '')

const normalizedTitle = computed(() => (formData.value.title || '').trim())

const invalidTitleCharacters = computed(() => {
    const chars = new Set<string>()
    for (const ch of formData.value.title || '') {
        if (INVALID_TITLE_CHARS.has(ch) || ch <= '\u001f') {
            chars.add(ch)
        }
    }
    return [...chars]
})

const titleValidationMessage = computed(() => {
    const rawTitle = formData.value.title || ''
    const trimmedTitle = normalizedTitle.value

    if (!trimmedTitle) {
        return '标题不能为空'
    }

    if (invalidTitleCharacters.value.length > 0) {
        return `标题不能包含以下字符: ${invalidTitleCharacters.value.join(' ')}`
    }

    if (/[. ]$/.test(rawTitle)) {
        return '标题不能以空格或句点结尾'
    }

    if (RESERVED_TITLE_PATTERN.test(trimmedTitle)) {
        return '标题不能使用 Windows 保留名称'
    }

    return ''
})

const isTitleValid = computed(() => !titleValidationMessage.value)

// Fancybox 打开时阻止外部点击关闭详情页
const onInteractOutside = (e: Event) => {
    if (isFancyboxOpen()) e.preventDefault()
}

const imageSrc = computed(() => {
    // 引用 cacheBuster 以确保重新计算
    const _bust = coverCacheBuster.value

    // 优先使用当前会话中的待保存封面
    if (pendingPosterSource.value) {
        const src = toImageSrc(pendingPosterSource.value) ?? ''
        return src ? `${src}${src.includes('?') ? '&' : '?'}t=${_bust}` : ''
    }

    const persistedCoverPath = formData.value.thumb || props.video?.thumb || formData.value.poster || props.video?.poster
    if (persistedCoverPath) {
        const path = persistedCoverPath
        const src = toImageSrc(path) ?? ''
        return src ? `${src}${src.includes('?') ? '&' : '?'}t=${_bust}` : ''
    }

    return ''
})

// Initialize form data when video changes
watch(() => props.video, (newVal) => {
    if (newVal) {
        formData.value = { ...newVal }
        isDirty.value = false
        hasScrapedData.value = false // 重置刮削状态
        resetScrapePendingState()
        void loadResolvedPreviewSources(newVal.videoPath)

        // 如果有标题但没有番号，自动使用正则识别
        if ((newVal.originalTitle || newVal.title) && !newVal.localId) {
            autoRecognizeLocalId()
        }
    }
}, { immediate: true })

// Reset state when dialog closes
watch(() => props.open, (isOpen) => {
    if (!isOpen) {
        hasScrapedData.value = false // 关闭时重置刮削状态
        resetScrapePendingState()
    } else if (props.video?.videoPath) {
        void loadResolvedPreviewSources(props.video.videoPath)
    }
})

const thumbSources = computed<VideoPreviewSource[]>(() => {
    if (hasScrapedData.value && pendingPreviewThumbs.value.length > 0) {
        return pendingPreviewThumbs.value.map((src) => {
            const isRemote = /^https?:\/\//i.test(src)
            return {
                src,
                localPath: isRemote ? null : src,
                remoteUrl: isRemote ? src : null,
            }
        })
    }

    if (resolvedPreviewSources.value.length > 0) {
        return resolvedPreviewSources.value
    }

    return []
})

const { previewThumbs: previewImages, allImages, previewStartIndex } = usePreviewGallery<VideoPreviewSource>({
    getCoverImage: () => {
        if (!imageSrc.value) return null

        return {
            src: imageSrc.value,
            title: '封面',
            hasLocalVideo: !!currentVideoPath.value,
        }
    },
    getThumbs: () => thumbSources.value,
    createThumbImage: (item, idx) => {
        const src = toImageSrc(item.src)
        if (!src) return null

        return {
            src,
            title: `预览图 ${idx + 1}`,
            hasLocalVideo: !!item.localPath,
            data: {
                thumbIndex: idx,
                thumbPath: item.localPath ?? item.remoteUrl ?? item.src,
                localPath: item.localPath ?? null,
            },
        }
    },
})

async function loadResolvedPreviewSources(videoPath?: string) {
    if (!videoPath?.trim()) {
        resolvedPreviewSources.value = []
        return
    }

    try {
        resolvedPreviewSources.value = await invoke<VideoPreviewSource[]>('resolve_video_preview_images', {
            videoPath,
        })
    } catch (e) {
        console.error('加载预览图失败:', e)
        resolvedPreviewSources.value = []
    }
}

// 旧的 scrape-success-html 事件监听已移除，新架构通过 store 流式搜索

const actorsList = computed({
    get: () => formData.value.actors || '',
    set: (val) => {
        formData.value.actors = val
        isDirty.value = true
    }
})

// Helpers for array/tag handling
const tagsList = computed({
    get: () => formData.value.tags || '',
    set: (val) => {
        formData.value.tags = val
        isDirty.value = true
    }
})

const studioValue = computed({
    get: () => formData.value.studio || '',
    set: (val) => {
        formData.value.studio = val
        isDirty.value = true
    }
})

const durationFormatted = computed({
    get: () => {
        const d = formData.value.duration || 0;
        const h = Math.floor(d / 3600);
        const m = Math.floor((d % 3600) / 60);
        const s = Math.floor(d % 60);
        return [h, m, s].map(v => v.toString().padStart(2, '0')).join(':');
    },
    set: (val) => {
        const parts = val.split(':').map(part => parseInt(part, 10));
        let totalSeconds = 0;
        if (parts.length === 3 && !parts.some(isNaN)) {
            totalSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
        } else if (parts.length === 2 && !parts.some(isNaN)) {
            totalSeconds = parts[0] * 60 + parts[1];
        } else if (parts.length === 1 && !parts.some(isNaN)) {
            totalSeconds = parts[0];
        }

        if (!isNaN(totalSeconds)) {
            formData.value.duration = totalSeconds;
            isDirty.value = true;
        }
    }
})

const handlePlay = async () => {
    if (props.video) {
        try {
            const isSoftware = settingsStore.settings.general.playMethod === 'software'
            if (isSoftware) {
                await openVideoPlayerWindow(currentVideoPath.value, props.video.title || props.video.originalTitle || 'Unknown Video', false)
            } else {
                await openWithPlayer(currentVideoPath.value)
            }
        } catch (e) {
            console.error('Failed to play video:', e)
        }
        // isOpen.value = false // Keep dialog open
    }
}

const handleOpenDir = () => {
    if (props.video) {
        openInExplorer(currentVideoPath.value)
    }
}

const handleDeleteClick = () => {
    showDeleteConfirm.value = true
}

const handleDeleteSuccess = () => {
    // 关闭对话框
    isOpen.value = false
}


const handleScrape = async () => {
    if (!props.video) return

    // 使用表单中的番号，而不是数据库中的
    const localId = formData.value.localId?.trim()

    if (!localId) {
        toast.error('请先输入番号')
        return
    }

    isScraping.value = true

    try {
        // 使用设置中的默认刮削网站，只请求单个数据源
        const defaultSite = settingsStore.settings.scrape?.defaultSite || 'javbus'
        await scrapeStore.search(localId, defaultSite)

        // 等待搜索完成（监听 searchLoading 变为 false）
        await new Promise<void>((resolve) => {
            const stopWatch = watch(() => scrapeStore.searchLoading, (loading) => {
                if (!loading) {
                    stopWatch()
                    resolve()
                }
            }, { immediate: true })
        })

        if (scrapeStore.searchError) {
            toast.error('刮削失败: ' + scrapeStore.searchError)
            isScraping.value = false
            return
        }

        if (scrapeStore.results.length === 0) {
            toast.warning('未找到该番号的信息，请检查番号是否正确')
            isScraping.value = false
            return
        }

        // 自动选取第一个搜索结果填充表单
        const best = scrapeStore.results[0]

        formData.value = {
            ...formData.value,
            title: best.title || formData.value.title,
            localId: best.code || formData.value.localId,
            premiered: best.premiered || formData.value.premiered,
            duration: resolveScrapedDuration(formData.value.duration, best.duration),
            studio: best.studio || formData.value.studio,
            director: best.director || formData.value.director,
            rating: best.rating ?? formData.value.rating,
            actors: best.actors || formData.value.actors,
            tags: best.tags || formData.value.tags,
        }
        pendingPosterSource.value = best.coverUrl || formData.value.poster
        pendingRemoteCoverUrl.value = best.remoteCoverUrl || best.coverUrl || ''
        pendingPreviewThumbs.value = best.thumbs || []
        pendingRemotePreviewThumbs.value = best.remoteThumbs || best.thumbs || []

        hasScrapedData.value = true
        isDirty.value = true
        isScraping.value = false

        toast.success('刮削成功！请点击"保存修改"按钮保存数据')
    } catch (e) {
        console.error('刮削失败:', e)
        toast.error('刮削失败: ' + String(e))
        isScraping.value = false
    }
}

/** 将时长字符串（如 "120分钟"、"120 min"）转换为秒数 */
function parseDurationToSeconds(duration: string): number {
    const digits = duration.match(/\d+/)
    if (!digits) return 0
    return parseInt(digits[0], 10) * 60 // 分钟转秒
}

function resolveScrapedDuration(existingDuration?: number, scrapedDuration?: string): number | undefined {
    if ((existingDuration ?? 0) > 0) {
        return existingDuration
    }

    if (!scrapedDuration) {
        return existingDuration
    }

    const parsedDuration = parseDurationToSeconds(scrapedDuration)
    return parsedDuration > 0 ? parsedDuration : existingDuration
}

// handleScrapeResponse 已移除 — 新架构通过 store 流式搜索，不再需要旧的响应处理

const handleSave = async () => {
    if (!props.video) return

    if (!isTitleValid.value) {
        toast.error('保存失败', {
            description: titleValidationMessage.value,
        })
        return
    }

    isSaving.value = true
    try {
        // 如果有刮削的新数据（包含封面和截图），使用 save_scraped_data
        if (hasScrapedData.value) {
            // 使用 resourceScrape store 保存刮削数据
            // 构造与后端 SearchResult 对应的数据（store 会传给 rs_scrape_save）
            const metadata = {
                code: formData.value.localId || '',
                title: formData.value.title || '',
                actors: formData.value.actors || '',
                duration: formData.value.duration ? `${Math.floor(formData.value.duration / 60)}分钟` : '',
                studio: formData.value.studio || '',
                source: '',
                coverUrl: pendingRemoteCoverUrl.value,
                director: formData.value.director || '',
                tags: formData.value.tags || '',
                premiered: formData.value.premiered || '',
                rating: typeof formData.value.rating === 'number' ? formData.value.rating : undefined,
                thumbs: pendingPreviewThumbs.value,
                remoteThumbs: pendingRemotePreviewThumbs.value,
                originalTitle: formData.value.originalTitle,
                targetTitle: formData.value.title,
            }

            await scrapeStore.scrapeSave(props.video.id, metadata)
        }

        const updatePayload: Partial<Video> = {
            title: formData.value.title,
            localId: formData.value.localId,
            studio: formData.value.studio,
            director: formData.value.director,
            actors: formData.value.actors,
            rating: typeof formData.value.rating === 'string' ? parseFloat(formData.value.rating) : formData.value.rating,
            duration: typeof formData.value.duration === 'string' ? parseFloat(formData.value.duration) : formData.value.duration,
            premiered: formData.value.premiered,
            tags: formData.value.tags,
            resolution: formData.value.resolution,
        }

        const updatedVideoInfo = await updateVideo(props.video.id, updatePayload)

        // Update local store to reflect changes immediately
        const localVideoPatch: Partial<Video> = {
            ...formData.value,
            title: updatedVideoInfo.title,
            videoPath: updatedVideoInfo.videoPath,
            dirPath: updatedVideoInfo.dirPath ?? undefined,
            poster: updatedVideoInfo.poster ?? undefined,
            thumb: updatedVideoInfo.thumb ?? undefined,
            fanart: updatedVideoInfo.fanart ?? undefined,
        }
        formData.value = localVideoPatch
        videoStore.updateVideo(props.video.id, localVideoPatch)
        emit('video-updated', {
            ...props.video,
            ...localVideoPatch,
        } as Video)

        // 重新获取视频列表以确保状态同步
        await videoStore.fetchVideos()
        await loadResolvedPreviewSources(updatedVideoInfo.videoPath)
        resetScrapePendingState()

        isDirty.value = false
        hasScrapedData.value = false // 保存后重置刮削状态

        // Show success toast
        toast.success('保存成功', {
            description: '视频信息已更新'
        })
    } catch (e) {
        console.error('Failed to save video details:', e)

        // 解析错误信息
        let errorMessage = '未知错误'
        const errorStr = String(e)

        // 检查是否是 UNIQUE constraint 错误
        if (errorStr.includes('UNIQUE constraint failed: videos.local_id')) {
            errorMessage = `番号 ${formData.value.localId} 已存在`
        } else if (errorStr.includes('UNIQUE constraint')) {
            errorMessage = '数据重复，保存失败'
        } else if (errorStr.includes('Failed to update DB:')) {
            // 提取具体的数据库错误信息
            const match = errorStr.match(/Failed to update DB: (.+)/)
            if (match && match[1]) {
                errorMessage = match[1]
            }
        } else {
            errorMessage = errorStr
        }

        // Show error toast
        toast.error('保存失败', {
            description: errorMessage
        })
    } finally {
        isSaving.value = false
    }
}

const setRating = (r: number) => {
    formData.value.rating = r
    isDirty.value = true
}

// 使用 Fancybox 打开图片预览
const openImageViewer = (index: number) => {
    if (allImages.value.length === 0) return
    openImagePreview(allImages.value, index, {
        onDelete: async (_image, idx) => {
            // 判断是封面还是预览图
            const hasCover = !!imageSrc.value
            if (hasCover && idx === 0) {
                await deleteCover()
            } else {
                const thumbIdx = hasCover ? idx - 1 : idx
                await deleteThumbByIndex(thumbIdx)
            }
        },
    })
}

const openPreviewThumbViewer = (index: number) => {
    openImageViewer(previewStartIndex.value + index)
}

// AI识别番号（直接使用 AI，不使用正则）
const recognizeLocalId = async () => {
    const title = formData.value.originalTitle || formData.value.title

    if (!title?.trim()) {
        toast.error('没有可用的标题进行识别')
        return
    }

    aiRecognizing.value = true

    try {
        const result = await invoke<{ success: boolean; designation: string | null; method: string; message: string }>('recognize_designation_with_ai', {
            title: title.trim(),
            forceAi: true // 点击按钮时直接使用 AI
        })

        if (result.success && result.designation) {
            formData.value.localId = result.designation
            isDirty.value = true
            toast.success(`${result.message}: ${result.designation}`)
        } else {
            toast.error(result.message || '未能识别出番号')
        }
    } catch (e) {
        console.error('AI识别失败:', e)
        toast.error('AI识别失败: ' + String(e))
    } finally {
        aiRecognizing.value = false
    }
}

// 自动识别番号（使用正则，静默执行）
const autoRecognizeLocalId = async () => {
    const title = formData.value.originalTitle || formData.value.title

    if (!title?.trim()) {
        return
    }

    try {
        const result = await invoke<{ success: boolean; designation: string | null; method: string; message: string }>('recognize_designation_with_ai', {
            title: title.trim(),
            forceAi: false // 自动识别时使用正则
        })

        if (result.success && result.designation) {
            formData.value.localId = result.designation
            // 不设置 isDirty，因为这是自动识别
            console.log('自动识别番号成功:', result.designation)
        }
    } catch (e) {
        console.error('自动识别失败:', e)
        // 静默失败，不显示错误提示
    }
}

// 打开截取封面对话框
const openCaptureCoverDialog = () => {
    if (!props.video) return
    captureCoverDialogOpen.value = true
}

// 处理截取封面成功
const handleCaptureCoverSuccess = async (payload: { paths: string | string[]; videoPath: string }) => {
    // 确保是字符串类型
    const path = Array.isArray(payload.paths) ? payload.paths[0] : payload.paths

    // 如果视频被迁移到同名目录，更新表单中的路径
    if (payload.videoPath && payload.videoPath !== formData.value.videoPath) {
        formData.value.videoPath = payload.videoPath
        // 同步更新 store，确保 props.video 也能拿到最新路径
        if (props.video) {
            videoStore.updateVideo(props.video.id, { videoPath: payload.videoPath })
        }
    }

    // 更新表单数据
    formData.value.thumb = path
    formData.value.poster = path
    pendingPosterSource.value = path
    isDirty.value = true

    // 刷新缓存，强制重新加载封面图片（详情页 + 卡片）
    coverCacheBuster.value = Date.now()
    if (props.video) {
        videoStore.bumpCoverVersion(props.video.id)
    }

    // 重新获取视频列表以更新封面显示
    await videoStore.fetchVideos()
}

// 打开截取预览图对话框
const openCaptureThumbsDialog = () => {
    if (!props.video) return
    captureThumbsDialogOpen.value = true
}

// 处理截取预览图成功
const handleCaptureThumbsSuccess = async (payload: { paths: string | string[]; videoPath: string }) => {
    // 确保是数组类型
    const paths = Array.isArray(payload.paths) ? payload.paths : [payload.paths]

    // 如果视频被迁移到同名目录，更新表单中的路径
    if (payload.videoPath && payload.videoPath !== formData.value.videoPath) {
        formData.value.videoPath = payload.videoPath
        // 同步更新 store，确保 props.video 也能拿到最新路径
        if (props.video) {
            videoStore.updateVideo(props.video.id, { videoPath: payload.videoPath })
        }
    }

    isDirty.value = true
    pendingPreviewThumbs.value = hasScrapedData.value
        ? [...pendingPreviewThumbs.value, ...paths]
        : pendingPreviewThumbs.value

    // 重新获取视频列表以更新预览图显示
    await videoStore.fetchVideos()
    // 使用后端返回的最新路径加载预览图
    const resolvedPath = payload.videoPath || currentVideoPath.value
    if (resolvedPath) {
        await loadResolvedPreviewSources(resolvedPath)
    }
}

// 删除封面
const deleteCover = async () => {
    if (!props.video) return

    try {
        await invoke('delete_cover', {
            videoId: props.video.id,
        })

        // 更新表单数据
        formData.value.thumb = undefined
        formData.value.poster = undefined
        resetPendingCoverState()

        // 刷新缓存
        coverCacheBuster.value = Date.now()
        if (props.video) {
            videoStore.bumpCoverVersion(props.video.id)
        }

        // 重新获取视频列表以更新封面显示
        await videoStore.fetchVideos()

        toast.success('封面已删除')
    } catch (e) {
        console.error('删除封面失败:', e)
        toast.error('删除封面失败: ' + String(e))
    }
}

// 按索引删除单个预览图（由 Fancybox 回调调用）
const deleteThumbByIndex = async (thumbIdx: number) => {
    if (!props.video) return
    if (thumbIdx < 0 || thumbIdx >= thumbSources.value.length) return

    const thumbItem = thumbSources.value[thumbIdx]
    if (!thumbItem.localPath) {
        toast.info('远程预览图会在后台同步到 extrafanart，暂不支持直接删除')
        return
    }

    const thumbPath = thumbItem.localPath

    try {
        await invoke('delete_thumb', {
            videoId: props.video.id,
            thumbPath,
        })

        // 重新获取视频列表
        await videoStore.fetchVideos()
        await loadResolvedPreviewSources(currentVideoPath.value)

        toast.success('预览图已删除')
    } catch (e) {
        console.error('删除预览图失败:', e)
        toast.error('删除预览图失败: ' + String(e))
    }
}


// 清空预览图
const clearThumbs = async () => {
    if (!props.video) return

    try {
        await invoke('clear_thumbs', {
            videoId: props.video.id,
            videoPath: currentVideoPath.value,
        })
        resetPendingPreviewState()

        // 重新获取视频列表
        await videoStore.fetchVideos()
        await loadResolvedPreviewSources(currentVideoPath.value)

        toast.success('预览图已清空')
    } catch (e) {
        console.error('清空预览图失败:', e)
        toast.error('清空预览图失败: ' + String(e))
    }
}

// 下载长截图
const downloadingLongScreenshot = ref(false)
const downloadLongScreenshot = async () => {
    const code = formData.value.localId?.trim()?.toUpperCase()
    if (!code) {
        toast.error('请先填写番号')
        return
    }
    if (!props.video || !currentVideoPath.value) {
        toast.error('视频路径无效')
        return
    }

    downloadingLongScreenshot.value = true
    try {
        const url = `https://memojav.com/image/screenshot/${code}.jpg`
        await invoke<string>('download_remote_image', {
            videoId: props.video.id,
            videoPath: currentVideoPath.value,
            url,
        })

        await loadResolvedPreviewSources(currentVideoPath.value)

        toast.success('长截图已保存')
    } catch (e) {
        console.error('下载长截图失败:', e)
        toast.error('下载长截图失败: ' + String(e))
    } finally {
        downloadingLongScreenshot.value = false
    }
}
</script>

<template>
    <Dialog v-model:open="isOpen">
        <DialogContent class="sm:max-w-[1000px] h-[85vh] flex flex-col p-0 gap-0 overflow-hidden"
            aria-describedby="dialog-desc" @interact-outside="onInteractOutside">
            <DialogTitle class="sr-only">视频详情</DialogTitle>
            <DialogDescription id="dialog-desc" class="sr-only">编辑和查看视频详细信息</DialogDescription>
            <div class="flex flex-1 overflow-hidden">
                <!-- Left Column: Media -->
                <div class="w-[320px] shrink-0 bg-muted/30 flex flex-col border-r h-full">
                    <!-- Top: Cover Image -->
                    <div class="p-4 pb-2">
                        <div class="flex items-center gap-2 mb-2">
                            <ImageIcon class="size-4 text-muted-foreground" />
                            <span class="text-xs font-medium text-muted-foreground">封面</span>
                        </div>
                        <ContextMenu>
                            <ContextMenuTrigger as-child>
                                <div class="w-full min-h-[280px] rounded-lg overflow-hidden shadow-md relative bg-black/5 flex items-center justify-center transition-all"
                                    :class="imageSrc ? 'cursor-pointer hover:ring-2 hover:ring-primary' : ''"
                                    @click="imageSrc && openImageViewer(0)">
                                    <img v-if="imageSrc" :src="imageSrc"
                                        class="w-full h-auto object-contain max-h-[280px]"
                                        referrerPolicy="no-referrer" />
                                    <div v-else
                                        class="flex flex-col items-center justify-center text-muted-foreground p-8 gap-3">
                                        <ImageIcon class="size-12 opacity-20" />
                                        <span class="text-xs">暂无封面</span>
                                        <Button variant="outline" size="sm" @click.stop="openCaptureCoverDialog"
                                            class="h-7 text-xs">
                                            <Camera class="mr-1.5 size-3" />
                                            截取封面
                                        </Button>
                                    </div>
                                </div>
                            </ContextMenuTrigger>
                            <ContextMenuContent>
                                <ContextMenuItem @click="openCaptureCoverDialog">
                                    <Camera class="mr-2 size-4" />
                                    重新选取封面
                                </ContextMenuItem>
                                <ContextMenuSeparator />
                                <ContextMenuItem @click="deleteCover" :disabled="!imageSrc"
                                    class="text-destructive focus:text-destructive">
                                    <Trash2 class="mr-2 size-4" />
                                    删除封面
                                </ContextMenuItem>
                            </ContextMenuContent>
                        </ContextMenu>
                    </div>

                    <!-- Bottom: Preview Thumbs (Scroll List) -->
                    <div class="flex-1 min-h-0 flex flex-col px-4 pb-4">
                        <div class="flex items-center gap-2 mb-2">
                            <ImageIcon class="size-4 text-muted-foreground" />
                            <span class="text-xs font-medium text-muted-foreground">预览图</span>
                        </div>
                        <div class="flex-1 min-h-0 overflow-hidden">
                            <ContextMenu>
                                <ContextMenuTrigger as-child>
                                    <ScrollArea class="h-full bg-background/50 rounded-md border p-2">
                                        <div class="flex flex-col gap-3">
                                            <div v-for="(thumb, idx) in previewImages" :key="thumb.src + idx"
                                                class="rounded-md overflow-hidden border shadow-sm relative group bg-black/5 cursor-pointer hover:ring-2 hover:ring-primary transition-all"
                                                @click="openPreviewThumbViewer(idx)">
                                                <img :src="thumb.src" class="w-full h-auto object-cover"
                                                    loading="lazy" referrerPolicy="no-referrer" />
                                            </div>
                                            <div v-if="previewImages.length === 0"
                                                class="flex flex-col items-center justify-center py-8 text-muted-foreground gap-3">
                                                <span class="text-xs">暂无预览图</span>
                                                <Button variant="outline" size="sm"
                                                    @click="openCaptureThumbsDialog" class="h-7 text-xs">
                                                    <Camera class="mr-1.5 size-3" />
                                                    截取预览图
                                                </Button>
                                                <Button variant="outline" size="sm" class="h-7 text-xs"
                                                    :disabled="!formData.localId?.trim() || downloadingLongScreenshot"
                                                    @click="downloadLongScreenshot">
                                                    <Loader2 v-if="downloadingLongScreenshot"
                                                        class="mr-1.5 size-3 animate-spin" />
                                                    <Download v-else class="mr-1.5 size-3" />
                                                    下载长截图
                                                </Button>
                                            </div>
                                        </div>
                                    </ScrollArea>
                                </ContextMenuTrigger>
                                <ContextMenuContent>
                                    <ContextMenuItem @click="openCaptureThumbsDialog">
                                        <Camera class="mr-2 size-4" />
                                        视频截取预览图
                                    </ContextMenuItem>
                                    <ContextMenuItem @click="downloadLongScreenshot"
                                        :disabled="!formData.localId?.trim() || downloadingLongScreenshot">
                                        <Download class="mr-2 size-4" />
                                        下载长截图
                                    </ContextMenuItem>
                                    <ContextMenuSeparator />
                                    <ContextMenuItem @click="clearThumbs" :disabled="previewImages.length === 0"
                                        class="text-destructive focus:text-destructive">
                                        <Trash2 class="mr-2 size-4" />
                                        清空预览图
                                    </ContextMenuItem>
                                </ContextMenuContent>
                            </ContextMenu>
                        </div>
                    </div>
                </div>

                <!-- Right Column: Details & Edit -->
                <div class="flex-1 flex flex-col min-w-0 bg-background h-full overflow-hidden">
                    <ScrollArea class="flex-1">
                        <div class="p-6 space-y-4">
                            <!-- Header / Title -->
                            <div class="space-y-2">
                                <Label class="text-xs text-muted-foreground">标题</Label>
                                <Input v-model="formData.title"
                                    :class="['text-lg font-bold h-9', !isTitleValid && 'border-destructive focus-visible:ring-destructive/40']"
                                    :placeholder="formData.originalTitle" />
                                <p v-if="!isTitleValid" class="text-xs text-destructive">
                                    {{ titleValidationMessage }}
                                </p>
                            </div>

                            <!-- Original Title -->
                            <div class="space-y-2">
                                <Label class="text-xs text-muted-foreground">原标题 / 文件名</Label>
                                <Input v-model="formData.originalTitle"
                                    class="h-8 text-sm font-mono text-muted-foreground" />
                            </div>

                            <!-- Metadata Grid -->
                            <div class="grid grid-cols-3 gap-x-4 gap-y-3">
                                <div class="space-y-1">
                                    <Label class="text-[10px] text-muted-foreground uppercase tracking-wider">番号
                                        (ID)</Label>
                                    <div class="flex gap-2">
                                        <Input v-model="formData.localId" class="font-mono h-8 text-sm flex-1" />
                                        <Button type="button" variant="outline" size="icon" class="h-8 w-8 shrink-0"
                                            :disabled="aiRecognizing || (!formData.originalTitle && !formData.title)"
                                            @click="recognizeLocalId" title="使用AI识别番号">
                                            <Loader2 v-if="aiRecognizing" class="size-4 animate-spin" />
                                            <Sparkles v-else class="size-4" />
                                        </Button>
                                    </div>
                                </div>

                                <div class="space-y-1">
                                    <Label
                                        class="text-[10px] text-muted-foreground uppercase tracking-wider">发行日期</Label>
                                    <Input type="date" v-model="formData.premiered" class="h-8 text-sm" />
                                </div>

                                <div class="space-y-1">
                                    <Label class="text-[10px] text-muted-foreground uppercase tracking-wider">时长</Label>
                                    <Input type="text" v-model="durationFormatted" class="h-8 text-sm"
                                        placeholder="00:00:00" />
                                </div>

                                <div class="space-y-1">
                                    <Label class="text-[10px] text-muted-foreground uppercase tracking-wider">导演</Label>
                                    <Input v-model="formData.director" class="h-8 text-sm" />
                                </div>

                                <div class="space-y-1">
                                    <Label
                                        class="text-[10px] text-muted-foreground uppercase tracking-wider">制作商</Label>
                                    <Input v-model="studioValue" class="h-8 text-sm" />
                                </div>

                                <div class="space-y-1">
                                    <Label
                                        class="text-[10px] text-muted-foreground uppercase tracking-wider">分辨率</Label>
                                    <Input v-model="formData.resolution" class="h-8 text-sm"
                                        placeholder="例如: 1920x1080" />
                                </div>
                            </div>

                            <!-- Categories / Tags and Actors in one row -->
                            <div class="grid grid-cols-2 gap-x-4">
                                <div class="space-y-1">
                                    <Label class="text-[10px] text-muted-foreground uppercase tracking-wider">类别 /
                                        标签</Label>
                                    <Input v-model="tagsList" class="h-8 text-sm" />
                                </div>

                                <div class="space-y-1">
                                    <Label class="text-[10px] text-muted-foreground uppercase tracking-wider">演员</Label>
                                    <Input v-model="actorsList" class="h-8 text-sm" />
                                </div>
                            </div>

                            <!-- Rating -->
                            <div class="space-y-1.5">
                                <Label class="text-xs text-muted-foreground">评分</Label>
                                <div class="flex items-center gap-1">
                                    <button v-for="i in 10" :key="i"
                                        class="focus:outline-none transition-transform hover:scale-110"
                                        @click="setRating(i)">
                                        <Star class="size-5 transition-colors"
                                            :class="(formData.rating || 0) >= i ? 'text-yellow-500 fill-yellow-500' : 'text-muted-foreground/30'" />
                                    </button>
                                    <span class="ml-2 text-sm font-medium text-muted-foreground">
                                        {{ formData.rating || 0 }} 分
                                    </span>
                                </div>
                            </div>

                            <!-- Video Path -->
                            <div class="space-y-1.5 pt-2">
                                <Label class="text-xs text-muted-foreground">文件路径</Label>
                                <div class="text-xs text-muted-foreground/70 font-mono break-all select-all hover:text-muted-foreground transition-colors cursor-text">
                                    {{ currentVideoPath }}
                                </div>
                            </div>


                        </div>
                    </ScrollArea>

                    <!-- Footer Actions -->
                    <div class="p-4 border-t bg-muted/20 flex flex-col gap-3">
                        <div v-if="scrapeStore.cfChallengeActive"
                            class="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900">
                            <ShieldAlert class="mt-0.5 size-4 shrink-0" />
                            <div>
                                当前正在等待 Cloudflare 验证，请在弹出的 WebView 中完成操作，验证通过后会自动继续刮削。
                            </div>
                        </div>

                        <div class="flex items-center gap-3">
                        <!-- 更多按钮（最左侧） -->
                        <DropdownMenu>
                            <DropdownMenuTrigger as-child>
                                <Button variant="outline" size="sm">
                                    <MoreHorizontal class="size-4" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start">
                                <DropdownMenuItem @click="handleOpenDir">
                                    <FolderOpen class="mr-2 size-4" />
                                    打开目录
                                </DropdownMenuItem>
                                <DropdownMenuItem @click="handleDeleteClick"
                                    class="text-destructive focus:text-destructive">
                                    <Trash2 class="mr-2 size-4" />
                                    删除视频
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>

                        <Button variant="outline" size="sm" @click="handleScrape" :disabled="isScraping">
                            <Loader2 v-if="isScraping" class="mr-2 size-4 animate-spin" />
                            <RefreshCw v-else class="mr-2 size-4" />
                            {{ isScraping ? '刮削中...' : '重新刮削' }}
                        </Button>

                        <Button :variant="hasScrapedData ? 'default' : 'outline'" size="sm" @click="handleSave"
                            :disabled="isSaving || !isTitleValid"
                            :class="hasScrapedData ? 'bg-white text-black hover:bg-white/90' : ''">
                            <Loader2 v-if="isSaving" class="mr-2 size-4 animate-spin" />
                            <Save v-else class="mr-2 size-4" />
                            {{ isSaving ? '保存中...' : '保存修改' }}
                        </Button>

                        <div class="flex-1"></div>

                        <Button size="sm" @click="handlePlay">
                            <Play class="mr-2 size-4" fill="currentColor" />
                            播放
                        </Button>
                        </div>
                    </div>
                </div>
            </div>

        </DialogContent>
    </Dialog>

    <!-- 截取封面对话框 -->
    <CaptureCoverDialog v-if="props.video" v-model:open="captureCoverDialogOpen" :video-id="props.video.id"
        :video-path="currentVideoPath" :mode="'single'" @success="handleCaptureCoverSuccess" />

    <!-- 截取预览图对话框 -->
    <CaptureCoverDialog v-if="props.video" v-model:open="captureThumbsDialogOpen" :video-id="props.video.id"
        :video-path="currentVideoPath" :mode="'multiple'" @success="handleCaptureThumbsSuccess" />

    <!-- 删除确认对话框 -->
    <DeleteVideoDialog v-model:open="showDeleteConfirm" :video="props.video" @success="handleDeleteSuccess" />
</template>
