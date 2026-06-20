<script setup lang="ts">
import { ref, computed } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Loader2, Magnet as MagnetIcon, Copy } from 'lucide-vue-next'

interface Props {
    code?: string | null
}
const props = defineProps<Props>()

interface MagnetItem {
    link: string
    name: string
    size: string
    sizeBytes: number
    date: string
    isHd: boolean
    hasSubtitle: boolean
}

const magnets = ref<MagnetItem[]>([])
const loading = ref(false)
const loaded = ref(false)
const sortMode = ref<'default' | 'size' | 'date'>('default')

const fetchMagnets = async () => {
    if (!props.code || loading.value) return
    loading.value = true
    try {
        magnets.value = await invoke<MagnetItem[]>('rs_get_magnets', { code: props.code })
        loaded.value = true
        if (magnets.value.length === 0) toast.info('未找到磁力链接')
    } catch (e) {
        console.error('获取磁力失败:', e)
        toast.error('获取磁力失败: ' + String(e))
    } finally {
        loading.value = false
    }
}

// default = 后端顺序（字幕>高清>体积）；可切体积/日期
const sorted = computed(() => {
    const arr = [...magnets.value]
    if (sortMode.value === 'size') arr.sort((a, b) => b.sizeBytes - a.sizeBytes)
    else if (sortMode.value === 'date') arr.sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    return arr
})

const copyLink = async (link: string) => {
    try {
        await navigator.clipboard.writeText(link)
        toast.success('已复制磁力链接')
    } catch {
        toast.error('复制失败')
    }
}
</script>

<template>
    <div class="space-y-2">
        <div class="flex items-center gap-2">
            <span class="text-sm font-medium">磁力链接</span>
            <Button
                size="sm"
                variant="outline"
                class="h-7 gap-1 text-xs"
                :disabled="loading || !code"
                @click="fetchMagnets"
            >
                <Loader2 v-if="loading" class="size-3.5 animate-spin" />
                <MagnetIcon v-else class="size-3.5" />
                {{ loaded ? '刷新' : '获取磁力' }}
            </Button>
            <div v-if="magnets.length" class="ml-auto flex items-center gap-1 text-xs">
                <span class="text-muted-foreground">排序</span>
                <Button
                    v-for="m in (['default', 'size', 'date'] as const)"
                    :key="m"
                    size="sm"
                    :variant="sortMode === m ? 'default' : 'ghost'"
                    class="h-6 px-2 text-xs"
                    @click="sortMode = m"
                >
                    {{ m === 'default' ? '最优' : m === 'size' ? '体积' : '日期' }}
                </Button>
            </div>
        </div>

        <div v-if="loaded && magnets.length === 0" class="text-xs text-muted-foreground">无磁力链接</div>
        <div v-else-if="magnets.length" class="space-y-1">
            <div
                v-for="(m, i) in sorted"
                :key="m.link + i"
                class="flex items-center gap-2 rounded border p-2 text-xs"
            >
                <div class="flex shrink-0 gap-1">
                    <span v-if="m.hasSubtitle" class="rounded bg-amber-500/20 px-1 text-amber-600">字幕</span>
                    <span v-if="m.isHd" class="rounded bg-blue-500/20 px-1 text-blue-600">HD</span>
                </div>
                <span class="min-w-0 flex-1 truncate" :title="m.name">{{ m.name || m.link }}</span>
                <span class="shrink-0 tabular-nums text-muted-foreground">{{ m.size }}</span>
                <span class="shrink-0 text-muted-foreground">{{ m.date }}</span>
                <Button
                    size="icon"
                    variant="ghost"
                    class="size-6 shrink-0"
                    title="复制磁力链接"
                    @click="copyLink(m.link)"
                >
                    <Copy class="size-3.5" />
                </Button>
            </div>
        </div>
    </div>
</template>
