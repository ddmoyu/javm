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
import { Loader2, RefreshCw, ImageOff, FileX, ScanLine, AlertTriangle, Hash, Film } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useVideoStore } from '@/stores'
import { hasCoverImage } from '@/utils/image'

interface Props {
    open: boolean
}
const props = defineProps<Props>()
const emit = defineEmits<{
    (e: 'update:open', value: boolean): void
    (e: 'view-non-standard'): void
}>()
const isOpen = computed({
    get: () => props.open,
    set: (v) => emit('update:open', v),
})

const videoStore = useVideoStore()

interface LibraryHealth {
    total: number
    recognizeFailed: number
    scrapeFailed: number
    missingCover: number
    missingNfo: number
    missingCode: number
}

const loading = ref(false)
const health = ref<LibraryHealth | null>(null)

const batchRunning = ref(false)
const batchDone = ref(0)
const batchTotal = ref(0)

const fetchHealth = async () => {
    loading.value = true
    try {
        health.value = await invoke<LibraryHealth>('get_library_health')
    } catch (e) {
        console.error('获取库健康失败:', e)
        toast.error('获取库健康失败: ' + String(e))
    } finally {
        loading.value = false
    }
}

// 缺封面批量补全（全库，DMM 优先）
const fetchMissingCovers = async () => {
    if (batchRunning.value) return
    const ids = videoStore.videos.filter((v) => !hasCoverImage(v)).map((v) => v.id)
    if (ids.length === 0) {
        toast.info('没有缺封面的视频')
        return
    }
    batchRunning.value = true
    batchDone.value = 0
    batchTotal.value = ids.length

    let unlisten: (() => void) | null = null
    try {
        unlisten = await listen<{ done: number; total: number }>('batch-fetch-cover-progress', (e) => {
            batchDone.value = e.payload.done
            batchTotal.value = e.payload.total
        })
        const r = await invoke<{ applied: number; skipped: number; failed: number }>('batch_fetch_covers', {
            videoIds: ids,
        })
        toast.success(
            `完成：${r.applied} 已获取，${r.skipped} 跳过` + (r.failed ? `，${r.failed} 失败` : ''),
        )
        if (r.applied > 0) await videoStore.fetchVideos()
        await fetchHealth()
    } catch (e) {
        console.error('批量获取封面失败:', e)
        toast.error('批量获取失败: ' + String(e))
    } finally {
        if (unlisten) unlisten()
        batchRunning.value = false
    }
}

watch(
    () => props.open,
    (o) => {
        if (o) fetchHealth()
    },
)
</script>

<template>
    <Dialog :open="isOpen" @update:open="(v) => (isOpen = v)">
        <DialogContent class="sm:max-w-[600px]">
            <DialogTitle>库健康诊断</DialogTitle>
            <DialogDescription>媒体库元数据缺口与失败项总览，可一键补全缺封面</DialogDescription>

            <div v-if="loading && !health" class="flex items-center justify-center py-12">
                <Loader2 class="size-8 animate-spin text-muted-foreground" />
            </div>

            <div v-else-if="health" class="grid grid-cols-2 gap-3 py-2">
                <div class="rounded-lg border p-3">
                    <div class="flex items-center gap-2 text-muted-foreground text-sm">
                        <Film class="size-4" />视频总数
                    </div>
                    <div class="text-2xl font-semibold mt-1 tabular-nums">{{ health.total }}</div>
                </div>

                <div class="rounded-lg border p-3" :class="health.missingCover > 0 ? 'border-amber-500/50 bg-amber-500/5' : ''">
                    <div class="flex items-center gap-2 text-muted-foreground text-sm">
                        <ImageOff class="size-4" />缺封面
                    </div>
                    <div class="flex items-end justify-between mt-1">
                        <div class="text-2xl font-semibold tabular-nums">{{ health.missingCover }}</div>
                        <Button
                            v-if="health.missingCover > 0"
                            size="sm"
                            variant="outline"
                            class="h-7 text-xs"
                            :disabled="batchRunning"
                            @click="fetchMissingCovers"
                        >
                            {{ batchRunning ? `${batchDone}/${batchTotal}` : '批量获取' }}
                        </Button>
                    </div>
                </div>

                <div class="rounded-lg border p-3" :class="health.recognizeFailed > 0 ? 'border-destructive/40 bg-destructive/5' : ''">
                    <div class="flex items-center gap-2 text-muted-foreground text-sm">
                        <ScanLine class="size-4" />识别失败
                    </div>
                    <div class="text-2xl font-semibold mt-1 tabular-nums">{{ health.recognizeFailed }}</div>
                </div>

                <div class="rounded-lg border p-3" :class="health.scrapeFailed > 0 ? 'border-destructive/40 bg-destructive/5' : ''">
                    <div class="flex items-center gap-2 text-muted-foreground text-sm">
                        <AlertTriangle class="size-4" />刮削失败
                    </div>
                    <div class="text-2xl font-semibold mt-1 tabular-nums">{{ health.scrapeFailed }}</div>
                </div>

                <div class="rounded-lg border p-3">
                    <div class="flex items-center gap-2 text-muted-foreground text-sm">
                        <FileX class="size-4" />缺 NFO
                    </div>
                    <div class="text-2xl font-semibold mt-1 tabular-nums">{{ health.missingNfo }}</div>
                </div>

                <div class="rounded-lg border p-3" :class="health.missingCode > 0 ? 'border-amber-500/50 bg-amber-500/5' : ''">
                    <div class="flex items-center gap-2 text-muted-foreground text-sm">
                        <Hash class="size-4" />缺番号
                    </div>
                    <div class="flex items-end justify-between mt-1">
                        <div class="text-2xl font-semibold tabular-nums">{{ health.missingCode }}</div>
                        <Button
                            v-if="health.missingCode > 0"
                            size="sm"
                            variant="outline"
                            class="h-7 text-xs"
                            @click="emit('view-non-standard')"
                        >
                            非标准库
                        </Button>
                    </div>
                </div>
            </div>

            <DialogFooter>
                <Button variant="outline" :disabled="loading" @click="fetchHealth">
                    <RefreshCw class="mr-2 size-4" /> 刷新
                </Button>
                <Button variant="outline" @click="isOpen = false">关闭</Button>
            </DialogFooter>
        </DialogContent>
    </Dialog>
</template>
