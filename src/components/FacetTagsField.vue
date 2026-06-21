<script setup lang="ts">
import { ref, computed, nextTick } from 'vue'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Pencil, Check } from 'lucide-vue-next'

type FacetKind = 'director' | 'studio' | 'genre' | 'actor'

interface Props {
    label: string
    modelValue?: string
    facetType: FacetKind
    /** 多值（逗号/、/，分隔，演员、分类）；单值（片商、导演） */
    multi?: boolean
    placeholder?: string
}
const props = defineProps<Props>()
const emit = defineEmits<{
    (e: 'update:modelValue', value: string): void
    (e: 'navigate', payload: { facetType: FacetKind; value: string }): void
}>()

const editing = ref(false)
const draft = ref('')
const inputRef = ref<any>(null)

// 展示态的 tag 列表：多值拆分，单值整串
const items = computed<string[]>(() => {
    const raw = (props.modelValue || '').trim()
    if (!raw) return []
    if (props.multi) return raw.split(/[,，、]/).map((s) => s.trim()).filter(Boolean)
    return [raw]
})

const startEdit = async () => {
    draft.value = props.modelValue || ''
    editing.value = true
    await nextTick()
    const el: HTMLElement | undefined = inputRef.value?.$el
    el?.focus?.()
}
const commit = () => {
    emit('update:modelValue', draft.value.trim())
    editing.value = false
}
const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter') commit()
    else if (e.key === 'Escape') editing.value = false
}
const onNavigate = (value: string) => {
    if (value.trim()) emit('navigate', { facetType: props.facetType, value })
}
</script>

<template>
    <div class="space-y-1">
        <Label class="text-[10px] text-muted-foreground uppercase tracking-wider">{{ label }}</Label>

        <!-- 编辑态：输入框 + 保存（回车亦可） -->
        <div v-if="editing" class="flex gap-1">
            <Input ref="inputRef" v-model="draft" class="h-8 text-sm flex-1" :placeholder="placeholder"
                @keyup="onKey" />
            <Button type="button" variant="outline" size="icon" class="h-8 w-8 shrink-0" title="保存" @click="commit">
                <Check class="size-4" />
            </Button>
        </div>

        <!-- 展示态：可点击 tag（进入发现对应维度） + 末尾编辑图标 -->
        <div v-else class="flex min-h-8 flex-wrap items-center gap-1">
            <button v-for="(it, i) in items" :key="i" type="button"
                class="rounded-full bg-muted px-2 py-0.5 text-xs transition hover:bg-accent hover:text-accent-foreground"
                :title="`在发现中查看：${it}`" @click="onNavigate(it)">
                {{ it }}
            </button>
            <span v-if="items.length === 0" class="text-xs text-muted-foreground">—</span>
            <Button type="button" variant="ghost" size="icon" class="size-6 shrink-0 text-muted-foreground"
                title="编辑" @click="startEdit">
                <Pencil class="size-3.5" />
            </Button>
        </div>
    </div>
</template>
