import { app, dialog, shell, BrowserWindow } from 'electron'
import { createHash } from 'crypto'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'fs/promises'
import { createReadStream, createWriteStream, existsSync } from 'fs'
import { dirname, join } from 'path'
import { Readable } from 'stream'
import type { ReadableStream as NodeReadableStream } from 'stream/web'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import AdmZip from 'adm-zip'
import * as TOML from '@iarna/toml'
import extract from 'extract-zip'
import archiver from 'archiver'

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

export interface DownloadProgress {
  key: string
  transferred: number
  total?: number
  speedBps?: number
}

type VanillaManifest = {
  versions: Array<{ id: string; url: string }>
}

type VanillaVersionJson = {
  downloads?: {
    server?: {
      url?: string
    }
  }
}

type PaperProjectJson = {
  versions: string[]
}

type PaperVersionJson = {
  builds: number[]
}

type FabricVersionJson = Array<{ version: string; stable: boolean }>

type ForgePromosJson = {
  promos?: Record<string, string>
}

export interface AppSettings {
  serverRoot: string
  downloadRoot: string
}

interface PersistedState {
  profiles: ServerProfile[]
  settings?: Partial<AppSettings>
}

const DEFAULT_ROOT = 'C:\\MinecraftServers'
const DEFAULT_DOWNLOAD_ROOT = (): string => join(app.getPath('userData'), 'downloads')

const normalizeSettings = (s?: Partial<AppSettings>): AppSettings => {
  return {
    serverRoot:
      typeof s?.serverRoot === 'string' && s.serverRoot.trim().length ? s.serverRoot : DEFAULT_ROOT,
    downloadRoot:
      typeof s?.downloadRoot === 'string' && s.downloadRoot.trim().length
        ? s.downloadRoot
        : DEFAULT_DOWNLOAD_ROOT()
  }
}

const stateFilePath = (): string => join(app.getPath('userData'), 'mc-server-manager.state.json')

const safeJsonParse = <T>(raw: string): T | undefined => {
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

const ensureDir = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true })
}

const fileExists = async (path: string): Promise<boolean> => {
  try {
    const s = await stat(path)
    return s.isFile()
  } catch {
    return false
  }
}

const dirExists = async (path: string): Promise<boolean> => {
  try {
    const s = await stat(path)
    return s.isDirectory()
  } catch {
    return false
  }
}

const nowMs = (): number => Date.now()

const sha1 = (input: string): string => createHash('sha1').update(input).digest('hex')

const sanitizeProfileName = (name: string): string => {
  const trimmed = name.trim()
  if (trimmed.length === 0) return 'Server'
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

export const defaultProfilePath = (profileName: string): string => {
  const dirName = sanitizeProfileName(profileName)
  return join(DEFAULT_ROOT, dirName)
}

export const defaultProfilePathAt = (root: string, profileName: string): string => {
  const dirName = sanitizeProfileName(profileName)
  return join(root, dirName)
}

export const loadState = async (): Promise<PersistedState> => {
  const p = stateFilePath()
  if (!existsSync(p)) return { profiles: [], settings: normalizeSettings() }
  const raw = await readFile(p, 'utf-8')
  const parsed = safeJsonParse<PersistedState>(raw)
  if (!parsed || !Array.isArray(parsed.profiles))
    return { profiles: [], settings: normalizeSettings() }
  return {
    profiles: parsed.profiles.filter((p) => p && typeof p.id === 'string'),
    settings: normalizeSettings(parsed.settings)
  }
}

export const saveState = async (next: PersistedState): Promise<void> => {
  const p = stateFilePath()
  await ensureDir(dirname(p))
  const normalized: PersistedState = {
    profiles: next.profiles ?? [],
    settings: normalizeSettings(next.settings)
  }
  await writeFile(p, JSON.stringify(normalized, null, 2), 'utf-8')
}

export const getSettings = async (): Promise<AppSettings> => {
  const s = await loadState()
  return normalizeSettings(s.settings)
}

export const setSettings = async (patch: Partial<AppSettings>): Promise<AppSettings> => {
  const s = await loadState()
  const next: PersistedState = {
    profiles: s.profiles,
    settings: { ...(s.settings ?? {}), ...(patch ?? {}) }
  }
  await saveState(next)
  return normalizeSettings(next.settings)
}

export const createDefaultProfile = (): ServerProfile => {
  const id = sha1(String(nowMs()))
  const name = '新伺服器'
  return {
    id,
    name,
    core: 'paper',
    version: '1.21.1',
    ramMb: 4096,
    jvmArgs: '',
    serverPath: defaultProfilePath(name),
    eulaAccepted: false
  }
}

const textLineSplitter = (() => {
  let buffer = ''
  return (chunk: Buffer, onLine: (line: string) => void): void => {
    buffer += chunk.toString('utf-8')
    for (;;) {
      const idx = buffer.indexOf('\n')
      if (idx < 0) break
      const line = buffer.slice(0, idx).replace(/\r$/, '')
      buffer = buffer.slice(idx + 1)
      onLine(line)
    }
  }
})()

export const selectFolder = async (
  window: BrowserWindow | null,
  initialPath?: string
): Promise<string | null> => {
  const options = {
    properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
    defaultPath: initialPath || DEFAULT_ROOT
  }
  const res = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options)
  if (res.canceled || res.filePaths.length === 0) return null
  return res.filePaths[0]
}

export const openPathInExplorer = async (path: string): Promise<void> => {
  await shell.openPath(path)
}

type DownloadHooks = {
  onProgress?: (p: DownloadProgress) => void
}

const downloadToFile = async (
  url: string,
  destPath: string,
  hooks: DownloadHooks & { key: string }
): Promise<void> => {
  await ensureDir(dirname(destPath))
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`下載失敗：${res.status} ${res.statusText}`)

  const total = res.headers.get('content-length')
    ? Number(res.headers.get('content-length'))
    : undefined
  const out = createWriteStream(destPath)

  let transferred = 0
  let lastAt = nowMs()
  let lastBytes = 0

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const nodeStream = Readable.fromWeb(res.body as unknown as NodeReadableStream<Uint8Array>)
    nodeStream.on('data', (chunk: Buffer) => {
      transferred += chunk.length
      const at = nowMs()
      const deltaMs = at - lastAt
      if (deltaMs >= 500) {
        const speedBps = Math.max(0, Math.floor(((transferred - lastBytes) * 1000) / deltaMs))
        lastAt = at
        lastBytes = transferred
        hooks.onProgress?.({ key: hooks.key, transferred, total, speedBps })
      }
    })
    nodeStream.on('error', rejectPromise)
    out.on('error', rejectPromise)
    out.on('finish', resolvePromise)
    nodeStream.pipe(out)
  })

  hooks.onProgress?.({ key: hooks.key, transferred, total, speedBps: 0 })
}

const parseMcVersion = (
  version: string
): { major: number; minor: number; patch: number } | null => {
  const m = version.trim().match(/^(\d+)\.(\d+)(?:\.(\d+))?/)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] ?? '0') }
}

const gteVersion = (a: string, b: string): boolean => {
  const pa = parseMcVersion(a)
  const pb = parseMcVersion(b)
  if (!pa || !pb) return false
  if (pa.major !== pb.major) return pa.major > pb.major
  if (pa.minor !== pb.minor) return pa.minor > pb.minor
  return pa.patch >= pb.patch
}

const requiredJavaMajorForMc = (mcVersion: string): 17 | 21 => {
  if (gteVersion(mcVersion, '1.20.5')) return 21
  return 17
}

const bundledJavaRoot = (downloadRoot: string, major: number): string =>
  join(downloadRoot, 'jre', String(major))

const bundledJavaExe = (downloadRoot: string, major: number): string =>
  join(bundledJavaRoot(downloadRoot, major), 'bin', 'java.exe')

const ensureBundledJava = async (
  major: 17 | 21,
  downloadRoot: string,
  hooks?: DownloadHooks & { key: string }
): Promise<string> => {
  const exe = bundledJavaExe(downloadRoot, major)
  if (await fileExists(exe)) return exe

  await ensureDir(bundledJavaRoot(downloadRoot, major))
  const url = `https://api.adoptium.net/v3/binary/latest/${major}/ga/windows/x64/jre/hotspot/normal/eclipse?project=jdk`
  const zipPath = join(app.getPath('temp'), `temurin-jre-${major}.zip`)
  await downloadToFile(url, zipPath, {
    key: hooks?.key ?? `java-${major}`,
    onProgress: hooks?.onProgress
  })

  const extractTo = join(app.getPath('temp'), `temurin-jre-${major}-extract`)
  await ensureDir(extractTo)
  await extract(zipPath, { dir: extractTo })

  const entries = await readdir(extractTo)
  const top =
    entries.find((e) => e.toLowerCase().includes('jre') || e.toLowerCase().includes('jdk')) ??
    entries[0]
  if (!top) throw new Error('Java 解壓後搵唔到內容')

  const src = join(extractTo, top)
  const dst = bundledJavaRoot(downloadRoot, major)
  await copyDir(src, dst)

  if (!(await fileExists(exe))) throw new Error('Java 安裝失敗：搵唔到 java.exe')
  return exe
}

const copyDir = async (src: string, dst: string): Promise<void> => {
  await ensureDir(dst)
  const items = await readdir(src, { withFileTypes: true })
  for (const item of items) {
    const from = join(src, item.name)
    const to = join(dst, item.name)
    if (item.isDirectory()) {
      await copyDir(from, to)
      continue
    }
    const data = await readFile(from)
    await ensureDir(dirname(to))
    await writeFile(to, data)
  }
}

type Cached<T> = { at: number; value: T }

let vanillaManifestCache: Cached<VanillaManifest> | null = null
let paperVersionsCache: Cached<string[]> | null = null
let fabricGameVersionsCache: Cached<string[]> | null = null
let forgePromosCache: Cached<ForgePromosJson> | null = null

const cacheValid = (c: { at: number } | null, ttlMs: number): boolean =>
  !!c && nowMs() - c.at < ttlMs

export const listCores = (): { id: CoreType; label: string }[] => [
  { id: 'vanilla', label: 'Vanilla（原版）' },
  { id: 'paper', label: 'Paper（插件）' },
  { id: 'fabric', label: 'Fabric（模組）' },
  { id: 'forge', label: 'Forge（模組）' }
]

export const listVersions = async (core: CoreType): Promise<string[]> => {
  if (core === 'vanilla') return await listVanillaVersions()
  if (core === 'paper') return await listPaperVersions()
  if (core === 'fabric') return await listFabricGameVersions()
  if (core === 'forge') return await listForgeGameVersions()
  return []
}

const listVanillaVersions = async (): Promise<string[]> => {
  const cache = vanillaManifestCache
  if (cache && cacheValid(cache, 10 * 60_000)) return cache.value.versions.map((v) => v.id)
  const url = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
  const res = await fetch(url)
  if (!res.ok) throw new Error('讀取 Vanilla 版本列表失敗')
  const json = (await res.json()) as unknown
  const manifest = json as VanillaManifest
  if (!manifest || !Array.isArray(manifest.versions)) throw new Error('Vanilla manifest 格式唔啱')
  vanillaManifestCache = { at: nowMs(), value: manifest }
  return manifest.versions.map((v) => v.id)
}

const listPaperVersions = async (): Promise<string[]> => {
  if (paperVersionsCache && cacheValid(paperVersionsCache, 10 * 60_000))
    return paperVersionsCache.value
  const res = await fetch('https://api.papermc.io/v2/projects/paper')
  if (!res.ok) throw new Error('讀取 Paper 版本列表失敗')
  const json = (await res.json()) as PaperProjectJson
  const versions = (json.versions ?? []).slice().reverse()
  paperVersionsCache = { at: nowMs(), value: versions }
  return versions
}

const listFabricGameVersions = async (): Promise<string[]> => {
  if (fabricGameVersionsCache && cacheValid(fabricGameVersionsCache, 10 * 60_000)) {
    return fabricGameVersionsCache.value
  }
  const res = await fetch('https://meta.fabricmc.net/v2/versions/game')
  if (!res.ok) throw new Error('讀取 Fabric 遊戲版本列表失敗')
  const json = (await res.json()) as FabricVersionJson
  const versions = json
    .filter((v) => v.stable)
    .map((v) => v.version)
    .slice()
  fabricGameVersionsCache = { at: nowMs(), value: versions }
  return versions
}

const listForgeGameVersions = async (): Promise<string[]> => {
  const promos = await getForgePromos()
  const keys = Object.keys(promos.promos ?? {})
  const gameVersions = new Set<string>()
  for (const k of keys) {
    const m = k.match(/^(\d+\.\d+(?:\.\d+)?)-(?:latest|recommended)$/)
    if (m) gameVersions.add(m[1])
  }
  return Array.from(gameVersions).sort((a, b) => (gteVersion(a, b) ? -1 : 1))
}

const getForgePromos = async (): Promise<ForgePromosJson> => {
  const cache = forgePromosCache
  if (cache && cacheValid(cache, 10 * 60_000)) return cache.value
  const res = await fetch(
    'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json'
  )
  if (!res.ok) throw new Error('讀取 Forge promos 失敗')
  const json = (await res.json()) as unknown
  const promos = json as ForgePromosJson
  forgePromosCache = { at: nowMs(), value: promos }
  return promos
}

const forgeInstallerUrlForGameVersion = async (mcVersion: string): Promise<string | null> => {
  const promos = await getForgePromos()
  const latest = promos.promos?.[`${mcVersion}-latest`]
  const recommended = promos.promos?.[`${mcVersion}-recommended`]
  const forgeVer = recommended ?? latest
  if (!forgeVer) return null
  const full = `${mcVersion}-${forgeVer}`
  return `https://maven.minecraftforge.net/net/minecraftforge/forge/${full}/forge-${full}-installer.jar`
}

const ensureEula = async (profile: ServerProfile): Promise<void> => {
  await ensureDir(profile.serverPath)
  if (!profile.eulaAccepted) return
  const p = join(profile.serverPath, 'eula.txt')
  await writeFile(p, 'eula=true\n', 'utf-8')
}

const vanillaServerJarPath = (profile: ServerProfile): string =>
  join(profile.serverPath, 'server.jar')
const paperServerJarPath = (profile: ServerProfile): string => join(profile.serverPath, 'paper.jar')
const fabricServerJarPath = (profile: ServerProfile): string =>
  join(profile.serverPath, 'fabric-server-launch.jar')

const forgeMarkerPath = (profile: ServerProfile): string =>
  join(profile.serverPath, '.forge-installed.json')

export const prepareServer = async (
  profile: ServerProfile,
  hooks: DownloadHooks & { key: string }
): Promise<{
  javaExe: string
  launch: { kind: 'java-jar'; jarPath: string } | { kind: 'cmd-bat'; batPath: string }
}> => {
  await ensureDir(profile.serverPath)
  await ensureEula(profile)

  const settings = await getSettings()
  const javaMajor = requiredJavaMajorForMc(profile.version)
  const javaExe = await ensureBundledJava(javaMajor, settings.downloadRoot, hooks)

  if (profile.core === 'vanilla') {
    const jarPath = vanillaServerJarPath(profile)
    if (!(await fileExists(jarPath))) {
      const manifest = await getVanillaManifest()
      const ver = manifest.versions.find((v) => v.id === profile.version)
      if (!ver) throw new Error('搵唔到呢個 Vanilla 版本')
      const vRes = await fetch(ver.url)
      if (!vRes.ok) throw new Error('讀取 Vanilla 版本資料失敗')
      const vJson = (await vRes.json()) as VanillaVersionJson
      const dl = vJson.downloads?.server?.url
      if (!dl) throw new Error('呢個 Vanilla 版本冇 server 下載連結')
      await downloadToFile(dl, jarPath, { key: hooks.key, onProgress: hooks.onProgress })
    }
    return { javaExe, launch: { kind: 'java-jar', jarPath } }
  }

  if (profile.core === 'paper') {
    const jarPath = paperServerJarPath(profile)
    if (!(await fileExists(jarPath))) {
      const build = await getPaperLatestBuild(profile.version)
      const url = `https://api.papermc.io/v2/projects/paper/versions/${profile.version}/builds/${build}/downloads/paper-${profile.version}-${build}.jar`
      await downloadToFile(url, jarPath, { key: hooks.key, onProgress: hooks.onProgress })
    }
    return { javaExe, launch: { kind: 'java-jar', jarPath } }
  }

  if (profile.core === 'fabric') {
    const jarPath = fabricServerJarPath(profile)
    if (!(await fileExists(jarPath))) {
      const loader = await getFabricLatestLoader()
      const installer = await getFabricLatestInstaller()
      const url = `https://meta.fabricmc.net/v2/versions/loader/${profile.version}/${loader}/${installer}/server/jar`
      await downloadToFile(url, jarPath, { key: hooks.key, onProgress: hooks.onProgress })
    }
    return { javaExe, launch: { kind: 'java-jar', jarPath } }
  }

  if (profile.core === 'forge') {
    const markerRaw = existsSync(forgeMarkerPath(profile))
      ? await readFile(forgeMarkerPath(profile), 'utf-8')
      : ''
    const marker = safeJsonParse<{ mcVersion: string }>(markerRaw)
    const needInstall = !marker || marker.mcVersion !== profile.version
    if (needInstall) {
      const url = await forgeInstallerUrlForGameVersion(profile.version)
      if (!url) throw new Error('Forge：搵唔到呢個遊戲版本嘅 installer（可能太新/太舊）')
      const installerPath = join(profile.serverPath, `forge-${profile.version}-installer.jar`)
      await downloadToFile(url, installerPath, { key: hooks.key, onProgress: hooks.onProgress })

      await runProcess(
        javaExe,
        ['-jar', installerPath, '--installServer'],
        profile.serverPath,
        () => {}
      )

      await writeFile(
        forgeMarkerPath(profile),
        JSON.stringify({ mcVersion: profile.version }, null, 2),
        'utf-8'
      )
    }

    const runBat = join(profile.serverPath, 'run.bat')
    if (await fileExists(runBat)) {
      return { javaExe, launch: { kind: 'cmd-bat', batPath: runBat } }
    }

    const legacyJar = await findFirstFile(
      profile.serverPath,
      (p) => /forge-.*-server\.jar$/i.test(p) || /forge-.*-universal\.jar$/i.test(p)
    )
    if (legacyJar) {
      return { javaExe, launch: { kind: 'java-jar', jarPath: legacyJar } }
    }

    throw new Error('Forge：安裝完搵唔到 run.bat 或 server jar')
  }

  throw new Error('未支援嘅 core')
}

const getVanillaManifest = async (): Promise<VanillaManifest> => {
  const cache = vanillaManifestCache
  if (cache && cacheValid(cache, 10 * 60_000)) return cache.value
  await listVanillaVersions()
  if (!vanillaManifestCache) throw new Error('Vanilla manifest 未載入')
  return vanillaManifestCache.value
}

const getPaperLatestBuild = async (mcVersion: string): Promise<number> => {
  const res = await fetch(`https://api.papermc.io/v2/projects/paper/versions/${mcVersion}`)
  if (!res.ok) throw new Error('讀取 Paper build 失敗')
  const json = (await res.json()) as PaperVersionJson
  const builds = (json.builds ?? []).slice().sort((a, b) => b - a)
  const b = builds[0]
  if (!b) throw new Error('呢個 Paper 版本冇 build')
  return b
}

const getFabricLatestLoader = async (): Promise<string> => {
  const res = await fetch('https://meta.fabricmc.net/v2/versions/loader')
  if (!res.ok) throw new Error('讀取 Fabric loader 失敗')
  const json = (await res.json()) as FabricVersionJson
  const stable = json.find((v) => v.stable) ?? json[0]
  if (!stable) throw new Error('搵唔到 Fabric loader')
  return stable.version
}

const getFabricLatestInstaller = async (): Promise<string> => {
  const res = await fetch('https://meta.fabricmc.net/v2/versions/installer')
  if (!res.ok) throw new Error('讀取 Fabric installer 失敗')
  const json = (await res.json()) as FabricVersionJson
  const stable = json.find((v) => v.stable) ?? json[0]
  if (!stable) throw new Error('搵唔到 Fabric installer')
  return stable.version
}

const runProcess = async (
  exe: string,
  args: string[],
  cwd: string,
  onLine: (line: string) => void
): Promise<number> => {
  const cp = spawn(exe, args, { cwd, windowsHide: true })
  cp.stdout.on('data', (b) => textLineSplitter(b as Buffer, onLine))
  cp.stderr.on('data', (b) => textLineSplitter(b as Buffer, (l) => onLine(l)))
  return await new Promise<number>((resolvePromise, rejectPromise) => {
    cp.on('error', rejectPromise)
    cp.on('close', (code) => resolvePromise(code ?? 0))
  })
}

const findFirstFile = async (
  root: string,
  pred: (fullPath: string) => boolean
): Promise<string | null> => {
  const stack: string[] = [root]
  while (stack.length) {
    const dir = stack.pop()!
    let entries: string[] = []
    try {
      entries = await readdir(dir)
    } catch {
      continue
    }
    for (const e of entries) {
      const full = join(dir, e)
      let s
      try {
        s = await stat(full)
      } catch {
        continue
      }
      if (s.isDirectory()) {
        stack.push(full)
        continue
      }
      if (s.isFile() && pred(full)) return full
    }
  }
  return null
}

export type SmokeTestResult = {
  ok: boolean
  reason: string
  lines: string[]
}

export const smokeTestServer = async (
  profile: ServerProfile,
  hooks: DownloadHooks & { key: string }
): Promise<SmokeTestResult> => {
  if (!profile.eulaAccepted) {
    return { ok: false, reason: '未同意 EULA（要勾咗先可以試跑）', lines: [] }
  }

  const prepared = await prepareServer(profile, hooks)
  const xms = Math.min(1024, Math.max(256, Math.floor(profile.ramMb / 4)))
  const baseArgs = [`-Xms${xms}M`, `-Xmx${profile.ramMb}M`]
  const extraArgs = profile.jvmArgs.trim().length ? profile.jvmArgs.trim().split(/\s+/) : []

  const lines: string[] = []
  let done = false
  let failed = false
  let reason = ''

  const createSplitter = (): ((chunk: Buffer, onLine: (line: string) => void) => void) => {
    let buffer = ''
    return (chunk: Buffer, onLine: (line: string) => void): void => {
      buffer += chunk.toString('utf-8')
      for (;;) {
        const idx = buffer.indexOf('\n')
        if (idx < 0) break
        const line = buffer.slice(0, idx).replace(/\r$/, '')
        buffer = buffer.slice(idx + 1)
        onLine(line)
      }
    }
  }

  const handleLine = (line: string): void => {
    lines.push(line)
    if (lines.length > 2000) lines.splice(0, lines.length - 2000)

    if (!done && /Done \([0-9.]+s\)!/i.test(line)) {
      done = true
      reason = '啟動成功（見到 Done）'
    }
    if (
      !failed &&
      /(ModLoadingException|Mixin apply failed|java\.lang\.[A-Za-z]+Error|NoSuchMethodError|ClassNotFoundException)/i.test(
        line
      )
    ) {
      failed = true
      reason = '疑似模組衝突/缺依賴（見到關鍵錯誤）'
    }
    if (!failed && /Exception in thread|Caused by:/i.test(line)) {
      failed = true
      reason = '啟動時拋出 Exception'
    }
  }

  let cp: ChildProcessWithoutNullStreams
  if (prepared.launch.kind === 'java-jar') {
    const args = [...baseArgs, ...extraArgs, '-jar', prepared.launch.jarPath, 'nogui']
    cp = spawn(prepared.javaExe, args, { cwd: profile.serverPath, windowsHide: true })
  } else {
    const args = ['/c', prepared.launch.batPath, 'nogui']
    cp = spawn('cmd.exe', args, { cwd: profile.serverPath, windowsHide: true })
  }

  const splitOut = createSplitter()
  const splitErr = createSplitter()
  cp.stdout.on('data', (b) => splitOut(b as Buffer, handleLine))
  cp.stderr.on('data', (b) => splitErr(b as Buffer, handleLine))

  const exitCode = await Promise.race<number>([
    new Promise<number>((resolvePromise) => cp.on('close', (code) => resolvePromise(code ?? 0))),
    new Promise<number>((resolvePromise) => {
      const iv = setInterval(() => {
        if (!done && !failed) return
        clearInterval(iv)
        resolvePromise(-2)
      }, 200)
      cp.on('close', () => clearInterval(iv))
    }),
    new Promise<number>((resolvePromise) => setTimeout(() => resolvePromise(-1), 60_000))
  ])

  if (done || failed) {
    try {
      cp.stdin.write('stop\n')
    } catch (e) {
      void e
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10_000))
    try {
      cp.kill()
    } catch (e) {
      void e
    }
  } else {
    try {
      cp.kill()
    } catch (e) {
      void e
    }
    reason = exitCode === -1 ? '超時（60 秒內未見到 Done）' : `提早退出（exit code=${exitCode}）`
  }

  if (failed) return { ok: false, reason, lines }
  if (done) return { ok: true, reason, lines }
  return { ok: false, reason, lines }
}

export class ManagedServer {
  private status: ServerStatus = 'stopped'
  private proc: ChildProcessWithoutNullStreams | null = null
  private profileId: string | null = null
  private logListeners: ((line: string) => void)[] = []
  private statusListeners: ((s: ServerStatus) => void)[] = []

  onLog(cb: (line: string) => void): () => void {
    this.logListeners.push(cb)
    return () => {
      this.logListeners = this.logListeners.filter((x) => x !== cb)
    }
  }

  onStatus(cb: (s: ServerStatus) => void): () => void {
    this.statusListeners.push(cb)
    return () => {
      this.statusListeners = this.statusListeners.filter((x) => x !== cb)
    }
  }

  getStatus(): ServerStatus {
    return this.status
  }

  getProfileId(): string | null {
    return this.profileId
  }

  private setStatus(s: ServerStatus): void {
    this.status = s
    for (const cb of this.statusListeners) cb(s)
  }

  private emitLog(line: string): void {
    for (const cb of this.logListeners) cb(line)
  }

  async start(profile: ServerProfile, hooks: DownloadHooks & { key: string }): Promise<void> {
    if (this.proc) throw new Error('已經有伺服器喺度跑緊')
    this.profileId = profile.id
    this.setStatus('starting')

    const prepared = await prepareServer(profile, hooks)
    const xms = Math.min(1024, Math.max(256, Math.floor(profile.ramMb / 4)))
    const baseArgs = [`-Xms${xms}M`, `-Xmx${profile.ramMb}M`]
    const extraArgs = profile.jvmArgs.trim().length ? profile.jvmArgs.trim().split(/\s+/) : []

    if (prepared.launch.kind === 'java-jar') {
      const args = [...baseArgs, ...extraArgs, '-jar', prepared.launch.jarPath, 'nogui']
      this.proc = spawn(prepared.javaExe, args, { cwd: profile.serverPath, windowsHide: true })
    } else {
      const args = ['/c', prepared.launch.batPath, 'nogui']
      this.proc = spawn('cmd.exe', args, { cwd: profile.serverPath, windowsHide: true })
    }

    this.proc.stdout.on('data', (b) => textLineSplitter(b as Buffer, (l) => this.emitLog(l)))
    this.proc.stderr.on('data', (b) => textLineSplitter(b as Buffer, (l) => this.emitLog(l)))
    this.proc.on('close', (code) => {
      this.emitLog(`(已結束，exit code=${code ?? 0})`)
      this.proc = null
      this.profileId = null
      this.setStatus('stopped')
    })
    this.proc.on('error', (err) => {
      this.emitLog(`(啟動失敗：${String(err)})`)
      this.proc = null
      this.profileId = null
      this.setStatus('error')
    })

    this.setStatus('running')
  }

  async stop(forceAfterMs = 15_000): Promise<void> {
    if (!this.proc) return
    this.setStatus('stopping')
    try {
      this.proc.stdin.write('stop\n')
    } catch (e) {
      void e
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, forceAfterMs))
    if (this.proc) {
      try {
        this.proc.kill()
      } catch (e) {
        void e
      }
    }
  }

  sendCommand(command: string): void {
    if (!this.proc) throw new Error('伺服器未啟動')
    this.proc.stdin.write(`${command.trim()}\n`)
  }
}

export const analyzeMods = async (profile: ServerProfile): Promise<ModIssue[]> => {
  const modsDir = join(profile.serverPath, 'mods')
  if (!(await dirExists(modsDir)))
    return [{ level: 'info', code: 'NO_MODS_DIR', message: 'mods 資料夾未存在' }]
  const files = (await readdir(modsDir)).filter((f) => f.toLowerCase().endsWith('.jar'))
  if (files.length === 0)
    return [{ level: 'info', code: 'NO_MODS', message: 'mods 資料夾入面冇 .jar' }]

  const issues: ModIssue[] = []
  const seenIds = new Map<string, string>()
  const availableIds = new Set<string>()
  const fabricMeta: {
    file: string
    id: string
    depends: Record<string, unknown>
    breaks: Record<string, unknown>
  }[] = []
  const forgeDeps: {
    file: string
    modId: string
    deps: { modId: string; mandatory: boolean }[]
  }[] = []

  for (const f of files) {
    const full = join(modsDir, f)
    let zip: AdmZip
    try {
      zip = new AdmZip(full)
    } catch {
      issues.push({
        level: 'warn',
        code: 'BAD_JAR',
        message: '讀唔到呢個 jar（可能壞檔）',
        modFile: f
      })
      continue
    }

    const fabricEntry = zip.getEntry('fabric.mod.json')
    if (fabricEntry) {
      const raw = fabricEntry.getData().toString('utf-8')
      const meta = safeJsonParse<unknown>(raw)
      const metaObj = meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : null
      const id = metaObj?.id
      if (typeof id === 'string' && id.length) {
        availableIds.add(id)
        if (seenIds.has(id)) {
          issues.push({
            level: 'error',
            code: 'DUPLICATE_MOD_ID',
            message: `Fabric：同一個 mod id 出現咗兩次：${id}`,
            modFile: f,
            modId: id
          })
        } else {
          seenIds.set(id, f)
        }
        const depends =
          metaObj?.depends && typeof metaObj.depends === 'object'
            ? (metaObj.depends as Record<string, unknown>)
            : {}
        const breaks =
          metaObj?.breaks && typeof metaObj.breaks === 'object'
            ? (metaObj.breaks as Record<string, unknown>)
            : {}
        fabricMeta.push({ file: f, id, depends, breaks })
      } else {
        issues.push({
          level: 'warn',
          code: 'NO_MOD_ID',
          message: 'Fabric：搵唔到 mod id',
          modFile: f
        })
      }
      continue
    }

    const tomlEntry = zip.getEntry('META-INF/mods.toml')
    if (tomlEntry) {
      const raw = tomlEntry.getData().toString('utf-8')
      let doc: unknown
      try {
        doc = TOML.parse(raw) as unknown
      } catch {
        issues.push({
          level: 'warn',
          code: 'BAD_TOML',
          message: 'Forge：mods.toml 解析失敗',
          modFile: f
        })
        continue
      }

      const docObj = doc && typeof doc === 'object' ? (doc as Record<string, unknown>) : null
      const mods =
        docObj && Array.isArray(docObj.mods) ? (docObj.mods as Array<Record<string, unknown>>) : []
      const modId = mods[0]?.modId
      if (typeof modId === 'string' && modId.length) {
        availableIds.add(modId)
        if (seenIds.has(modId)) {
          issues.push({
            level: 'error',
            code: 'DUPLICATE_MOD_ID',
            message: `Forge：同一個 mod id 出現咗兩次：${modId}`,
            modFile: f,
            modId
          })
        } else {
          seenIds.set(modId, f)
        }

        const depsRoot =
          docObj?.dependencies && typeof docObj.dependencies === 'object'
            ? (docObj.dependencies as Record<string, unknown>)
            : null
        const depsBlocks = depsRoot?.[modId]
        const depsArr = Array.isArray(depsBlocks)
          ? (depsBlocks as Array<Record<string, unknown>>)
          : []
        const deps = depsArr
          .filter((d) => d && typeof d.modId === 'string')
          .map((d) => ({ modId: String(d.modId), mandatory: Boolean(d.mandatory) }))
        forgeDeps.push({ file: f, modId, deps })
      } else {
        issues.push({
          level: 'warn',
          code: 'NO_MOD_ID',
          message: 'Forge：搵唔到 modId',
          modFile: f
        })
      }
      continue
    }

    issues.push({
      level: 'info',
      code: 'UNKNOWN_MOD_FORMAT',
      message: '搵唔到 Fabric/Forge metadata（可能係其他 loader）',
      modFile: f
    })
  }

  for (const m of fabricMeta) {
    const deps = m.depends ?? {}
    for (const [depId] of Object.entries(deps)) {
      if (depId === 'minecraft' || depId === 'java') continue
      if (!availableIds.has(depId)) {
        issues.push({
          level: 'error',
          code: 'MISSING_DEP',
          message: `Fabric：缺少依賴 mod：${depId}`,
          modFile: m.file,
          modId: m.id
        })
      }
    }
    const br = m.breaks ?? {}
    for (const [badId] of Object.entries(br)) {
      if (availableIds.has(badId)) {
        issues.push({
          level: 'warn',
          code: 'BREAKS_DEP',
          message: `Fabric：呢個 mod 聲明同 ${badId} 會衝突`,
          modFile: m.file,
          modId: m.id
        })
      }
    }
  }

  for (const m of forgeDeps) {
    for (const d of m.deps) {
      if (!d.mandatory) continue
      if (d.modId === 'minecraft' || d.modId === 'forge') continue
      if (!availableIds.has(d.modId)) {
        issues.push({
          level: 'error',
          code: 'MISSING_DEP',
          message: `Forge：缺少依賴 mod：${d.modId}`,
          modFile: m.file,
          modId: m.modId
        })
      }
    }
  }

  return issues
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

type ModrinthSearchHit = {
  project_id: string
  title: string
  description: string
  icon_url: string
  downloads: number
  author: string
  project_type: 'modpack' | 'mod'
}

type ModrinthSearchResponse = {
  hits?: ModrinthSearchHit[]
}

const modrinthFetch = async (url: string): Promise<Response> => {
  return await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'mc-server-manager/1.0.0'
    }
  })
}

export const searchModpacks = async (
  query: string,
  projectType: 'modpack' | 'mod' = 'modpack'
): Promise<ModpackInfo[]> => {
  const q = query.trim()
  if (!q) return []
  const url = new URL('https://api.modrinth.com/v2/search')
  url.searchParams.set('query', q)
  url.searchParams.set('facets', JSON.stringify([[`project_type:${projectType}`]]))
  url.searchParams.set('limit', '20')
  const res = await modrinthFetch(url.toString())
  if (!res.ok) throw new Error('搜尋失敗')
  const json = (await res.json()) as ModrinthSearchResponse
  return (json.hits ?? []).map((h) => ({
    id: h.project_id,
    title: h.title,
    description: h.description,
    icon_url: h.icon_url,
    downloads: h.downloads,
    author: h.author,
    project_type: h.project_type
  }))
}

export const listModpackVersions = async (projectId: string): Promise<ModpackVersion[]> => {
  const res = await fetch(`https://api.modrinth.com/v2/project/${projectId}/version`)
  if (!res.ok) throw new Error('讀取模組包版本失敗')
  const json = (await res.json()) as ModpackVersion[]
  return json.map((v) => ({
    id: v.id,
    name: v.name,
    version_number: v.version_number,
    game_versions: v.game_versions,
    loaders: v.loaders,
    files: v.files
  }))
}

export type ModSideSupport = 'required' | 'optional' | 'unsupported' | 'unknown'

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
  client_side: ModSideSupport
  server_side: ModSideSupport
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

type ModrinthProjectJson = {
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
  client_side: ModSideSupport
  server_side: ModSideSupport
  license?: { id?: string }
  source_url: string | null
  issues_url: string | null
  wiki_url: string | null
  discord_url: string | null
}

type ModrinthVersionJson = {
  id: string
  name: string
  version_number: string
  game_versions: string[]
  loaders: string[]
  featured: boolean
  dependencies?: Array<{
    version_id: string | null
    project_id: string | null
    dependency_type: string
  }>
  files: Array<{ url: string; filename: string; primary: boolean; hashes?: { sha1?: string } }>
}

export const getModProject = async (projectId: string): Promise<ModProjectDetails> => {
  const res = await modrinthFetch(`https://api.modrinth.com/v2/project/${projectId}`)
  if (!res.ok) throw new Error('讀取模組資料失敗')
  const p = (await res.json()) as ModrinthProjectJson
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    description: p.description,
    body: p.body,
    icon_url: p.icon_url,
    project_type: p.project_type,
    downloads: p.downloads,
    followers: p.followers,
    categories: p.categories ?? [],
    game_versions: p.game_versions ?? [],
    loaders: p.loaders ?? [],
    client_side: p.client_side ?? 'unknown',
    server_side: p.server_side ?? 'unknown',
    license_id: p.license?.id ?? null,
    source_url: p.source_url,
    issues_url: p.issues_url,
    wiki_url: p.wiki_url,
    discord_url: p.discord_url
  }
}

export const listModVersions = async (
  projectId: string,
  opts: { loaders?: string[]; gameVersions?: string[] } = {}
): Promise<ModVersion[]> => {
  const url = new URL(`https://api.modrinth.com/v2/project/${projectId}/version`)
  if (opts.loaders?.length) url.searchParams.set('loaders', JSON.stringify(opts.loaders))
  if (opts.gameVersions?.length)
    url.searchParams.set('game_versions', JSON.stringify(opts.gameVersions))
  const res = await modrinthFetch(url.toString())
  if (!res.ok) throw new Error('讀取模組版本失敗')
  const json = (await res.json()) as ModrinthVersionJson[]
  return json.map((v) => ({
    id: v.id,
    name: v.name,
    version_number: v.version_number,
    game_versions: v.game_versions ?? [],
    loaders: v.loaders ?? [],
    featured: Boolean(v.featured),
    dependencies: v.dependencies ?? [],
    files: (v.files ?? []).map((f) => ({
      url: f.url,
      filename: f.filename,
      primary: Boolean(f.primary),
      sha1: f.hashes?.sha1
    }))
  }))
}

const mapModrinthVersion = (v: ModrinthVersionJson): ModVersion => {
  return {
    id: v.id,
    name: v.name,
    version_number: v.version_number,
    game_versions: v.game_versions ?? [],
    loaders: v.loaders ?? [],
    featured: Boolean(v.featured),
    dependencies: v.dependencies ?? [],
    files: (v.files ?? []).map((f) => ({
      url: f.url,
      filename: f.filename,
      primary: Boolean(f.primary),
      sha1: f.hashes?.sha1
    }))
  }
}

const getModVersionById = async (versionId: string): Promise<ModVersion> => {
  const res = await modrinthFetch(`https://api.modrinth.com/v2/version/${versionId}`)
  if (!res.ok) throw new Error('讀取模組版本資料失敗')
  const json = (await res.json()) as ModrinthVersionJson
  return mapModrinthVersion(json)
}

const sha1File = async (path: string): Promise<string> => {
  const h = createHash('sha1')
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const s = createReadStream(path)
    s.on('error', rejectPromise)
    s.on('data', (chunk: string | Buffer) => {
      if (typeof chunk === 'string') h.update(chunk, 'utf-8')
      else h.update(chunk)
    })
    s.on('close', () => resolvePromise())
  })
  return h.digest('hex')
}

const safeDownloadReplace = async (
  url: string,
  dest: string,
  hooks: DownloadHooks & { key: string }
): Promise<void> => {
  const tmp = `${dest}.download`
  await downloadToFile(url, tmp, hooks)
  if (await fileExists(dest)) {
    try {
      await unlink(dest)
    } catch (e) {
      void e
    }
  }
  await rename(tmp, dest)
}

export const installModVersion = async (
  profile: ServerProfile,
  version: ModVersion,
  hooks?: DownloadHooks & { key: string },
  target: InstallTarget = 'server'
): Promise<string> => {
  const root = installRootPath(profile, target)
  const modsDir = join(root, 'mods')
  await ensureDir(modsDir)

  const primary = version.files.find((f) => f.primary) ?? version.files[0]
  if (!primary) throw new Error('搵唔到模組檔案')
  const dest = join(modsDir, primary.filename)
  if (await fileExists(dest)) {
    const expected = primary.sha1?.toLowerCase()
    if (expected) {
      try {
        const actual = (await sha1File(dest)).toLowerCase()
        if (actual === expected) return dest
      } catch (e) {
        void e
      }
    }
  }

  await safeDownloadReplace(primary.url, dest, {
    key: hooks?.key ?? '下載模組',
    onProgress: hooks?.onProgress
  })
  return dest
}

const selectBestModVersion = (versions: ModVersion[]): ModVersion | null => {
  if (!versions.length) return null
  const featured = versions.find((v) => v.featured)
  return featured ?? versions[0]
}

export const installModVersionWithDependencies = async (
  profile: ServerProfile,
  version: ModVersion,
  hooks?: DownloadHooks & { key: string },
  target: InstallTarget = 'server',
  filter?: { loader?: string; gameVersion?: string }
): Promise<{ installed: string[]; skipped: string[] }> => {
  const installed: string[] = []
  const skipped: string[] = []

  const visited = new Set<string>()

  const installOne = async (v: ModVersion, depth: number): Promise<void> => {
    if (depth > 12) return
    if (visited.has(v.id)) return
    visited.add(v.id)

    const dest = await installModVersion(profile, v, hooks, target)
    installed.push(dest)

    const deps = (v.dependencies ?? []).filter(
      (d) => d.dependency_type === 'required' && d.project_id
    )
    if (!deps.length) return

    for (const d of deps) {
      const projectId = d.project_id
      if (!projectId && !d.version_id) continue
      try {
        const byId = d.version_id ? await getModVersionById(d.version_id) : null
        if (byId) {
          const okLoader = !filter?.loader || byId.loaders.includes(filter.loader)
          const okGame = !filter?.gameVersion || byId.game_versions.includes(filter.gameVersion)
          if (okLoader && okGame) {
            await installOne(byId, depth + 1)
            continue
          }
        }

        if (!projectId) {
          skipped.push(d.version_id ?? '')
          continue
        }

        const opts = {
          loaders: filter?.loader ? [filter.loader] : undefined,
          gameVersions: filter?.gameVersion ? [filter.gameVersion] : undefined
        }
        const versions = await listModVersions(projectId, opts)
        const best = selectBestModVersion(versions)
        if (!best) {
          skipped.push(projectId)
          continue
        }
        await installOne(best, depth + 1)
      } catch {
        skipped.push(projectId ?? d.version_id ?? '')
      }
    }
  }

  await installOne(version, 0)
  return { installed, skipped }
}

type ModrinthIndexFile = {
  downloads?: string[]
  path: string
  env?: {
    client?: 'required' | 'optional' | 'unsupported'
    server?: 'required' | 'optional' | 'unsupported'
  }
}

type ModrinthIndexJson = {
  files?: ModrinthIndexFile[]
}

type ModrinthInstalledMarker = {
  versionId: string
  installedAt: number
  target: InstallTarget
}

const installRootPath = (profile: ServerProfile, target: InstallTarget): string => {
  if (target === 'server') return profile.serverPath
  return join(profile.serverPath, 'client')
}

const shouldDownloadIndexFile = (target: InstallTarget, f: ModrinthIndexFile): boolean => {
  const env = f.env
  if (!env) return true
  if (target === 'server') return env.server !== 'unsupported'
  return env.client !== 'unsupported'
}

export const installModpack = async (
  profile: ServerProfile,
  version: ModpackVersion,
  hooks?: DownloadHooks & { key: string },
  target: InstallTarget = 'server'
): Promise<void> => {
  const root = installRootPath(profile, target)
  await ensureDir(root)

  const markerPath = join(root, '.modrinth-installed.json')
  if (await fileExists(markerPath)) {
    const raw = await readFile(markerPath, 'utf-8')
    const marker = safeJsonParse<ModrinthInstalledMarker>(raw)
    if (marker?.versionId === version.id && marker?.target === target) {
      hooks?.onProgress?.({ key: '已經係同一個版本，跳過下載', transferred: 0 })
      return
    }
  }

  const primaryFile = version.files.find((f) => f.primary) ?? version.files[0]
  if (!primaryFile) throw new Error('搵唔到模組包檔案')
  const tempZip = join(app.getPath('temp'), `modpack-${version.id}.mrpack`)
  await downloadToFile(primaryFile.url, tempZip, {
    key: hooks?.key ?? '下載模組包',
    onProgress: hooks?.onProgress
  })

  hooks?.onProgress?.({ key: '解壓模組包...', transferred: 0 })
  const extractDir = join(app.getPath('temp'), `modpack-${version.id}-extract`)
  await ensureDir(extractDir)
  await extract(tempZip, { dir: extractDir })

  // Modrinth .mrpack format: overrides/ contains the files to copy to server root
  const overridesDir = join(extractDir, 'overrides')
  if (await dirExists(overridesDir)) {
    const cp = async (src: string, dest: string): Promise<void> => {
      const s = await stat(src)
      if (s.isDirectory()) {
        await ensureDir(dest)
        const entries = await readdir(src)
        for (const e of entries) await cp(join(src, e), join(dest, e))
      } else {
        const data = await readFile(src)
        await ensureDir(dirname(dest))
        await writeFile(dest, data)
      }
    }
    await cp(overridesDir, root)
  }

  // Download dependencies specified in modrinth.index.json
  const indexPath = join(extractDir, 'modrinth.index.json')
  if (await fileExists(indexPath)) {
    const indexJson = safeJsonParse<ModrinthIndexJson>(await readFile(indexPath, 'utf-8'))
    if (indexJson?.files && Array.isArray(indexJson.files)) {
      let done = 0
      const targets = indexJson.files.filter((f) => shouldDownloadIndexFile(target, f))
      const total = targets.length
      for (const file of indexJson.files) {
        if (!shouldDownloadIndexFile(target, file)) continue
        if (!file.downloads || !file.downloads[0]) continue
        const dest = join(root, file.path)
        await downloadToFile(file.downloads[0], dest, { key: `下載依賴 (${done + 1}/${total})` })
        done++
        hooks?.onProgress?.({ key: `下載依賴 (${done}/${total})`, transferred: 0 })
      }
    }
  }

  const marker: ModrinthInstalledMarker = { versionId: version.id, installedAt: Date.now(), target }
  await writeFile(markerPath, JSON.stringify(marker, null, 2), 'utf-8')

  hooks?.onProgress?.({ key: '安裝完成', transferred: 0 })
}

export const backupWorld = async (profile: ServerProfile, backupName?: string): Promise<string> => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const name = backupName ? sanitizeProfileName(backupName) : `backup-${timestamp}`
  const backupDir = join(profile.serverPath, 'backups')
  await ensureDir(backupDir)
  const zipPath = join(backupDir, `${name}.zip`)

  const out = createWriteStream(zipPath)
  const archive = archiver('zip', { zlib: { level: 9 } })

  return new Promise((resolve, reject) => {
    out.on('close', () => resolve(zipPath))
    archive.on('error', reject)
    archive.pipe(out)

    const folders = ['world', 'world_nether', 'world_the_end']
    for (const f of folders) {
      const p = join(profile.serverPath, f)
      if (existsSync(p)) {
        archive.directory(p, f)
      }
    }
    archive.finalize()
  })
}

export const restoreWorld = async (profile: ServerProfile, zipPath: string): Promise<void> => {
  if (!(await fileExists(zipPath))) throw new Error('備份檔唔存在')
  await extract(zipPath, { dir: profile.serverPath })
}

export const listBackups = async (
  profile: ServerProfile
): Promise<Array<{ name: string; path: string; size: number; date: number }>> => {
  const backupDir = join(profile.serverPath, 'backups')
  if (!(await dirExists(backupDir))) return []
  const files = await readdir(backupDir)
  const backups: Array<{ name: string; path: string; size: number; date: number }> = []
  for (const f of files) {
    if (!f.endsWith('.zip')) continue
    const p = join(backupDir, f)
    const s = await stat(p)
    backups.push({ name: f, path: p, size: s.size, date: s.mtimeMs })
  }
  return backups.sort((a, b) => b.date - a.date)
}
