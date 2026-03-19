export interface AppUpdateInfo {
  configured: boolean
  available: boolean
  currentVersion: string
  version: string | null
  body: string | null
  date: string | null
  target: string | null
}

export interface AppUpdateDownloadProgress {
  downloadedBytes: number
  totalBytes: number | null
  progress: number | null
}

export interface AppUpdateDownloadFinished {
  downloadedBytes: number
  totalBytes: number | null
}