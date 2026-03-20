import { computed } from 'vue'
import type { PreviewImage } from '@/composables/useImagePreview'
import { toImageSrc } from '@/utils/image'

interface UsePreviewGalleryOptions<TThumb = string> {
  getCoverUrl?: () => string | undefined
  getCoverImage?: () => PreviewImage | null
  getThumbs: () => TThumb[]
  createThumbImage?: (thumb: TThumb, idx: number) => PreviewImage | null
}

function createDefaultCoverImage(coverUrl?: string): PreviewImage | null {
  if (!coverUrl) return null

  const src = toImageSrc(coverUrl) ?? coverUrl
  if (!src) return null

  return { src, title: '封面' }
}

function createDefaultThumbImage(thumb: string, idx: number): PreviewImage | null {
  const src = toImageSrc(thumb) ?? thumb
  if (!src) return null

  return {
    src,
    title: `预览图 ${idx + 1}`,
  }
}

export function usePreviewGallery<TThumb = string>({
  getCoverUrl,
  getCoverImage,
  getThumbs,
  createThumbImage,
}: UsePreviewGalleryOptions<TThumb>) {
  const coverImage = computed<PreviewImage | null>(() => {
    if (getCoverImage) {
      return getCoverImage()
    }

    return createDefaultCoverImage(getCoverUrl?.())
  })

  const previewThumbs = computed<PreviewImage[]>(() => {
    return getThumbs().flatMap((thumb, idx) => {
      const image = createThumbImage
        ? createThumbImage(thumb, idx)
        : createDefaultThumbImage(String(thumb), idx)

      return image ? [image] : []
    })
  })

  const allImages = computed<PreviewImage[]>(() => {
    const images: PreviewImage[] = []
    if (coverImage.value) {
      images.push(coverImage.value)
    }

    images.push(...previewThumbs.value)
    return images
  })

  const previewStartIndex = computed(() => {
    return coverImage.value ? 1 : 0
  })

  return {
    coverImage,
    previewThumbs,
    allImages,
    previewStartIndex,
  }
}