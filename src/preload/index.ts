import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

export type CoreType = 'vanilla' | 'paper' | 'fabric' | 'forge'
export type ServerStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

export type ModIssueLevel = 'error' | 'warn' | 'info'
export interface ModIssue {
  level: ModIssueLevel
  code: string
  message: string
  modFile?: string
  modId?: string
}

export interface ServerProfile {
  id: string
  name: string
  core: CoreType
  version: string
  ramMb: number
  jvmArgs: string
  serverPath: string
  eulaAccepted: boolean
}

export interface PersistedState {
  profiles: ServerProfile[]
  settings?: {
    serverRoot: string
    downloadRoot: string
  }
}

export interface DownloadProgress {
  key: string
  transferred: number
  total?: number
  speedBps?: number
}

export interface ModpackInfo {
  id: string
  title: string
  description: string
  icon_url: string
  downloads: number
  author: string
  project_type: 'modpack' | 'mod'
}

export interface ModpackVersion {
  id: string
  name: string
  version_number: string
  game_versions: string[]
  loaders: string[]
  files: Array<{ url: string; filename: string; primary: boolean }>
}

export type InstallTarget = 'server' | 'client'

export interface ModProjectDetails {
  id: string
  slug: string
  title: string
  description: string
  body: string
  icon_url: string | null
  project_type: 'mod'
  downloads: number
  followers: number
  categories: string[]
  game_versions: string[]
  loaders: string[]
  client_side: 'required' | 'optional' | 'unsupported' | 'unknown'
  server_side: 'required' | 'optional' | 'unsupported' | 'unknown'
  license_id: string | null
  source_url: string | null
  issues_url: string | null
  wiki_url: string | null
  discord_url: string | null
}

export interface ModVersion {
  id: string
  name: string
  version_number: string
  game_versions: string[]
  loaders: string[]
  featured: boolean
  dependencies: Array<{
    version_id: string | null
    project_id: string | null
    dependency_type: string
  }>
  files: Array<{ url: string; filename: string; primary: boolean; sha1?: string }>
}

type Unsub = () => void

export interface AppSettings {
  serverRoot: string
  downloadRoot: string
}

export type UpdateStatus =
  | { state: 'disabled'; message: string }
  | { state: 'idle'; message: string }
  | { state: 'checking'; message: string }
  | { state: 'available'; message: string; version?: string }
  | { state: 'not-available'; message: string }
  | { state: 'downloading'; message: string; percent?: number }
  | { state: 'downloaded'; message: string; version?: string }
  | { state: 'error'; message: string }

export type UpdateRepoInfo = { owner: string; repo: string } | null

const api = {
  getState: async (): Promise<PersistedState> => await ipcRenderer.invoke('mc:state:get'),
  getSettings: async (): Promise<AppSettings> => await ipcRenderer.invoke('mc:settings:get'),
  setSettings: async (patch: Partial<AppSettings>): Promise<AppSettings> =>
    await ipcRenderer.invoke('mc:settings:set', patch),
  pickSettingPath: async (kind: 'serverRoot' | 'downloadRoot'): Promise<AppSettings> =>
    await ipcRenderer.invoke('mc:settings:pick', kind),
  getAppVersion: async (): Promise<string> => await ipcRenderer.invoke('mc:app:version'),
  uninstallApp: async (): Promise<boolean> => await ipcRenderer.invoke('mc:app:uninstall'),
  getUpdateRepo: async (): Promise<UpdateRepoInfo> => await ipcRenderer.invoke('mc:update:repo'),
  getUpdateStatus: async (): Promise<UpdateStatus> => await ipcRenderer.invoke('mc:update:get'),
  checkForUpdates: async (): Promise<boolean> => await ipcRenderer.invoke('mc:update:check'),
  quitAndInstallUpdate: async (): Promise<boolean> =>
    await ipcRenderer.invoke('mc:update:quitAndInstall'),
  listCores: async (): Promise<{ id: CoreType; label: string }[]> =>
    await ipcRenderer.invoke('mc:cores:list'),
  listVersions: async (core: CoreType): Promise<string[]> =>
    await ipcRenderer.invoke('mc:versions:list', core),
  upsertProfile: async (p: ServerProfile): Promise<PersistedState> =>
    await ipcRenderer.invoke('mc:profiles:upsert', p),
  deleteProfile: async (id: string): Promise<PersistedState> =>
    await ipcRenderer.invoke('mc:profiles:delete', id),
  selectFolder: async (initialPath?: string): Promise<string | null> =>
    await ipcRenderer.invoke('mc:path:select', initialPath),
  openPath: async (path: string): Promise<boolean> =>
    await ipcRenderer.invoke('mc:path:open', path),
  startServer: async (p: ServerProfile): Promise<boolean> =>
    await ipcRenderer.invoke('mc:server:start', p),
  stopServer: async (): Promise<boolean> => await ipcRenderer.invoke('mc:server:stop'),
  sendCommand: async (cmd: string): Promise<boolean> =>
    await ipcRenderer.invoke('mc:server:cmd', cmd),
  analyzeMods: async (p: ServerProfile): Promise<ModIssue[]> =>
    await ipcRenderer.invoke('mc:mods:analyze', p),
  searchModpacks: async (
    query: string,
    projectType: 'modpack' | 'mod' = 'modpack'
  ): Promise<ModpackInfo[]> => await ipcRenderer.invoke('mc:modpack:search', query, projectType),
  listModpackVersions: async (projectId: string): Promise<ModpackVersion[]> =>
    await ipcRenderer.invoke('mc:modpack:versions', projectId),
  installModpack: async (
    p: ServerProfile,
    v: ModpackVersion,
    target: InstallTarget = 'server'
  ): Promise<boolean> => await ipcRenderer.invoke('mc:modpack:install', p, v, target),
  getModProject: async (projectId: string): Promise<ModProjectDetails> =>
    await ipcRenderer.invoke('mc:mod:project', projectId),
  listModVersions: async (
    projectId: string,
    opts: { loaders?: string[]; gameVersions?: string[] } = {}
  ): Promise<ModVersion[]> => await ipcRenderer.invoke('mc:mod:versions', projectId, opts),
  installModVersion: async (
    p: ServerProfile,
    v: ModVersion,
    target: InstallTarget = 'server',
    opts: { withDependencies?: boolean; loader?: string; gameVersion?: string } = {}
  ): Promise<string> => await ipcRenderer.invoke('mc:mod:install', p, v, target, opts),
  backupWorld: async (p: ServerProfile, name?: string): Promise<string> =>
    await ipcRenderer.invoke('mc:backup:create', p, name),
  restoreWorld: async (p: ServerProfile, zipPath: string): Promise<void> =>
    await ipcRenderer.invoke('mc:backup:restore', p, zipPath),
  listBackups: async (
    p: ServerProfile
  ): Promise<Array<{ name: string; path: string; size: number; date: number }>> =>
    await ipcRenderer.invoke('mc:backup:list', p),
  onServerLog: (cb: (line: string) => void): Unsub => {
    const fn = (_: unknown, line: string): void => cb(line)
    ipcRenderer.on('mc:server:log', fn)
    return (): void => {
      ipcRenderer.off('mc:server:log', fn)
    }
  },
  onServerStatus: (cb: (s: ServerStatus) => void): Unsub => {
    const fn = (_: unknown, s: ServerStatus): void => cb(s)
    ipcRenderer.on('mc:server:status', fn)
    return (): void => {
      ipcRenderer.off('mc:server:status', fn)
    }
  },
  onDownloadProgress: (cb: (p: DownloadProgress) => void): Unsub => {
    const fn = (_: unknown, p: DownloadProgress): void => cb(p)
    ipcRenderer.on('mc:download:progress', fn)
    return (): void => {
      ipcRenderer.off('mc:download:progress', fn)
    }
  },
  onUpdateStatus: (cb: (s: UpdateStatus) => void): Unsub => {
    const fn = (_: unknown, s: UpdateStatus): void => cb(s)
    ipcRenderer.on('mc:update:status', fn)
    return (): void => {
      ipcRenderer.off('mc:update:status', fn)
    }
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
