import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  AppSettings,
  CoreType,
  DownloadProgress,
  ModIssue,
  PersistedState,
  ServerProfile,
  ServerStatus,
  ModpackInfo,
  ModpackVersion,
  ModProjectDetails,
  ModVersion
} from '../main/mc'

type UpdateStatus =
  | { state: 'disabled'; message: string }
  | { state: 'idle'; message: string }
  | { state: 'checking'; message: string }
  | { state: 'available'; message: string; version?: string }
  | { state: 'not-available'; message: string }
  | { state: 'downloading'; message: string; percent?: number }
  | { state: 'downloaded'; message: string; version?: string }
  | { state: 'error'; message: string }

type UpdateRepoInfo = { owner: string; repo: string } | null

type ServerProperties = {
  exists: boolean
  properties: Record<string, string>
  secretKeys: string[]
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      getState: () => Promise<PersistedState>
      getSettings: () => Promise<AppSettings>
      setSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
      pickSettingPath: (kind: 'serverRoot' | 'downloadRoot') => Promise<AppSettings>
      getAppVersion: () => Promise<string>
      uninstallApp: () => Promise<boolean>
      getUpdateStatus: () => Promise<UpdateStatus>
      getUpdateRepo: () => Promise<UpdateRepoInfo>
      checkForUpdates: () => Promise<boolean>
      quitAndInstallUpdate: () => Promise<boolean>
      listCores: () => Promise<{ id: CoreType; label: string }[]>
      listVersions: (core: CoreType) => Promise<string[]>
      upsertProfile: (p: ServerProfile) => Promise<PersistedState>
      deleteProfile: (id: string) => Promise<PersistedState>
      selectFolder: (initialPath?: string) => Promise<string | null>
      openPath: (path: string) => Promise<boolean>
      startServer: (p: ServerProfile) => Promise<boolean>
      stopServer: () => Promise<boolean>
      sendCommand: (cmd: string) => Promise<boolean>
      getServerProperties: (p: ServerProfile) => Promise<ServerProperties>
      setServerProperties: (p: ServerProfile, props: Record<string, string>) => Promise<boolean>
      analyzeMods: (p: ServerProfile) => Promise<ModIssue[]>

      searchModpacks: (query: string, projectType?: 'modpack' | 'mod') => Promise<ModpackInfo[]>
      listModpackVersions: (projectId: string) => Promise<ModpackVersion[]>
      installModpack: (
        p: ServerProfile,
        v: ModpackVersion,
        target?: 'server' | 'client'
      ) => Promise<boolean>

      getModProject: (projectId: string) => Promise<ModProjectDetails>
      listModVersions: (
        projectId: string,
        opts?: { loaders?: string[]; gameVersions?: string[] }
      ) => Promise<ModVersion[]>
      installModVersion: (
        p: ServerProfile,
        v: ModVersion,
        target?: 'server' | 'client',
        opts?: { withDependencies?: boolean; loader?: string; gameVersion?: string }
      ) => Promise<string>

      backupWorld: (p: ServerProfile, name?: string) => Promise<string>
      restoreWorld: (p: ServerProfile, zipPath: string) => Promise<void>
      listBackups: (
        p: ServerProfile
      ) => Promise<Array<{ name: string; path: string; size: number; date: number }>>

      onServerLog: (cb: (line: string) => void) => () => void
      onServerStatus: (cb: (s: ServerStatus) => void) => () => void
      onDownloadProgress: (cb: (p: DownloadProgress) => void) => () => void
      onUpdateStatus: (cb: (s: UpdateStatus) => void) => () => void
    }
  }
}
