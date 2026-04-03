<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { Trash2, RefreshCw, FolderPlus, Loader2 } from 'lucide-vue-next'
import { useVideoStore } from '@/stores'
import { selectDirectory } from '@/lib/tauri'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { Button } from '@/components/ui/button'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table'
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuTrigger,
} from '@/components/ui/context-menu'

interface Props {
    open?: boolean
}

interface Emits {
    (e: 'update:open', value: boolean): void
    (e: 'openRemoveAds'): void
}

interface ScanProgress {
    current: number
    total: number
    current_file: string
}

const props = withDefaults(defineProps<Props>(), {
    open: false,
})

const emit = defineEmits<Emits>()

const videoStore = useVideoStore()

const formatScanSummary = (successCount: number, failedCount: number) => {
    return `成功 ${successCount} 个，失败 ${failedCount} 个`
}

const isOpen = computed({
    get: () => props.open,
    set: (value) => emit('update:open', value),
})

// 同步状态
const syncingIds = ref<Set<string>>(new Set())

// 扫描进度状态
const isScanning = ref(false)
const scanProgress = ref<ScanProgress>({
    current: 0,
    total: 0,
    current_file: ''
})

let unlistenProgress: UnlistenFn | null = null

onMounted(async () => {
    // 监听扫描进度事件
    unlistenProgress = await listen<ScanProgress>('scan-progress', (event) => {
        scanProgress.value = event.payload
    })
})

onUnmounted(() => {
    if (unlistenProgress) {
        unlistenProgress()
    }
})

// 添加目录
const handleAddDirectory = async () => {
    try {
        const path = await selectDirectory()
        if (path) {
            // 立即显示添加目录提示
            isScanning.value = true
            scanProgress.value = { current: 0, total: 0, current_file: '正在添加目录...' }
            
            try {
                const summary = await videoStore.addDirectory(path)
                
                // 扫描完成后更新提示
                scanProgress.value = { 
                    current: 1, 
                    total: 1, 
                    current_file: `目录添加并扫描完成，${formatScanSummary(summary.success_count, summary.failed_count)}` 
                }
                window.alert(`目录扫描完成：${formatScanSummary(summary.success_count, summary.failed_count)}`)
            } finally {
                isScanning.value = false
            }
        }
    } catch (e: any) {
        isScanning.value = false
        if (e.message === 'Directory already exists') {
            window.alert('该目录已存在！')
        } else {
            console.error('Failed to add directory:', e)
            window.alert('添加失败: ' + (e.message || '未知错误'))
        }
    }
}

// 删除目录
const handleRemoveDirectory = (id: string) => {
    videoStore.removeDirectory(id)
}

// 同步目录数量
const handleSyncDirectory = async (id: string) => {
    syncingIds.value.add(id)
    isScanning.value = true
    scanProgress.value = { current: 0, total: 0, current_file: '' }
    
    try {
        const summary = await videoStore.syncDirectoryCount(id)
        if (summary) {
            window.alert(`目录扫描完成：${formatScanSummary(summary.success_count, summary.failed_count)}`)
        }
    } catch (e) {
        console.error('Failed to sync directory:', e)
    } finally {
        syncingIds.value.delete(id)
        isScanning.value = false
    }
}

// 检查是否正在同步
const isSyncing = (id: string) => syncingIds.value.has(id)

// 计算总视频数
const totalDirectoryVideoCount = computed(() => {
    return videoStore.directories.reduce((sum, dir) => sum + (dir.videoCount || 0), 0)
})

// 计算进度百分比
const progressPercentage = computed(() => {
    if (scanProgress.value.total === 0) return 0
    return Math.round((scanProgress.value.current / scanProgress.value.total) * 100)
})

// 获取当前文件名（只显示文件名，不显示完整路径）
const currentFileName = computed(() => {
    if (!scanProgress.value.current_file) return ''
    const parts = scanProgress.value.current_file.split(/[/\\]/)
    return parts[parts.length - 1]
})
</script>

<template>
    <Dialog v-model:open="isOpen">
        <DialogContent class="max-w-6xl max-h-[85vh] flex flex-col">
            <DialogHeader>
                <DialogTitle>目录管理</DialogTitle>
                <DialogDescription>
                    管理视频扫描目录，添加或删除目录，同步视频数量
                </DialogDescription>
            </DialogHeader>

            <!-- 工具栏 -->
            <div class="flex items-center justify-between py-2">
                <div class="text-sm text-muted-foreground">
                    总视频数量: <span class="font-medium text-foreground">{{ totalDirectoryVideoCount }}</span>
                </div>
                <div class="flex items-center gap-2">
                    <Button variant="outline" size="sm" @click="$emit('openRemoveAds')" :disabled="isScanning">
                        移除广告视频
                    </Button>
                    <Button variant="outline" size="sm" @click="handleAddDirectory" :disabled="isScanning">
                        <FolderPlus class="mr-2 size-4" />
                        添加目录
                    </Button>
                </div>
            </div>

            <!-- 目录表格 -->
            <div class="flex-1 overflow-auto border rounded-md relative">
                <!-- 扫描进度遮罩 -->
                <div v-if="isScanning" class="absolute inset-0 bg-background/80 backdrop-blur-sm z-10 flex items-center justify-center">
                    <div class="bg-card border rounded-lg shadow-lg p-6 max-w-md w-full mx-4">
                        <div class="flex items-center gap-3 mb-4">
                            <Loader2 class="size-5 animate-spin text-primary" />
                            <h3 class="text-lg font-semibold">正在扫描视频文件</h3>
                        </div>
                        
                        <div class="space-y-3">
                            <!-- 进度条 -->
                            <div class="space-y-2">
                                <div class="flex justify-between text-sm">
                                    <span class="text-muted-foreground">扫描进度</span>
                                    <span class="font-medium">{{ progressPercentage }}%</span>
                                </div>
                                <div class="h-2 bg-secondary rounded-full overflow-hidden">
                                    <div 
                                        class="h-full bg-primary transition-all duration-300 ease-out"
                                        :style="{ width: `${progressPercentage}%` }"
                                    />
                                </div>
                                <div class="flex justify-between text-xs text-muted-foreground">
                                    <span v-if="scanProgress.total > 0">{{ scanProgress.current }} / {{ scanProgress.total }}</span>
                                    <span v-else>正在统计文件...</span>
                                </div>
                            </div>
                            
                            <!-- 当前文件 -->
                            <div v-if="currentFileName" class="text-sm">
                                <div class="text-muted-foreground mb-1">当前文件:</div>
                                <div class="font-mono text-xs bg-secondary/50 rounded px-2 py-1 truncate" :title="scanProgress.current_file">
                                    {{ currentFileName }}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead class="w-[60%]">路径</TableHead>
                            <TableHead class="w-[20%] text-center">数量</TableHead>
                            <TableHead class="w-[20%] text-center">操作</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        <TableRow v-if="videoStore.directories.length === 0">
                            <TableCell colspan="3" class="text-center text-muted-foreground py-8">
                                暂无目录，点击"添加目录"按钮开始添加
                            </TableCell>
                        </TableRow>
                        <ContextMenu v-for="directory in videoStore.directories" :key="directory.id">
                            <ContextMenuTrigger as-child>
                                <TableRow class="cursor-context-menu">
                                    <TableCell class="font-mono text-sm">{{ directory.path }}</TableCell>
                                    <TableCell class="text-center">{{ directory.videoCount }}</TableCell>
                                    <TableCell>
                                        <div class="flex items-center justify-center gap-1">
                                            <Button variant="ghost" size="sm" class="h-8 w-8 p-0"
                                                :disabled="isSyncing(directory.id) || isScanning"
                                                @click="handleSyncDirectory(directory.id)">
                                                <RefreshCw class="size-4"
                                                    :class="{ 'animate-spin': isSyncing(directory.id) }" />
                                            </Button>
                                            <Button variant="ghost" size="sm"
                                                class="h-8 w-8 p-0 text-destructive hover:text-destructive"
                                                :disabled="isScanning"
                                                @click="handleRemoveDirectory(directory.id)">
                                                <Trash2 class="size-4" />
                                            </Button>
                                        </div>
                                    </TableCell>
                                </TableRow>
                            </ContextMenuTrigger>
                            <ContextMenuContent>
                                <ContextMenuItem :disabled="isSyncing(directory.id) || isScanning"
                                    @click="handleSyncDirectory(directory.id)">
                                    <RefreshCw class="mr-2 size-4"
                                        :class="{ 'animate-spin': isSyncing(directory.id) }" />
                                    同步数量
                                </ContextMenuItem>
                                <ContextMenuItem class="text-destructive focus:text-destructive"
                                    :disabled="isScanning"
                                    @click="handleRemoveDirectory(directory.id)">
                                    <Trash2 class="mr-2 size-4" />
                                    删除目录
                                </ContextMenuItem>
                            </ContextMenuContent>
                        </ContextMenu>
                    </TableBody>
                </Table>
            </div>
        </DialogContent>
    </Dialog>
</template>
