import { convertFileSrc } from '@tauri-apps/api/core'

export function isTauriRuntime() {
  return typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__)
}

/** 判断路径是否为本地文件路径（非 http/data/blob） */
export function isLocalPath(path?: string | null): boolean {
  if (!path) return false
  const trimmed = path.trim()
  if (!trimmed) return false
  if (trimmed.startsWith('//')) return false
  return !/^(https?:|data:|blob:)/i.test(trimmed)
}

export function toImageSrc(path?: string | null): string | null {
  if (!path) return null
  const trimmed = path.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('//')) return `https:${trimmed}`
  if (/^(https?:|data:|blob:)/i.test(trimmed)) return trimmed
  if (!isTauriRuntime()) return null
  return convertFileSrc(trimmed.replace(/\\/g, '/'))
}
