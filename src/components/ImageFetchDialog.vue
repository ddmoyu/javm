<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import {
    Dialog,
    DialogContent,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Loader2, Check, RefreshCw } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { invoke } from '@tauri-apps/api/core'

interface Props {
    open: boolean
    videoId: string
}
const props = defineProps<Props>()

const emit = defineEmits<{
    (e: 'update:open', value: boolean): void
    (e: 'success'): void
}>()

const isOpen = computed({
    get: () => props.open,
    set: (val) => emit('update:open', val),
})

interface ImageCandidate {
    source: string
    kind: string // 'cover' | 'screenshot'
    url: string
}

const loading = ref(false)
const saving = ref(false)
const candidates = ref<ImageCandidate[]>([])
const selectedCover = ref<string | null>(null)
const selectedScreenshots = ref<Set<string>>(new Set())
const failedUrls = ref<Set<string>>(new Set())

const coverCandidates = computed(() =>
    candidates.value.filter((c) => c.kind === 'cover' && !failedUrls.value.has(c.url)),
)
const screenshotCandidates = computed(() =>
    candidates.value.filter((c) => c.kind === 'screenshot' && !failedUrls.value.has(c.url)),
)
const hasAny = computed(() => coverCandidates.value.length > 0 || screenshotCandidates.value.length > 0)

const fetchCandidates = async () => {
    if (!props.videoId) return
    loading.value = true
    candidates.value = []
    selectedCover.value = null
    selectedScreenshots.value = new Set()
    failedUrls.value = new Set()
    try {
        const list = await invoke<ImageCandidate[]>('get_image_candidates', { videoId: props.videoId })
        candidates.value = list
        // 默认选中第一个封面
        const firstCover = list.find((c) => c.kind === 'cover')
        if (firstCover) selectedCover.value = firstCover.url
    } catch (e) {
        console.error('获取候选图失败:', e)
        toast.error('获取候选图失败: ' + String(e))
    } finally {
        loading.value = false
    }
}

// 远程图加载失败（地区/失效）→ 从候选中剔除
const onImgError = (url: string) => {
    failedUrls.value.add(url)
    failedUrls.value = new Set(failedUrls.value)
    if (selectedCover.value === url) selectedCover.value = null
    if (selectedScreenshots.value.delete(url)) {
        selectedScreenshots.value = new Set(selectedScreenshots.value)
    }
}

const toggleScreenshot = (url: string) => {
    if (selectedScreenshots.value.has(url)) selectedScreenshots.value.delete(url)
    else selectedScreenshots.value.add(url)
    selectedScreenshots.value = new Set(selectedScreenshots.value)
}

// 截图全选 / 取消全选（仅针对当前未失效的截图候选）
const allScreenshotsSelected = computed(
    () =>
        screenshotCandidates.value.length > 0 &&
        screenshotCandidates.value.every((c) => selectedScreenshots.value.has(c.url)),
)
const toggleSelectAllScreenshots = () => {
    selectedScreenshots.value = allScreenshotsSelected.value
        ? new Set()
        : new Set(screenshotCandidates.value.map((c) => c.url))
}

const apply = async () => {
    if (!selectedCover.value && selectedScreenshots.value.size === 0) {
        toast.error('请至少选择一个封面或截图')
        return
    }
    saving.value = true
    try {
        await invoke('apply_image_candidates', {
            videoId: props.videoId,
            coverUrl: selectedCover.value,
            screenshotUrls: Array.from(selectedScreenshots.value),
        })
        toast.success('已应用')
        emit('success')
        isOpen.value = false
    } catch (e) {
        console.error('应用失败:', e)
        toast.error('应用失败: ' + String(e))
    } finally {
        saving.value = false
    }
}

const handleOpenChange = (open: boolean) => {
    isOpen.value = open
    if (!open) {
        candidates.value = []
        selectedCover.value = null
        selectedScreenshots.value = new Set()
        failedUrls.value = new Set()
    }
}

watch(
    () => props.open,
    (newOpen) => {
        if (newOpen) fetchCandidates()
    },
)
</script>

<template>
    <Dialog :open="isOpen" @update:open="handleOpenChange">
        <DialogContent class="sm:max-w-[820px] h-[80vh] flex flex-col p-0 gap-0">
            <div class="p-6 pb-4 border-b">
                <DialogTitle>获取封面 / 截图</DialogTitle>
                <DialogDescription>从 DMM 官方 CDN 获取高清封面与截图（仅覆盖有码主流），选定后应用</DialogDescription>
            </div>

            <div class="flex-1 min-h-0 p-6">
                <div v-if="loading" class="flex flex-col items-center justify-center h-full">
                    <Loader2 class="size-12 animate-spin text-muted-foreground mb-4" />
                    <p class="text-sm text-muted-foreground">正在探测 DMM 官方图...</p>
                </div>

                <ScrollArea v-else-if="hasAny" class="h-full">
                    <!-- 封面候选 -->
                    <template v-if="coverCandidates.length">
                        <p class="text-sm font-medium mb-2">封面（横版，应用后自动裁出竖版海报）</p>
                        <div class="grid grid-cols-2 gap-4 mb-6">
                            <div
                                v-for="c in coverCandidates"
                                :key="c.url"
                                class="group relative aspect-video rounded-lg overflow-hidden border-2 cursor-pointer transition-all bg-black/5"
                                :class="selectedCover === c.url ? 'border-primary ring-2 ring-primary' : 'border-border'"
                                @click="selectedCover = c.url"
                            >
                                <img :src="c.url" class="w-full h-full object-contain" alt="封面候选" referrerpolicy="no-referrer" @error="onImgError(c.url)" />
                                <div
                                    v-if="selectedCover === c.url"
                                    class="absolute top-2 left-2 size-7 rounded-full bg-primary flex items-center justify-center shadow-md"
                                >
                                    <Check class="size-4 text-primary-foreground" />
                                </div>
                            </div>
                        </div>
                    </template>

                    <!-- 截图候选 -->
                    <template v-if="screenshotCandidates.length">
                        <div class="flex items-center justify-between mb-2">
                            <p class="text-sm font-medium">
                                截图（可多选，追加为预览图）<span class="text-muted-foreground">· 已选 {{ selectedScreenshots.size }}/{{ screenshotCandidates.length }}</span>
                            </p>
                            <Button variant="ghost" size="sm" class="h-7 text-xs" @click="toggleSelectAllScreenshots">
                                {{ allScreenshotsSelected ? '取消全选' : '全选' }}
                            </Button>
                        </div>
                        <div class="grid grid-cols-3 gap-3">
                            <div
                                v-for="c in screenshotCandidates"
                                :key="c.url"
                                class="group relative aspect-video rounded-lg overflow-hidden border-2 cursor-pointer transition-all bg-black/5"
                                :class="selectedScreenshots.has(c.url) ? 'border-primary ring-2 ring-primary' : 'border-border'"
                                @click="toggleScreenshot(c.url)"
                            >
                                <img :src="c.url" class="w-full h-full object-cover" alt="截图候选" referrerpolicy="no-referrer" @error="onImgError(c.url)" />
                                <div
                                    v-if="selectedScreenshots.has(c.url)"
                                    class="absolute top-2 left-2 size-6 rounded-full bg-primary flex items-center justify-center shadow-md"
                                >
                                    <Check class="size-3.5 text-primary-foreground" />
                                </div>
                            </div>
                        </div>
                    </template>
                </ScrollArea>

                <div v-else class="flex flex-col items-center justify-center h-full text-muted-foreground text-center">
                    <p class="text-sm">未找到 DMM 官方图</p>
                    <p class="text-xs mt-1">DMM 仅覆盖有码主流（FANZA）；无码 / FC2 / 素人 可用「截取封面」从视频截帧</p>
                </div>
            </div>

            <DialogFooter class="p-6 pt-4 border-t">
                <Button variant="outline" :disabled="loading || saving" @click="fetchCandidates">
                    <RefreshCw class="mr-2 size-4" />
                    重新获取
                </Button>
                <Button :disabled="saving || (!selectedCover && selectedScreenshots.size === 0)" @click="apply">
                    <Loader2 v-if="saving" class="mr-2 size-4 animate-spin" />
                    应用{{ selectedScreenshots.size > 0 ? ` (封面${selectedCover ? 1 : 0} + 截图${selectedScreenshots.size})` : '' }}
                </Button>
                <Button variant="outline" @click="isOpen = false">关闭</Button>
            </DialogFooter>
        </DialogContent>
    </Dialog>
</template>
