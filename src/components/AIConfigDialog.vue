<script setup lang="ts">
import { ref, watch } from 'vue'
import { Loader2, Eye, EyeOff } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { AIProvider, AIProviderType } from '@/types'
import { AI_PROVIDER_OPTIONS } from '@/utils/constants'
import { invoke } from '@tauri-apps/api/core'

interface Props {
  open: boolean
  provider?: AIProvider | null
}

interface Emits {
  (e: 'update:open', value: boolean): void
  (e: 'save', provider: AIProvider): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

// 表单数据
const formData = ref({
  providerType: 'custom' as AIProviderType,
  name: '',
  model: '',
  apiUrl: '',
  apiKey: '',
})

// 验证错误
const errors = ref({
  name: '',
  model: '',
  apiUrl: '',
  apiKey: '',
})

// 测试状态
const testing = ref(false)
const testResult = ref<{ success: boolean; message: string } | null>(null)

// API Key显示/隐藏
const showApiKey = ref(false)

const MINIMAX_MODEL_IDS = ['MiniMax-M3', 'MiniMax-M2.7']

const PROVIDER_DEFAULTS: Partial<Record<AIProviderType, { name: string; model: string; apiUrl: string }>> = {
  minimax: {
    name: 'MiniMax',
    model: MINIMAX_MODEL_IDS[0],
    apiUrl: 'https://api.minimax.io/v1',
  },
  'minimax-cn': {
    name: 'MiniMax CN',
    model: MINIMAX_MODEL_IDS[0],
    apiUrl: 'https://api.minimaxi.com/v1',
  },
  'minimax-anthropic': {
    name: 'MiniMax Anthropic',
    model: MINIMAX_MODEL_IDS[0],
    apiUrl: 'https://api.minimax.io/anthropic',
  },
  'minimax-cn-anthropic': {
    name: 'MiniMax CN Anthropic',
    model: MINIMAX_MODEL_IDS[0],
    apiUrl: 'https://api.minimaxi.com/anthropic',
  },
}

const toggleApiKeyVisibility = () => {
  showApiKey.value = !showApiKey.value
}

const resolveProviderType = (provider: AIProvider | null | undefined): AIProviderType => {
  return provider?.provider ?? formData.value.providerType
}

const currentProviderType = (): AIProviderType => formData.value.providerType

const applyProviderDefaults = (providerType: AIProviderType) => {
  const defaults = PROVIDER_DEFAULTS[providerType]
  if (!defaults) {
    return
  }

  if (!formData.value.name.trim()) {
    formData.value.name = defaults.name
  }
  if (!formData.value.model.trim()) {
    formData.value.model = defaults.model
  }
  if (!formData.value.apiUrl.trim()) {
    formData.value.apiUrl = defaults.apiUrl
  }
}

// 监听打开状态，重置或填充表单
watch(() => props.open, (isOpen) => {
  if (isOpen) {
    if (props.provider) {
      // 编辑模式
      formData.value = {
        providerType: props.provider.provider,
        name: props.provider.name,
        model: props.provider.model,
        apiUrl: props.provider.endpoint || '',
        apiKey: props.provider.apiKey,
      }
    } else {
      // 新建模式
      formData.value = {
        providerType: 'custom',
        name: '',
        model: '',
        apiUrl: '',
        apiKey: '',
      }
    }
    applyProviderDefaults(resolveProviderType(props.provider))
    // 重置状态
    errors.value = { name: '', model: '', apiUrl: '', apiKey: '' }
    testResult.value = null
  }
})

const handleProviderTypeChange = (value: string | number | boolean | Record<string, unknown> | null | undefined) => {
  formData.value.providerType = String(value || 'custom') as AIProviderType
  applyProviderDefaults(formData.value.providerType)
}

// 表单验证
const validateForm = (): boolean => {
  errors.value = { name: '', model: '', apiUrl: '', apiKey: '' }
  let isValid = true

  if (!formData.value.name.trim()) {
    errors.value.name = '请输入供应商名称'
    isValid = false
  }

  if (!formData.value.model.trim()) {
    errors.value.model = '请输入模型名称'
    isValid = false
  }

  if (!formData.value.apiUrl.trim()) {
    errors.value.apiUrl = '请输入API URL'
    isValid = false
  } else {
    // 简单的URL验证
    try {
      new URL(formData.value.apiUrl)
    } catch {
      errors.value.apiUrl = '请输入有效的URL'
      isValid = false
    }
  }

  if (!formData.value.apiKey.trim()) {
    errors.value.apiKey = '请输入API Key'
    isValid = false
  }

  return isValid
}

// 测试API
const testApi = async () => {
  if (!validateForm()) {
    toast.error('请填写所有必填项')
    return
  }

  testing.value = true
  testResult.value = null

  try {
    const result = await invoke<{ success: boolean; message: string }>('test_ai_api', {
      request: {
        provider: currentProviderType(),
        model: formData.value.model,
        apiKey: formData.value.apiKey,
        endpoint: formData.value.apiUrl,
      },
    })

    testResult.value = result

    if (result.success) {
      toast.success(result.message)
    } else {
      toast.error(result.message)
    }
  } catch (error) {
    console.error('Test API error:', error)
    testResult.value = {
      success: false,
      message: String(error),
    }
    toast.error(`测试失败: ${error}`)
  } finally {
    testing.value = false
  }
}

// 保存
const handleSave = () => {
  if (!validateForm()) {
    toast.error('请填写所有必填项')
    return
  }

  const provider: AIProvider = {
    id: props.provider?.id || `provider-${Date.now()}`,
    provider: currentProviderType(),
    name: formData.value.name.trim(),
    apiKey: formData.value.apiKey.trim(),
    endpoint: formData.value.apiUrl.trim(),
    model: formData.value.model.trim(),
    priority: props.provider?.priority || 1,
    active: props.provider?.active ?? true,
    rateLimit: props.provider?.rateLimit || 60,
  }

  emit('save', provider)
  emit('update:open', false)
  toast.success('保存成功')
}

// 关闭
const handleClose = () => {
  emit('update:open', false)
}
</script>

<template>
  <Dialog :open="props.open" @update:open="emit('update:open', $event)">
    <DialogContent class="sm:max-w-[500px]">
      <DialogHeader>
        <DialogTitle>{{ provider ? '编辑' : '添加' }}AI配置</DialogTitle>
        <DialogDescription>
          配置AI供应商的API信息，所有字段均为必填
        </DialogDescription>
      </DialogHeader>

      <div class="grid gap-4 py-4">
        <!-- 供应商名称 -->
        <div class="grid gap-2">
          <Label for="providerType" class="required">
            供应商类型
          </Label>
          <Select :model-value="formData.providerType" @update:model-value="handleProviderTypeChange">
            <SelectTrigger id="providerType">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="option in AI_PROVIDER_OPTIONS" :key="option.value" :value="option.value">
                {{ option.label }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div class="grid gap-2">
          <Label for="name" class="required">
            供应商
          </Label>
          <Input
            id="name"
            v-model="formData.name"
            placeholder="例如: OpenAI, DeepSeek"
            :class="{ 'border-destructive': errors.name }"
          />
          <p v-if="errors.name" class="text-sm text-destructive">
            {{ errors.name }}
          </p>
        </div>

        <!-- 模型 -->
        <div class="grid gap-2">
          <Label for="model" class="required">
            模型
          </Label>
          <Input
            id="model"
            v-model="formData.model"
            placeholder="例如: gpt-4o-mini, deepseek-chat"
            :class="{ 'border-destructive': errors.model }"
          />
          <p v-if="errors.model" class="text-sm text-destructive">
            {{ errors.model }}
          </p>
        </div>

        <!-- API URL -->
        <div class="grid gap-2">
          <Label for="apiUrl" class="required">
            API URL
          </Label>
          <Input
            id="apiUrl"
            v-model="formData.apiUrl"
            placeholder="https://api.openai.com/v1"
            :class="{ 'border-destructive': errors.apiUrl }"
          />
          <p v-if="errors.apiUrl" class="text-sm text-destructive">
            {{ errors.apiUrl }}
          </p>
        </div>

        <!-- API Key -->
        <div class="grid gap-2">
          <Label for="apiKey" class="required">
            API Key
          </Label>
          <div class="relative">
            <Input
              id="apiKey"
              v-model="formData.apiKey"
              :type="showApiKey ? 'text' : 'password'"
              placeholder="sk-..."
              :class="{ 'border-destructive': errors.apiKey, 'pr-10': true }"
            />
            <button
              type="button"
              class="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              @click="toggleApiKeyVisibility"
            >
              <Eye v-if="!showApiKey" class="size-4" />
              <EyeOff v-else class="size-4" />
            </button>
          </div>
          <p v-if="errors.apiKey" class="text-sm text-destructive">
            {{ errors.apiKey }}
          </p>
        </div>

        <!-- 测试结果 -->
        <div v-if="testResult" class="rounded-lg border p-3" :class="{
          'bg-green-50 border-green-200 dark:bg-green-950 dark:border-green-800': testResult.success,
          'bg-red-50 border-red-200 dark:bg-red-950 dark:border-red-800': !testResult.success
        }">
          <p class="text-sm" :class="{
            'text-green-700 dark:text-green-300': testResult.success,
            'text-red-700 dark:text-red-300': !testResult.success
          }">
            {{ testResult.message }}
          </p>
        </div>
      </div>

      <DialogFooter class="gap-2">
        <Button
          variant="outline"
          :disabled="testing"
          @click="testApi"
        >
          <Loader2 v-if="testing" class="mr-2 size-4 animate-spin" />
          测试
        </Button>
        <Button variant="outline" @click="handleClose">
          关闭
        </Button>
        <Button @click="handleSave">
          保存
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
.required::after {
  content: " *";
  color: hsl(var(--destructive));
}
</style>
