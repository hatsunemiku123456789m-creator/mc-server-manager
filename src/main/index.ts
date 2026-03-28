import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { spawn } from 'child_process'
import { dirname, join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { autoUpdater } from 'electron-updater'
import icon from '../../resources/icon.png?asset'
import {
  getSettings,
  getWindowState,
  ManagedServer,
  analyzeMods,
  createDefaultProfile,
  defaultProfilePathAt,
  getModProject,
  installModVersion,
  installModVersionWithDependencies,
  listCores,
  listModVersions,
  listVersions,
  loadState,
  openPathInExplorer,
  readServerProperties,
  saveState,
  setSettings,
  setWindowState,
  selectFolder,
  searchModpacks,
  listModpackVersions,
  installModpack,
  backupWorld,
  restoreWorld,
  listBackups,
  writeServerProperties,
  type AppSettings,
  type CoreType,
  type DownloadProgress,
  type ModProjectDetails,
  type ModVersion,
  type ServerProfile,
  type ModpackVersion
} from './mc'

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

const parseAppUpdateRepo = (): UpdateRepoInfo => {
  try {
    const p = join(process.resourcesPath, 'app-update.yml')
    if (!existsSync(p)) return null
    const raw = readFileSync(p, 'utf-8')
    const owner = raw.match(/^\s*owner:\s*(.+)\s*$/m)?.[1]?.trim()
    const repo = raw.match(/^\s*repo:\s*(.+)\s*$/m)?.[1]?.trim()
    if (!owner || !repo) return null
    return { owner, repo }
  } catch {
    return null
  }
}

async function createWindow(): Promise<BrowserWindow> {
  // Create the browser window.
  const ws = await getWindowState()
  const bounds =
    ws?.bounds &&
    [ws.bounds.x, ws.bounds.y, ws.bounds.width, ws.bounds.height].every(Number.isFinite)
      ? ws.bounds
      : null
  const win = new BrowserWindow({
    width: bounds?.width ?? 1200,
    height: bounds?.height ?? 820,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 900,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  win.on('ready-to-show', () => {
    if (ws?.isMaximized) win.maximize()
    win.show()
  })

  win.on('close', () => {
    const isMaximized = win.isMaximized()
    const b = isMaximized ? win.getNormalBounds() : win.getBounds()
    void setWindowState({
      bounds: { x: b.x, y: b.y, width: b.width, height: b.height },
      isMaximized
    })
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  const win = await createWindow()
  const server = new ManagedServer()
  server.onLog((line) => win.webContents.send('mc:server:log', line))
  server.onStatus((s) => win.webContents.send('mc:server:status', s))

  let updateStatus: UpdateStatus = app.isPackaged
    ? { state: 'idle', message: '未檢查更新' }
    : { state: 'disabled', message: '開發模式唔支援自動更新' }

  const emitUpdateStatus = (p: UpdateStatus): void => {
    updateStatus = p
    win.webContents.send('mc:update:status', p)
  }

  if (app.isPackaged) {
    if (typeof process.env.GH_TOKEN === 'string') delete process.env.GH_TOKEN
    if (typeof process.env.GITHUB_TOKEN === 'string') delete process.env.GITHUB_TOKEN

    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true

    autoUpdater.on('checking-for-update', () =>
      emitUpdateStatus({ state: 'checking', message: '檢查更新中...' })
    )
    autoUpdater.on('update-available', (info) =>
      emitUpdateStatus({
        state: 'available',
        message: '有新版本，下載中...',
        version: info.version
      })
    )
    autoUpdater.on('update-not-available', () =>
      emitUpdateStatus({ state: 'not-available', message: '已經係最新版本' })
    )
    autoUpdater.on('download-progress', (p) =>
      emitUpdateStatus({
        state: 'downloading',
        message: `下載更新中... ${Math.floor(p.percent)}%`,
        percent: p.percent
      })
    )
    autoUpdater.on('update-downloaded', (info) =>
      emitUpdateStatus({
        state: 'downloaded',
        message: '更新已下載，重啟就會套用',
        version: info.version
      })
    )
    autoUpdater.on('error', () =>
      emitUpdateStatus({ state: 'error', message: '更新檢查失敗，請稍後再試' })
    )

    setTimeout(() => {
      void autoUpdater
        .checkForUpdates()
        .catch(() => emitUpdateStatus({ state: 'error', message: '更新檢查失敗，請稍後再試' }))
    }, 2500)
  }

  const findUninstallerPath = (): string | null => {
    const exeDir = dirname(app.getPath('exe'))
    const name = app.getName()
    const candidates = [
      `Uninstall ${name}.exe`,
      `Uninstall ${name.replace(/-/g, ' ')}.exe`,
      'Uninstall.exe',
      'uninstall.exe'
    ]
    for (const c of candidates) {
      const p = join(exeDir, c)
      if (existsSync(p)) return p
    }
    return null
  }

  ipcMain.handle('mc:state:get', async () => {
    const state = await loadState()
    if (state.profiles.length === 0) {
      const st = await getSettings()
      const p = createDefaultProfile()
      p.serverPath = defaultProfilePathAt(st.serverRoot, p.name)
      state.profiles = [p]
      await saveState(state)
    }
    return state
  })

  ipcMain.handle('mc:settings:get', async (): Promise<AppSettings> => await getSettings())

  ipcMain.handle(
    'mc:settings:set',
    async (_evt, patch: Partial<AppSettings>): Promise<AppSettings> => {
      return await setSettings(patch)
    }
  )

  ipcMain.handle(
    'mc:settings:pick',
    async (_evt, kind: 'serverRoot' | 'downloadRoot'): Promise<AppSettings> => {
      const current = await getSettings()
      const picked = await selectFolder(
        win,
        kind === 'serverRoot' ? current.serverRoot : current.downloadRoot
      )
      if (!picked) return current
      return await setSettings(
        kind === 'serverRoot' ? { serverRoot: picked } : { downloadRoot: picked }
      )
    }
  )

  ipcMain.handle('mc:app:version', async (): Promise<string> => app.getVersion())

  ipcMain.handle('mc:app:uninstall', async (): Promise<boolean> => {
    const uninstaller = findUninstallerPath()
    if (uninstaller) {
      try {
        spawn('cmd.exe', ['/c', 'start', '""', uninstaller], { detached: true, windowsHide: true })
        setTimeout(() => app.quit(), 400)
        return true
      } catch {
        return false
      }
    }
    await shell.openExternal('ms-settings:appsfeatures')
    return false
  })

  ipcMain.handle('mc:update:repo', async (): Promise<UpdateRepoInfo> => parseAppUpdateRepo())

  ipcMain.handle('mc:update:get', async (): Promise<UpdateStatus> => updateStatus)

  ipcMain.handle('mc:server:properties:get', async (_evt, profile: ServerProfile) => {
    return await readServerProperties(profile)
  })

  ipcMain.handle(
    'mc:server:properties:set',
    async (_evt, profile: ServerProfile, props: Record<string, string>): Promise<boolean> => {
      await writeServerProperties(profile, props, { keepSecretIfEmpty: true })
      return true
    }
  )

  ipcMain.handle('mc:update:check', async (): Promise<boolean> => {
    if (!app.isPackaged) {
      emitUpdateStatus({ state: 'disabled', message: '開發模式唔支援自動更新' })
      return false
    }
    try {
      await autoUpdater.checkForUpdates()
      return true
    } catch (e) {
      void e
      emitUpdateStatus({ state: 'error', message: '更新檢查失敗，請稍後再試' })
      return false
    }
  })

  ipcMain.handle('mc:update:quitAndInstall', async (): Promise<boolean> => {
    if (!app.isPackaged) return false
    try {
      autoUpdater.quitAndInstall()
      return true
    } catch (e) {
      void e
      emitUpdateStatus({ state: 'error', message: '更新套用失敗，請重新開程式再試' })
      return false
    }
  })

  ipcMain.handle('mc:cores:list', async () => listCores())

  ipcMain.handle('mc:versions:list', async (_evt, core: CoreType) => await listVersions(core))

  ipcMain.handle(
    'mc:path:select',
    async (_evt, initialPath?: string) => await selectFolder(win, initialPath)
  )

  ipcMain.handle('mc:path:open', async (_evt, path: string) => {
    await openPathInExplorer(path)
    return true
  })

  ipcMain.handle('mc:profiles:upsert', async (_evt, profile: ServerProfile) => {
    const state = await loadState()
    const idx = state.profiles.findIndex((p) => p.id === profile.id)
    const next = { ...profile, name: profile.name.trim() }
    if (idx >= 0) state.profiles[idx] = next
    else state.profiles.push(next)
    await saveState(state)
    return await loadState()
  })

  ipcMain.handle('mc:profiles:delete', async (_evt, id: string) => {
    const state = await loadState()
    state.profiles = state.profiles.filter((p) => p.id !== id)
    await saveState(state)
    return await loadState()
  })

  ipcMain.handle('mc:server:start', async (_evt, profile: ServerProfile) => {
    const key = `server-${profile.id}`
    const onProgress = (p: DownloadProgress): void =>
      win.webContents.send('mc:download:progress', p)
    await server.start(profile, { key, onProgress })
    return true
  })

  ipcMain.handle('mc:server:stop', async () => {
    await server.stop()
    return true
  })

  ipcMain.handle('mc:server:cmd', async (_evt, cmd: string) => {
    server.sendCommand(cmd)
    return true
  })

  ipcMain.handle(
    'mc:mods:analyze',
    async (_evt, profile: ServerProfile) => await analyzeMods(profile)
  )

  ipcMain.handle(
    'mc:modpack:search',
    async (_evt, query: string, projectType: 'modpack' | 'mod' = 'modpack') =>
      await searchModpacks(query, projectType)
  )
  ipcMain.handle(
    'mc:modpack:versions',
    async (_evt, projectId: string) => await listModpackVersions(projectId)
  )
  ipcMain.handle(
    'mc:modpack:install',
    async (
      _evt,
      profile: ServerProfile,
      version: ModpackVersion,
      target: 'server' | 'client' = 'server'
    ) => {
      const key = `modpack-${version.id}`
      const onProgress = (p: DownloadProgress): void =>
        win.webContents.send('mc:download:progress', p)
      await installModpack(profile, version, { key, onProgress }, target)
      return true
    }
  )

  ipcMain.handle('mc:mod:project', async (_evt, projectId: string): Promise<ModProjectDetails> => {
    return await getModProject(projectId)
  })

  ipcMain.handle(
    'mc:mod:versions',
    async (
      _evt,
      projectId: string,
      opts: { loaders?: string[]; gameVersions?: string[] } = {}
    ): Promise<ModVersion[]> => {
      return await listModVersions(projectId, opts)
    }
  )

  ipcMain.handle(
    'mc:mod:install',
    async (
      _evt,
      profile: ServerProfile,
      version: ModVersion,
      target: 'server' | 'client' = 'server',
      opts: { withDependencies?: boolean; loader?: string; gameVersion?: string } = {}
    ): Promise<string> => {
      const key = `mod-${version.id}`
      const onProgress = (p: DownloadProgress): void =>
        win.webContents.send('mc:download:progress', p)
      if (opts.withDependencies) {
        const res = await installModVersionWithDependencies(
          profile,
          version,
          { key, onProgress },
          target,
          { loader: opts.loader, gameVersion: opts.gameVersion }
        )
        return res.installed[0] ?? ''
      }
      return await installModVersion(profile, version, { key, onProgress }, target)
    }
  )

  ipcMain.handle(
    'mc:backup:create',
    async (_evt, profile: ServerProfile, name?: string) => await backupWorld(profile, name)
  )
  ipcMain.handle(
    'mc:backup:restore',
    async (_evt, profile: ServerProfile, zipPath: string) => await restoreWorld(profile, zipPath)
  )
  ipcMain.handle(
    'mc:backup:list',
    async (_evt, profile: ServerProfile) => await listBackups(profile)
  )

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
