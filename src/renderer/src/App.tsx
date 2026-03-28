import React from 'react'

type CoreType = 'vanilla' | 'paper' | 'fabric' | 'forge'

type ServerStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

type DownloadProgress = {
  key: string
  transferred: number
  total?: number
  speedBps?: number
}

type ModIssue = {
  level: 'error' | 'warn' | 'info'
  code: string
  message: string
  modFile?: string
  modId?: string
}

type ServerProfile = {
  id: string
  name: string
  core: CoreType
  version: string
  ramMb: number
  jvmArgs: string
  serverPath: string
  eulaAccepted: boolean
}

type PersistedState = {
  profiles: ServerProfile[]
}

type ModpackInfo = {
  id: string
  title: string
  description: string
  icon_url: string
  downloads: number
  author: string
  project_type: 'modpack' | 'mod'
}

type ModpackVersion = {
  id: string
  name: string
  version_number: string
  game_versions: string[]
  loaders: string[]
  files: Array<{ url: string; filename: string; primary: boolean }>
}

type InstallTarget = 'server' | 'client'

type ModProjectDetails = {
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

type ModVersion = {
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

type AppSettings = {
  serverRoot: string
  downloadRoot: string
}

type UpdateStatus =
  | { state: 'disabled'; message: string }
  | { state: 'idle'; message: string }
  | { state: 'checking'; message: string }
  | { state: 'available'; message: string; version?: string }
  | { state: 'not-available'; message: string }
  | { state: 'downloading'; message: string; percent?: number }
  | { state: 'downloaded'; message: string; version?: string }
  | { state: 'error'; message: string }

type CoreInfo = { id: CoreType; label: string }

const sanitizeFolderName = (name: string): string => {
  const trimmed = name.trim()
  if (!trimmed) return 'Server'
  const bad = '<>:"/\\|?*'
  let out = ''
  for (const ch of trimmed) {
    const code = ch.charCodeAt(0)
    if (code < 32) {
      out += '-'
      continue
    }
    out += bad.includes(ch) ? '-' : ch
  }
  return out.slice(0, 64)
}

function App(): React.JSX.Element {
  const [cores, setCores] = React.useState<CoreInfo[]>([])
  const [profiles, setProfiles] = React.useState<ServerProfile[]>([])
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [versions, setVersions] = React.useState<string[]>([])
  const [status, setStatus] = React.useState<ServerStatus>('stopped')
  const [logs, setLogs] = React.useState<string[]>([])
  const [download, setDownload] = React.useState<DownloadProgress | null>(null)
  const [cmd, setCmd] = React.useState<string>('')
  const [settings, setSettings] = React.useState<AppSettings | null>(null)
  const [updateStatus, setUpdateStatus] = React.useState<UpdateStatus | null>(null)

  const selected = React.useMemo(
    () => profiles.find((p) => p.id === selectedId) ?? null,
    [profiles, selectedId]
  )
  const selectedCore = selected?.core ?? null

  React.useEffect(() => {
    let unsubLog: () => void = () => undefined
    let unsubStatus: () => void = () => undefined
    let unsubDl: () => void = () => undefined
    let unsubUpdate: () => void = () => undefined
    ;(async () => {
      const [c, s, st] = await Promise.all([
        window.api.listCores(),
        window.api.getState(),
        window.api.getSettings()
      ])
      setCores(c as unknown as CoreInfo[])
      setProfiles((s as unknown as PersistedState).profiles)
      setSelectedId((s as unknown as PersistedState).profiles[0]?.id ?? null)
      setSettings(st as unknown as AppSettings)
      unsubLog = window.api.onServerLog((line) => setLogs((prev) => [...prev.slice(-2000), line]))
      unsubStatus = window.api.onServerStatus((st) => setStatus(st))
      unsubDl = window.api.onDownloadProgress((p) => setDownload(p))
      setUpdateStatus(await window.api.getUpdateStatus())
      unsubUpdate = window.api.onUpdateStatus((s) => setUpdateStatus(s))
    })()
    return () => {
      unsubLog()
      unsubStatus()
      unsubDl()
      unsubUpdate()
    }
  }, [])

  React.useEffect(() => {
    if (!selectedCore) return
    ;(async () => {
      const v = await window.api.listVersions(selectedCore)
      setVersions(v)
    })()
  }, [selectedCore])

  const updateSelected = (patch: Partial<ServerProfile>): void => {
    if (!selected) return
    setProfiles((prev) => prev.map((p) => (p.id === selected.id ? { ...p, ...patch } : p)))
  }

  const persistSelected = async (): Promise<void> => {
    if (!selected) return
    const s = (await window.api.upsertProfile(selected)) as PersistedState
    setProfiles(s.profiles)
  }

  const addProfile = async (): Promise<void> => {
    const id = String(Date.now())
    const name = `新伺服器 ${profiles.length + 1}`
    const folder = sanitizeFolderName(name)
    const root = settings?.serverRoot?.trim().length ? settings.serverRoot : 'C:\\MinecraftServers'
    const p: ServerProfile = {
      id,
      name,
      core: 'paper',
      version: '1.21.1',
      ramMb: 4096,
      jvmArgs: '',
      serverPath: `${root}\\${folder}`,
      eulaAccepted: false
    }
    const s = (await window.api.upsertProfile(p)) as PersistedState
    setProfiles(s.profiles)
    setSelectedId(id)
  }

  const pickSettingPath = async (kind: 'serverRoot' | 'downloadRoot'): Promise<void> => {
    const st = (await window.api.pickSettingPath(kind)) as unknown as AppSettings
    setSettings(st)
  }

  const updateSettingsLocal = (patch: Partial<AppSettings>): void => {
    setSettings((prev) => (prev ? { ...prev, ...patch } : (patch as AppSettings)))
  }

  const saveSettings = async (): Promise<void> => {
    if (!settings) return
    const st = (await window.api.setSettings(settings)) as unknown as AppSettings
    setSettings(st)
    setLogs((prev) => [...prev, '--- 已儲存設定 ---'])
  }

  const uninstallApp = async (): Promise<void> => {
    const ok = await window.api.uninstallApp()
    setLogs((prev) => [
      ...prev,
      ok ? '--- 已啟動卸載程式（稍後會關閉 App） ---' : '--- 已打開 Windows 卸載頁 ---'
    ])
  }

  const checkForUpdates = async (): Promise<void> => {
    await window.api.checkForUpdates()
  }

  const quitAndInstallUpdate = async (): Promise<void> => {
    await window.api.quitAndInstallUpdate()
  }

  const deleteProfile = async (id: string): Promise<void> => {
    const s = (await window.api.deleteProfile(id)) as PersistedState
    setProfiles(s.profiles)
    setSelectedId(s.profiles[0]?.id ?? null)
  }

  const chooseFolder = async (): Promise<void> => {
    if (!selected) return
    const p = await window.api.selectFolder(selected.serverPath)
    if (!p) return
    updateSelected({ serverPath: p })
  }

  const start = async (): Promise<void> => {
    if (!selected) return
    setLogs([])
    setDownload(null)
    const s = (await window.api.upsertProfile(selected)) as PersistedState
    setProfiles(s.profiles)
    const fresh = s.profiles.find((p) => p.id === selected.id) ?? selected
    await window.api.startServer(fresh)
  }

  const stop = async (): Promise<void> => {
    await window.api.stopServer()
  }

  const send = async (): Promise<void> => {
    const v = cmd.trim()
    if (!v) return
    setCmd('')
    await window.api.sendCommand(v)
  }

  const openFolder = async (): Promise<void> => {
    if (!selected) return
    await window.api.openPath(selected.serverPath)
  }

  const checkMods = async (): Promise<void> => {
    if (!selected) return
    const issues = (await window.api.analyzeMods(selected)) as ModIssue[]
    setLogs((prev) => [
      ...prev,
      `--- 模組檢查：${issues.length} 項 ---`,
      ...issues.map(
        (i) =>
          `${i.level.toUpperCase()} ${i.code}: ${i.message}${i.modFile ? ` (${i.modFile})` : ''}`
      )
    ])
  }

  const [searchQuery, setSearchQuery] = React.useState('')
  const [searchType, setSearchType] = React.useState<'modpack' | 'mod'>('modpack')
  const [modpacks, setModpacks] = React.useState<ModpackInfo[]>([])
  const [selectedPack, setSelectedPack] = React.useState<ModpackInfo | null>(null)
  const [packVersions, setPackVersions] = React.useState<ModpackVersion[]>([])
  const [modDetails, setModDetails] = React.useState<ModProjectDetails | null>(null)
  const [modVersions, setModVersions] = React.useState<ModVersion[]>([])
  const [modLoader, setModLoader] = React.useState<string>('')
  const [modGameVersion, setModGameVersion] = React.useState<string>('')
  const [detailError, setDetailError] = React.useState<string | null>(null)
  const [isSearching, setIsSearching] = React.useState(false)
  const [searchError, setSearchError] = React.useState<string | null>(null)
  const [installTarget, setInstallTarget] = React.useState<InstallTarget>('server')
  const [installWithDeps, setInstallWithDeps] = React.useState(true)

  const doSearch = async (): Promise<void> => {
    const q = searchQuery.trim()
    if (!q) {
      setSearchError('你要打啲字先搜尋到')
      setModpacks([])
      setSelectedPack(null)
      setPackVersions([])
      setModDetails(null)
      setModVersions([])
      return
    }
    setIsSearching(true)
    setSearchError(null)
    try {
      const res = await window.api.searchModpacks(q, searchType)
      setModpacks(res)
      setSelectedPack(null)
      setPackVersions([])
      setModDetails(null)
      setModVersions([])
      if (res.length === 0) setSearchError('搵唔到結果（試吓打英文 pack 名）')
    } finally {
      setIsSearching(false)
    }
  }

  const loadVersions = async (p: ModpackInfo): Promise<void> => {
    setSelectedPack(p)
    setDetailError(null)
    setPackVersions([])
    setModDetails(null)
    setModVersions([])
    if (p.project_type === 'modpack') {
      const vs = await window.api.listModpackVersions(p.id)
      setPackVersions(vs)
      return
    }
    const loader =
      selected?.core === 'fabric' ? 'fabric' : selected?.core === 'forge' ? 'forge' : ''
    const gv = selected?.version ?? ''
    setModLoader(loader)
    setModGameVersion(gv)
    try {
      const d = await window.api.getModProject(p.id)
      setModDetails(d)
      const opts = {
        loaders: loader ? [loader] : undefined,
        gameVersions: gv ? [gv] : undefined
      }
      const vs = await window.api.listModVersions(p.id, opts)
      setModVersions(vs)
    } catch (e) {
      setDetailError(String(e))
    }
  }

  const installPack = async (v: ModpackVersion): Promise<void> => {
    if (!selected) return
    setLogs((prev) => [...prev, `--- 開始安裝模組包：${selectedPack?.title} (${v.name}) ---`])
    try {
      await window.api.installModpack(selected, v, installTarget)
      setLogs((prev) => [...prev, `--- 模組包安裝完成 ---`])
    } catch (e) {
      setLogs((prev) => [...prev, `--- 安裝失敗：${String(e)} ---`])
    }
  }

  const refreshModVersions = async (): Promise<void> => {
    if (!selectedPack || selectedPack.project_type !== 'mod') return
    setDetailError(null)
    try {
      const opts = {
        loaders: modLoader ? [modLoader] : undefined,
        gameVersions: modGameVersion ? [modGameVersion] : undefined
      }
      const vs = await window.api.listModVersions(selectedPack.id, opts)
      setModVersions(vs)
    } catch (e) {
      setDetailError(String(e))
    }
  }

  const installMod = async (v: ModVersion): Promise<void> => {
    if (!selected) return
    setLogs((prev) => [...prev, `--- 開始安裝模組：${selectedPack?.title} (${v.name}) ---`])
    try {
      const path = await window.api.installModVersion(selected, v, installTarget, {
        withDependencies: installWithDeps,
        loader: modLoader || undefined,
        gameVersion: modGameVersion || undefined
      })
      setLogs((prev) => [...prev, `--- 安裝完成：${path} ---`])
    } catch (e) {
      setLogs((prev) => [...prev, `--- 安裝失敗：${String(e)} ---`])
    }
  }

  const [backups, setBackups] = React.useState<
    Array<{ name: string; path: string; size: number; date: number }>
  >([])

  const refreshBackups = React.useCallback(async (): Promise<void> => {
    if (!selected) return
    const res = await window.api.listBackups(selected)
    setBackups(res)
  }, [selected])

  React.useEffect(() => {
    refreshBackups()
  }, [refreshBackups])

  const doBackup = async (): Promise<void> => {
    if (!selected) return
    setLogs((prev) => [...prev, '--- 開始備份世界 ---'])
    try {
      const p = await window.api.backupWorld(selected)
      setLogs((prev) => [...prev, `--- 備份完成：${p} ---`])
      refreshBackups()
    } catch (e) {
      setLogs((prev) => [...prev, `--- 備份失敗：${String(e)} ---`])
    }
  }

  const doRestore = async (b: { path: string }): Promise<void> => {
    if (!selected) return
    if (!confirm('還原會覆蓋目前世界，確定嗎？')) return
    setLogs((prev) => [...prev, '--- 開始還原世界 ---'])
    try {
      await window.api.restoreWorld(selected, b.path)
      setLogs((prev) => [...prev, `--- 還原完成 ---`])
    } catch (e) {
      setLogs((prev) => [...prev, `--- 還原失敗：${String(e)} ---`])
    }
  }

  const [tab, setTab] = React.useState<'console' | 'modpack' | 'backup'>('console')

  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      <div style={{ width: 240, borderRight: '1px solid #2a2a2a', padding: 12, overflow: 'auto' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 10
          }}
        >
          <div style={{ fontWeight: 700 }}>伺服器</div>
          <button onClick={addProfile}>＋</button>
        </div>
        {profiles.map((p) => (
          <div
            key={p.id}
            onClick={() => setSelectedId(p.id)}
            style={{
              padding: 10,
              borderRadius: 8,
              marginBottom: 8,
              cursor: 'pointer',
              background: p.id === selectedId ? '#1f1f1f' : 'transparent',
              border: '1px solid #2a2a2a'
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{p.name}</div>
            <div style={{ fontSize: 12, opacity: 0.8 }}>
              {String(p.core).toUpperCase()} · {p.version}
            </div>
          </div>
        ))}
      </div>

      <div
        style={{
          flex: 1,
          padding: 14,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          minHeight: 0,
          overflow: 'auto'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Minecraft Server Manager</div>
          <div style={{ fontSize: 12, opacity: 0.85 }}>狀態：{status}</div>
        </div>

        {!selected ? (
          <div>未選伺服器</div>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div style={{ border: '1px solid #2a2a2a', borderRadius: 10, padding: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 10 }}>基本設定</div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '120px 1fr',
                    gap: 8,
                    alignItems: 'center'
                  }}
                >
                  <div>名稱</div>
                  <input
                    value={selected.name}
                    onChange={(e) => updateSelected({ name: e.target.value })}
                  />
                  <div>核心</div>
                  <select
                    value={selected.core}
                    onChange={(e) =>
                      updateSelected({ core: e.target.value as CoreType, version: '' })
                    }
                  >
                    {cores.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                  <div>版本</div>
                  <select
                    value={selected.version}
                    onChange={(e) => updateSelected({ version: e.target.value })}
                  >
                    {versions.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                  <div>RAM (MB)</div>
                  <input
                    type="number"
                    min={512}
                    step={256}
                    value={selected.ramMb}
                    onChange={(e) => updateSelected({ ramMb: Number(e.target.value) })}
                  />
                  <div>JVM 參數</div>
                  <input
                    value={selected.jvmArgs}
                    onChange={(e) => updateSelected({ jvmArgs: e.target.value })}
                  />
                  <div>路徑</div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      value={selected.serverPath}
                      onChange={(e) => updateSelected({ serverPath: e.target.value })}
                    />
                    <button onClick={chooseFolder}>揀</button>
                  </div>
                  <div>EULA</div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input
                      type="checkbox"
                      checked={selected.eulaAccepted}
                      onChange={(e) => updateSelected({ eulaAccepted: e.target.checked })}
                    />
                    我同意
                  </label>
                </div>

                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button onClick={persistSelected}>儲存</button>
                  <button onClick={openFolder}>開資料夾</button>
                  <button onClick={() => deleteProfile(selected.id)}>刪除</button>
                </div>

                <div style={{ marginTop: 14, borderTop: '1px solid #2a2a2a', paddingTop: 12 }}>
                  <div style={{ fontWeight: 700, marginBottom: 10 }}>全域設定</div>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '120px 1fr',
                      gap: 8,
                      alignItems: 'center'
                    }}
                  >
                    <div>預設伺服器</div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input
                        value={settings?.serverRoot ?? ''}
                        onChange={(e) => updateSettingsLocal({ serverRoot: e.target.value })}
                        placeholder="例如 D:\\MinecraftServers"
                      />
                      <button onClick={() => pickSettingPath('serverRoot')}>揀</button>
                    </div>
                    <div>下載/快取</div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input
                        value={settings?.downloadRoot ?? ''}
                        onChange={(e) => updateSettingsLocal({ downloadRoot: e.target.value })}
                        placeholder="例如 D:\\MC-Downloads"
                      />
                      <button onClick={() => pickSettingPath('downloadRoot')}>揀</button>
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                    <button onClick={saveSettings} disabled={!settings}>
                      儲存設定
                    </button>
                    <button
                      onClick={() =>
                        settings?.downloadRoot && window.api.openPath(settings.downloadRoot)
                      }
                      disabled={!settings?.downloadRoot}
                    >
                      開下載資料夾
                    </button>
                    <button onClick={checkForUpdates}>檢查更新</button>
                    {updateStatus?.state === 'downloaded' ? (
                      <button onClick={quitAndInstallUpdate}>重啟更新</button>
                    ) : null}
                    <button onClick={uninstallApp}>卸載/刪除程式</button>
                  </div>
                  {updateStatus ? (
                    <div style={{ marginTop: 8, fontSize: 12, opacity: 0.85 }}>
                      更新：{updateStatus.message}
                    </div>
                  ) : null}
                </div>
              </div>

              <div style={{ border: '1px solid #2a2a2a', borderRadius: 10, padding: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 10 }}>操作</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button onClick={start} disabled={status !== 'stopped'}>
                    Start
                  </button>
                  <button onClick={stop} disabled={status === 'stopped'}>
                    Stop
                  </button>
                  <button onClick={checkMods}>檢查模組</button>
                  <button onClick={() => setTab('console')}>控制台</button>
                  <button onClick={() => setTab('modpack')}>模組包</button>
                  <button onClick={() => setTab('backup')}>備份</button>
                </div>
                {download ? (
                  <div style={{ marginTop: 12, fontSize: 12, opacity: 0.9 }}>
                    下載：{download.key} · {Math.floor((download.transferred ?? 0) / 1024 / 1024)}MB
                    {download.total ? ` / ${Math.floor(download.total / 1024 / 1024)}MB` : ''}
                    {download.speedBps ? ` · ${Math.floor(download.speedBps / 1024)}KB/s` : ''}
                  </div>
                ) : null}
              </div>
            </div>

            <div
              style={{
                border: '1px solid #2a2a2a',
                borderRadius: 10,
                padding: 12,
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
                minHeight: 0
              }}
            >
              {tab === 'console' && (
                <>
                  <div style={{ fontWeight: 700 }}>控制台</div>
                  <div
                    style={{
                      flex: 1,
                      overflow: 'auto',
                      fontFamily:
                        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                      fontSize: 12,
                      background: '#0f0f0f',
                      border: '1px solid #2a2a2a',
                      borderRadius: 8,
                      padding: 10
                    }}
                  >
                    {logs.map((l, idx) => (
                      <div key={idx} style={{ whiteSpace: 'pre-wrap' }}>
                        {l}
                      </div>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      style={{ flex: 1 }}
                      value={cmd}
                      onChange={(e) => setCmd(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') send()
                      }}
                      placeholder="輸入指令，例如：op yourname"
                    />
                    <button onClick={send} disabled={status === 'stopped'}>
                      Send
                    </button>
                  </div>
                </>
              )}

              {tab === 'modpack' && (
                <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 10 }}>
                  <div style={{ fontWeight: 700 }}>下載 Modrinth（模組 / 模組包）</div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <select
                      value={searchType}
                      onChange={(e) => setSearchType(e.target.value as 'modpack' | 'mod')}
                    >
                      <option value="modpack">模組包</option>
                      <option value="mod">模組</option>
                    </select>
                    <input
                      style={{ flex: 1 }}
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder={searchType === 'modpack' ? '搜尋模組包...' : '搜尋模組...'}
                      onKeyDown={(e) => e.key === 'Enter' && doSearch()}
                    />
                    <button onClick={doSearch} disabled={isSearching}>
                      {isSearching ? '搜尋中...' : '搜尋'}
                    </button>
                  </div>
                  {searchError ? (
                    <div style={{ fontSize: 12, opacity: 0.75 }}>{searchError}</div>
                  ) : null}
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <div style={{ fontSize: 12, opacity: 0.75 }}>安裝到：</div>
                    <select
                      value={installTarget}
                      onChange={(e) => setInstallTarget(e.target.value as InstallTarget)}
                    >
                      <option value="server">Server 資料夾</option>
                      <option value="client">玩家資料夾</option>
                    </select>
                    <label
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        fontSize: 12,
                        opacity: 0.85
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={installWithDeps}
                        onChange={(e) => setInstallWithDeps(e.target.checked)}
                      />
                      連依賴一齊裝
                    </label>
                    {selected ? (
                      <button
                        onClick={() =>
                          window.api.openPath(
                            installTarget === 'server'
                              ? selected.serverPath
                              : `${selected.serverPath}\\client`
                          )
                        }
                      >
                        開資料夾
                      </button>
                    ) : null}
                  </div>
                  <div style={{ display: 'flex', flex: 1, gap: 12, minHeight: 0 }}>
                    <div
                      style={{
                        flex: 1,
                        overflow: 'auto',
                        border: '1px solid #2a2a2a',
                        borderRadius: 8,
                        padding: 8
                      }}
                    >
                      {modpacks.map((p) => (
                        <div
                          key={p.id}
                          onClick={() => loadVersions(p)}
                          style={{
                            padding: 8,
                            cursor: 'pointer',
                            borderBottom: '1px solid #2a2a2a',
                            background: selectedPack?.id === p.id ? '#1f1f1f' : 'transparent'
                          }}
                        >
                          <div style={{ fontWeight: 'bold' }}>{p.title}</div>
                          <div style={{ fontSize: 12, opacity: 0.8 }}>{p.description}</div>
                          <div style={{ fontSize: 11, opacity: 0.5, marginTop: 4 }}>
                            {p.project_type.toUpperCase()} | 作者: {p.author} | 下載: {p.downloads}
                          </div>
                        </div>
                      ))}
                    </div>
                    {selectedPack && (
                      <div
                        style={{
                          flex: 1,
                          overflow: 'auto',
                          border: '1px solid #2a2a2a',
                          borderRadius: 8,
                          padding: 8
                        }}
                      >
                        {selectedPack.project_type === 'modpack' ? (
                          <>
                            <div style={{ fontWeight: 'bold', marginBottom: 8 }}>
                              選擇版本安裝 ({selectedPack.title})
                            </div>
                            {packVersions.map((v) => (
                              <div
                                key={v.id}
                                style={{
                                  padding: 8,
                                  borderBottom: '1px solid #2a2a2a',
                                  display: 'flex',
                                  justifyContent: 'space-between',
                                  alignItems: 'center'
                                }}
                              >
                                <div>
                                  <div>{v.name}</div>
                                  <div style={{ fontSize: 11, opacity: 0.7 }}>
                                    支援: {v.game_versions.join(', ')} | {v.loaders.join(', ')}
                                  </div>
                                </div>
                                <button
                                  onClick={() => installPack(v)}
                                  disabled={status !== 'stopped'}
                                >
                                  安裝
                                </button>
                              </div>
                            ))}
                          </>
                        ) : (
                          <>
                            <div style={{ fontWeight: 'bold', marginBottom: 8 }}>
                              模組資料 ({selectedPack.title})
                            </div>
                            {detailError ? (
                              <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 8 }}>
                                {detailError}
                              </div>
                            ) : null}
                            {modDetails ? (
                              <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 10 }}>
                                <div style={{ marginBottom: 6 }}>{modDetails.description}</div>
                                <div style={{ opacity: 0.7 }}>
                                  Client: {modDetails.client_side} | Server:{' '}
                                  {modDetails.server_side}
                                </div>
                                <div style={{ opacity: 0.7 }}>
                                  支援 loader: {modDetails.loaders.slice(0, 8).join(', ')}
                                </div>
                                <div style={{ opacity: 0.7 }}>
                                  支援版本: {modDetails.game_versions.slice(0, 8).join(', ')}
                                </div>
                              </div>
                            ) : null}

                            <div
                              style={{
                                display: 'flex',
                                gap: 8,
                                alignItems: 'center',
                                marginBottom: 10
                              }}
                            >
                              <div style={{ fontSize: 12, opacity: 0.75 }}>Loader</div>
                              <input
                                style={{ width: 120 }}
                                value={modLoader}
                                onChange={(e) => setModLoader(e.target.value.trim())}
                                placeholder="例如 fabric"
                              />
                              <div style={{ fontSize: 12, opacity: 0.75 }}>Game</div>
                              <input
                                style={{ width: 120 }}
                                value={modGameVersion}
                                onChange={(e) => setModGameVersion(e.target.value.trim())}
                                placeholder="例如 1.20.1"
                              />
                              <button onClick={refreshModVersions}>刷新</button>
                            </div>

                            {modVersions.map((v) => (
                              <div
                                key={v.id}
                                style={{
                                  padding: 8,
                                  borderBottom: '1px solid #2a2a2a',
                                  display: 'flex',
                                  justifyContent: 'space-between',
                                  alignItems: 'center'
                                }}
                              >
                                <div>
                                  <div>
                                    {v.name} {v.featured ? '★' : ''}
                                  </div>
                                  <div style={{ fontSize: 11, opacity: 0.7 }}>
                                    {v.game_versions.join(', ')} | {v.loaders.join(', ')}
                                  </div>
                                </div>
                                <button
                                  onClick={() => installMod(v)}
                                  disabled={status !== 'stopped'}
                                >
                                  安裝
                                </button>
                              </div>
                            ))}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {tab === 'backup' && (
                <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 10 }}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center'
                    }}
                  >
                    <div style={{ fontWeight: 700 }}>世界備份</div>
                    <button onClick={doBackup} disabled={status !== 'stopped'}>
                      建立備份
                    </button>
                  </div>
                  <div
                    style={{
                      flex: 1,
                      overflow: 'auto',
                      border: '1px solid #2a2a2a',
                      borderRadius: 8,
                      padding: 8
                    }}
                  >
                    {backups.length === 0 ? <div style={{ opacity: 0.5 }}>冇備份</div> : null}
                    {backups.map((b) => (
                      <div
                        key={b.name}
                        style={{
                          padding: 12,
                          borderBottom: '1px solid #2a2a2a',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center'
                        }}
                      >
                        <div>
                          <div style={{ fontWeight: 'bold' }}>{b.name}</div>
                          <div style={{ fontSize: 12, opacity: 0.7 }}>
                            {new Date(b.date).toLocaleString()} |{' '}
                            {(b.size / 1024 / 1024).toFixed(2)} MB
                          </div>
                        </div>
                        <button onClick={() => doRestore(b)} disabled={status !== 'stopped'}>
                          還原
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default App
