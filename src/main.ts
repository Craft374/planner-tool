import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, screen, shell } from 'electron'
import { spawn as spawnPty, type IPty } from 'node-pty'
import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { SESSION_DEFAULTS as D, type Button, type Config, type HookEvent, type Role, type SetupItem, type Usage } from './shared'

// 원칙: main 프로세스에서는 동기 I/O(…Sync)와 sendSync를 쓰지 않는다. 화면이 멈추지 않게 하기 위해서다.

const isMac = process.platform === 'darwin'
const isWin = process.platform === 'win32'
const AUTO_COMPACT_PCT = '80' // ponytail: 정할 것 2번(자동 압축 기준 %)이 정해지면 바꾼다
// 작업 지침은 프로그램이 아니라 각 폴더의 CLAUDE.local.md에 둔다. 모델 등 세션 기본값은 shared.ts의 SESSION_DEFAULTS.
const DEFAULT_CONFIG: Config = { role: 'plan', autoCompact: false, mode: 'manual', setupSeen: false, folders: [], sessions: [], active: 0, tutorialSeen: false }
const LOCAL_MD = 'CLAUDE.local.md'
const EDIT_LIMIT = 200_000 // 이보다 큰 파일은 화면에서 고치지 않는다(잘린 채 저장되는 것을 막는다)

const userDir = () => app.getPath('userData')
const tabsDir = () => path.join(userDir(), 'tabs')
const resDir = () => (app.isPackaged ? path.join(process.resourcesPath, 'resources') : path.join(app.getAppPath(), 'resources'))
const configFile = () => path.join(userDir(), 'config.json')
const buttonsFile = () => path.join(userDir(), 'buttons.json')
const windowFile = () => path.join(userDir(), 'window.json') // 창 위치·크기(마지막 화면 그대로 열기)

let win: BrowserWindow | null = null
let busy = 0
let closeConfirmed = false
const ptys = new Map<string, IPty>()
const tabCwd = new Map<string, string>() // 지침 파일은 열려 있는 세션의 폴더에서만 읽고 쓴다
const notifications = new Set<Notification>() // 클릭 처리기가 GC되지 않게 잡아 둔다
const token = randomBytes(16).toString('hex')

const send = (channel: string, ...args: unknown[]) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

function run(file: string, args: string[], env?: NodeJS.ProcessEnv, timeout = 60_000): Promise<string> {
  // Windows의 .cmd(npm 설치)는 execFile로 바로 못 띄워서 cmd.exe를 거친다. 인자는 모두 고정 문자열이다.
  if (isWin && /\.cmd$/i.test(file)) [file, args] = ['cmd.exe', ['/d', '/s', '/c', file, ...args]]
  return new Promise((resolve) => {
    // SIGKILL + stdin 닫기: 셸 설정이 입력을 기다리거나 신호를 무시해도 시간 안에 끝낸다.
    const child = execFile(file, args, { env, timeout, killSignal: 'SIGKILL', windowsHide: true }, (_err, stdout) => resolve(String(stdout ?? '')))
    child.stdin?.end()
  })
}

const exists = (file: string) => fs.access(file).then(() => true, () => false)

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')) as T // 메모장이 붙이는 BOM
  } catch {
    return fallback
  }
}

// ── claude 찾기 ──
// Finder·시작 메뉴로 띄운 앱은 PATH가 짧아서(/opt/homebrew/bin 등이 빠짐) 로그인 셸에서 PATH를 받아 온다.
type ClaudeEnv = { claude: string | null; env: NodeJS.ProcessEnv }

async function resolveClaude(): Promise<ClaudeEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
  delete env.ELECTRON_RUN_AS_NODE
  if (!env.LANG) env.LANG = 'en_US.UTF-8' // 비어 있으면 터미널의 한글이 깨진다
  if (isWin) {
    // where.exe는 출력이 콘솔 코드페이지(CP949)라 한글 사용자 폴더 경로가 깨진다. PATH를 직접 찾는다.
    // 네이티브 설치(.local\bin)가 PATH에 아직 안 들어간 PC도 있어서 흔한 설치 경로도 본다.
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'Path'
    const home = app.getPath('home')
    const dirs = [
      ...(env[key] ?? '').split(';').map((d) => d.trim().replace(/^"|"$/g, '')),
      path.join(home, '.local', 'bin'),
      path.join(app.getPath('appData'), 'npm'),
      path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Microsoft', 'WinGet', 'Links'),
    ].filter(Boolean)
    for (const name of ['claude.exe', 'claude.cmd']) {
      for (const d of dirs) {
        const p = path.join(d, name)
        if (!(await exists(p))) continue
        if (!(env[key] ?? '').toLowerCase().split(';').includes(d.toLowerCase())) env[key] = `${d};${env[key] ?? ''}`
        return { claude: p, env }
      }
    }
    return { claude: null, env }
  }
  // 셸 설정이 멈춰 있어도(tmux 자동 연결 등) 8초 뒤에는 포기하고 흔한 설치 경로를 찾는다.
  const out = await run(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf "__PT__%s__PT__%s__PT__" "$PATH" "$(command -v claude)"'], undefined, 8_000)
  const m = out.match(/__PT__([\s\S]*?)__PT__([\s\S]*?)__PT__/)
  if (m?.[1]) env.PATH = m[1]
  const found = m?.[2]?.trim()
  if (found?.startsWith('/')) return { claude: found, env }
  const home = app.getPath('home')
  for (const p of ['/opt/homebrew/bin/claude', '/usr/local/bin/claude', `${home}/.local/bin/claude`, `${home}/.claude/local/claude`]) {
    if (await exists(p)) {
      env.PATH = `${path.dirname(p)}:${env.PATH ?? '/usr/bin:/bin'}`
      return { claude: p, env }
    }
  }
  return { claude: null, env }
}

// 상태줄 입력에서 화면에 보여 줄 사용량만 고른다(없는 값은 빠진다).
const num = (v: unknown) => (typeof v === 'number' ? v : undefined)
const limitOf = (l: any) => (typeof l?.used_percentage === 'number' ? { pct: l.used_percentage, resets: num(l.resets_at) } : undefined)
function usageOf(j: any): Usage {
  return {
    tokens: num(j.context_window?.total_input_tokens),
    size: num(j.context_window?.context_window_size),
    five: limitOf(j.rate_limits?.five_hour),
    week: limitOf(j.rate_limits?.seven_day),
    cacheExpires: num(j.prompt_cache?.expires_at),
    model: typeof j.model?.display_name === 'string' ? j.model.display_name : undefined,
  }
}

// ── 훅·상태줄을 받는 로컬 서버 ──
// 훅은 type "http"로 여기로 바로 POST한다. 상태줄은 curl로 POST하고, 응답 본문이 터미널 상태줄에 찍힌다.
const server = createServer((req, res) => {
  const [, tok, tab, kind] = (req.url ?? '').split('/')
  if (req.method !== 'POST' || tok !== token || !ptys.has(tab)) {
    res.writeHead(404).end()
    return
  }
  const chunks: Buffer[] = []
  let size = 0
  req.on('data', (c: Buffer) => {
    size += c.length
    if (size <= 2_000_000) chunks.push(c)
  })
  req.on('end', () => {
    let j: any = {}
    try {
      j = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {}
    const ev: HookEvent = {
      tab,
      kind,
      prompt: typeof j.prompt === 'string' ? j.prompt.slice(0, 300) : undefined,
      type: j.notification_type,
      agentId: j.agent_id,
      agentType: j.agent_type,
      source: j.source,
      pct: kind === 'status' ? (j.context_window?.used_percentage ?? null) : undefined,
      mode: typeof j.permission_mode === 'string' ? j.permission_mode : undefined,
      effort: typeof j.effort?.level === 'string' ? j.effort.level : undefined,
      usage: kind === 'status' ? usageOf(j) : undefined,
      sessionId: typeof j.session_id === 'string' ? j.session_id : undefined,
    }
    send('hook', ev)
    if (kind === 'status') {
      const pct = typeof ev.pct === 'number' ? ` · 컨텍스트 ${Math.round(ev.pct)}%` : ''
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`${j.model?.display_name ?? ''}${pct}`)
    } else {
      res.writeHead(200).end() // 빈 응답 = 훅이 아무것도 바꾸지 않는다
    }
  })
})
const serverReady = new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))

function tabSettings(tab: string, port: number) {
  const url = (kind: string) => `http://127.0.0.1:${port}/${token}/${tab}/${kind}`
  // Windows: Git Bash·PowerShell 둘 다에서 돌도록 curl.exe와 작은따옴표를 쓴다.
  const curl = (kind: string) => `${isWin ? 'curl.exe' : 'curl'} -s -m 2 --data-binary '@-' ${url(kind)}`
  const hook = (kind: string) => [{ hooks: [{ type: 'http', url: url(kind), timeout: 5 }] }]
  const events = ['UserPromptSubmit', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop']
  return {
    hooks: {
      ...Object.fromEntries(events.map((e) => [e, hook(e)])),
      SessionStart: [{ hooks: [{ type: 'command', command: curl('SessionStart'), timeout: 5 }] }], // SessionStart는 http 훅을 받지 않는다
    },
    statusLine: { type: 'command', command: curl('status') },
    ultracode: D.ultracode, // 도중에는 /effort ultracode on|off로 바꾼다
    advisorModel: D.advisor, // 도중에는 /advisor <모델|off>
  }
}


// ── 시작 시 준비(창을 기다리게 하지 않는다) ──
const claudeReady = resolveClaude()
const cleanup = app.whenReady().then(() => fs.rm(tabsDir(), { recursive: true, force: true }))

const validButtons = (l: unknown): Button[] =>
  Array.isArray(l) ? l.filter((b): b is Button => typeof b?.label === 'string' && typeof b?.text === 'string') : []

// 사용자 파일은 '편집'을 누를 때만 만든다. 편집하지 않은 사용자는 늘 새 버전의 기본 버튼을 받는다.
async function loadButtons(): Promise<{ buttons: Record<Role, Button[]>; buttonsError: boolean }> {
  const defaults = await readJson<any>(path.join(resDir(), 'buttons.json'), {})
  const has = await exists(buttonsFile())
  const user = has ? await readJson<any>(buttonsFile(), null) : null
  const buttonsError = has && user === null // 문법이 틀렸다: 기본 버튼을 보여 주고 화면에서 알린다
  // 예전 형식(배열 하나)은 기획 버튼으로 보고, 개발 버튼은 기본값을 쓴다.
  if (Array.isArray(user)) return { buttons: { plan: validButtons(user), dev: validButtons(defaults.dev) }, buttonsError }
  return { buttons: { plan: validButtons(user?.plan ?? defaults.plan), dev: validButtons(user?.dev ?? defaults.dev) }, buttonsError }
}

ipcMain.handle('init', async () => ({
  config: { ...DEFAULT_CONFIG, ...(await readJson<Partial<Config>>(configFile(), {})) },
  ...(await loadButtons()),
}))
ipcMain.handle('buttons:load', () => loadButtons())

ipcMain.handle('folder:pick', async () => {
  if (!win) return null
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
  return r.canceled ? null : (r.filePaths[0] ?? null)
})

ipcMain.handle('session:new', async (_e, tab: string, cwd: string, cols: number, rows: number, resume?: string) => {
  if (!/^[a-z0-9]{1,32}$/.test(tab) || ptys.has(tab)) return { error: '세션 번호가 올바르지 않습니다.' }
  if (resume !== undefined && !/^[\w-]{8,64}$/.test(resume)) return { error: '이어 할 세션 번호가 올바르지 않습니다.' }
  const [{ claude, env }, port] = await Promise.all([claudeReady, serverReady, cleanup])
  if (!claude) return { error: 'claude를 찾을 수 없습니다. Claude Code를 설치한 뒤 프로그램을 다시 실행해 주세요.' }
  try {
    const cfg = { ...DEFAULT_CONFIG, ...(await readJson<Partial<Config>>(configFile(), {})) }
    await fs.mkdir(tabsDir(), { recursive: true })
    const settingsFile = path.join(tabsDir(), `${tab}.json`)
    await fs.writeFile(settingsFile, JSON.stringify(tabSettings(tab, port)))
    const args = ['--settings', settingsFile, '--model', D.model, '--effort', D.effort, '--permission-mode', cfg.mode, ...(resume ? ['--resume', resume] : [])]
    const p = spawnPty(claude, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      // 포니테일은 리뷰 버튼으로만 쓴다. 켜 두면 매 세션 규칙 전체가 들어가 사용량이 늘고 상태줄 설정도 권한다.
      env: { ...env, PONYTAIL_DEFAULT_MODE: 'off', ...(cfg.autoCompact && { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: AUTO_COMPACT_PCT }) },
    })
    ptys.set(tab, p)
    tabCwd.set(tab, cwd)
    p.onData((d) => send('pty:data', tab, d))
    p.onExit(() => {
      ptys.delete(tab) // tabCwd는 남겨 둔다: 끝난 세션의 폴더에서도 지침을 고칠 수 있게
      fs.rm(settingsFile, { force: true }).catch(() => {})
      send('pty:exit', tab)
    })
    return { ok: true }
  } catch (err) {
    return { error: `세션을 시작하지 못했습니다: ${(err as Error).message}` }
  }
})

// ── 지침(CLAUDE.local.md) ──
const knownCwd = (cwd: string) => [...tabCwd.values()].includes(cwd)

ipcMain.handle('instructions:read', async (_e, cwd: string) => {
  if (!knownCwd(cwd)) return null
  try {
    const text = await fs.readFile(path.join(cwd, LOCAL_MD), 'utf8')
    if (!text.trim()) return { exists: false, text: '' } // 빈 파일은 지침이 없는 것으로 본다(기본 지침을 넣을 수 있게)
    return Buffer.byteLength(text) > EDIT_LIMIT ? { exists: true, text: '', tooLarge: true } : { exists: true, text }
  } catch (err) {
    // 없을 때만 '없음'. 권한 오류 등을 '없음'으로 보면 기본 지침 저장이 기존 파일을 덮어쓴다.
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { exists: false, text: '' } : null
  }
})

ipcMain.handle('instructions:save', async (_e, cwd: string, text: string) => {
  if (!knownCwd(cwd) || typeof text !== 'string' || Buffer.byteLength(text) > EDIT_LIMIT) return false
  try {
    const file = path.join(cwd, LOCAL_MD)
    await fs.writeFile(`${file}.tmp`, text)
    await fs.rename(`${file}.tmp`, file) // 쓰다 멈춰도 원래 파일이 깨지지 않게
    // 개인 파일이므로 git에 올라가지 않게 이 PC에서만 제외한다(.gitignore는 건드리지 않는다).
    // 하위 폴더·worktree에서도 맞는 exclude 파일을 git에게 묻는다. 실패해도 저장은 성공이다.
    const out = (await run('git', ['-C', cwd, 'rev-parse', '--git-path', 'info/exclude'], undefined, 5_000)).trim()
    if (out) {
      const exclude = path.resolve(cwd, out)
      const cur = (await fs.readFile(exclude, 'utf8').catch(() => '')) as string
      // ponytail: 하위 폴더를 연 경우 패턴이 저장소 루트 기준이라 그 폴더의 CLAUDE.local.md도 이름으로 걸린다
      if (!cur.split(/\r?\n/).includes(LOCAL_MD)) {
        await fs.mkdir(path.dirname(exclude), { recursive: true }).catch(() => {})
        await fs.appendFile(exclude, `${cur && !cur.endsWith('\n') ? '\n' : ''}${LOCAL_MD}\n`).catch(() => {})
      }
    }
    return true
  } catch {
    return false
  }
})

ipcMain.handle('instructions:template', (_e, role: Role) =>
  fs.readFile(path.join(resDir(), role === 'dev' ? 'CLAUDE.local.dev.template.md' : 'CLAUDE.local.template.md'), 'utf8'),
)

ipcMain.on('pty:write', (_e, tab: string, data: string) => ptys.get(tab)?.write(data))
ipcMain.on('pty:resize', (_e, tab: string, cols: number, rows: number) => {
  try {
    if (cols > 0 && rows > 0) ptys.get(tab)?.resize(cols, rows)
  } catch {} // 막 종료된 pty
})
ipcMain.on('pty:kill', (_e, tab: string) => ptys.get(tab)?.kill())

ipcMain.handle('confirm', async (_e, message: string, detail: string, ok: string) => {
  if (!win) return false
  const r = await dialog.showMessageBox(win, { type: 'warning', message, detail, buttons: [ok, '취소'], defaultId: 1, cancelId: 1 })
  return r.response === 0
})

ipcMain.handle('alert', async (_e, message: string) => {
  if (win) await dialog.showMessageBox(win, { type: 'warning', message, buttons: ['확인'] })
})

ipcMain.on('notify', (_e, title: string, body: string, tab: string) => {
  if (!Notification.isSupported()) return
  const n = new Notification({ title, body })
  notifications.add(n)
  n.on('click', () => {
    if (win?.isMinimized()) win.restore()
    win?.show()
    win?.focus()
    send('focus-tab', tab)
    notifications.delete(n)
  })
  n.on('close', () => notifications.delete(n))
  n.show()
})

ipcMain.on('busy', (_e, count: number) => {
  busy = count
})
// 한 줄로 세워 차례로 쓰고, 임시 파일에 쓴 뒤 바꿔 끼운다. 겹쳐 쓰거나 쓰다 꺼져도 설정이 깨지지 않게.
let configWrite = Promise.resolve()
ipcMain.on('config:set', (_e, cfg: Config) => {
  const data = JSON.stringify(cfg, null, 2)
  const file = configFile()
  configWrite = configWrite
    .then(() => fs.writeFile(`${file}.tmp`, data))
    .then(() => fs.rename(`${file}.tmp`, file))
    .catch(() => {})
})
ipcMain.on('buttons:edit', async () => {
  try {
    const file = buttonsFile()
    if (!(await exists(file))) {
      await fs.mkdir(userDir(), { recursive: true })
      await fs.copyFile(path.join(resDir(), 'buttons.json'), file)
    }
    // .json에 연결된 프로그램이 없는 Windows에서는 메모장으로 연다.
    if ((await shell.openPath(file)) && isWin) execFile('notepad.exe', [file], () => {})
  } catch {}
})

// ── 플러그인·스킬 설치 ──
// 앱 안에 넣어 둔 것(노션 싱크, 애플 디자인)과 포니테일을 claude 전역(사용자 범위)에 설치한다.
// claude CLI를 직접 불러 설치하므로 Claude 사용량은 들지 않는다.
const SETUP = [
  { id: 'notion-sync', label: '노션 싱크', desc: '노션 기획서를 로컬 md로 동기화합니다', plugin: 'notion-sync@notion-sync-local' },
  { id: 'ponytail', label: '포니테일', desc: '과설계를 찾아 주는 리뷰', plugin: 'ponytail@ponytail' },
  { id: 'apple-design', label: '애플 디자인', desc: 'UI를 애플 디자인 원칙으로 만듭니다', skill: 'apple-design' },
] as const
const skillsDir = () => path.join(app.getPath('home'), '.claude', 'skills')

async function pythonOk(env: NodeJS.ProcessEnv) {
  for (const [cmd, args] of [['python3', ['--version']], ['py', ['-3', '--version']], ['python', ['--version']]] as const) {
    const m = (await run(cmd, [...args], env, 5_000)).match(/Python (\d+)\.(\d+)/)
    if (m) return +m[1] > 3 || (+m[1] === 3 && +m[2] >= 11)
  }
  return false
}

const pluginVersion = (dir: string) => readJson<{ version?: string }>(path.join(dir, '.claude-plugin', 'plugin.json'), {}).then((j) => j.version)
const notionCopy = () => path.join(userDir(), 'plugins', 'notion-sync')

async function setupStatus(): Promise<SetupItem[] | null> {
  const { claude, env } = await claudeReady
  if (!claude) return null
  let list: { id: string; enabled: boolean }[] = []
  try {
    list = JSON.parse(await run(claude, ['plugin', 'list', '--json'], env))
  } catch {}
  const [py, git, bundled, copied] = await Promise.all([
    pythonOk(env),
    run('git', ['--version'], env, 5_000).then((out) => /git version/.test(out)),
    pluginVersion(path.join(resDir(), 'plugins', 'notion-sync')),
    pluginVersion(notionCopy()),
  ])
  // 앱에 든 노션 싱크가 설치한 것보다 새 버전이면 다시 설치하게 한다(플러그인을 고치면 plugin.json의 version을 올린다).
  const stale = !!copied && bundled !== copied // 사본이 없으면 다른 경로로 설치한 것이다(개발 PC)
  return Promise.all(
    SETUP.map(async (it) => {
      const listed = 'plugin' in it ? list.some((p) => p.id === it.plugin && p.enabled) : await exists(path.join(skillsDir(), it.skill, 'SKILL.md'))
      const outdated = it.id === 'notion-sync' && listed && stale
      return {
        id: it.id,
        label: it.label,
        desc: it.desc,
        installed: listed && !outdated,
        note:
          outdated ? `새 버전이 있습니다. 설치를 눌러 업데이트해 주세요${py ? '' : ' (Python 3.11 이상 필요)'}`
          : it.id === 'notion-sync' && !py ? 'Python 3.11 이상이 있어야 동작합니다'
          : it.id === 'ponytail' && !git ? 'Git이 있어야 설치할 수 있습니다(git-scm.com). 작업 커밋 버튼에도 필요합니다'
          : undefined,
      }
    }),
  )
}

async function install(id: string) {
  const { claude, env } = await claudeReady
  const it = SETUP.find((x) => x.id === id)
  if (!claude || !it) return false
  try {
    if ('skill' in it) {
      // 이미 있으면 덮어쓰지 않는다(사용자가 고친 스킬일 수 있다).
      await fs.cp(path.join(resDir(), 'skills', it.skill), path.join(skillsDir(), it.skill), { recursive: true, force: false }).catch(() => {})
    } else {
      let source: string = 'https://github.com/DietrichGebert/ponytail.git'
      if (it.id === 'notion-sync') {
        // 앱 번들은 옮겨지거나 갱신될 수 있으므로 사용자 폴더로 복사한 곳을 마켓플레이스로 등록한다.
        source = notionCopy()
        await fs.rm(source, { recursive: true, force: true })
        await fs.cp(path.join(resDir(), 'plugins', 'notion-sync'), source, { recursive: true })
      }
      await run(claude, ['plugin', 'marketplace', 'add', source], env)
      if (it.id === 'notion-sync') await run(claude, ['plugin', 'marketplace', 'update', 'notion-sync-local'], env) // 이미 등록돼 있던 경우 새 사본을 읽게
      await run(claude, ['plugin', 'install', it.plugin], env)
      if (it.id === 'notion-sync') await run(claude, ['plugin', 'update', it.plugin], env) // 이미 설치돼 있던 경우 새 버전으로
      await run(claude, ['plugin', 'enable', it.plugin], env) // 설치돼 있지만 꺼져 있던 경우
    }
    return (await setupStatus())?.find((x) => x.id === id)?.installed ?? false
  } catch {
    return false
  }
}

ipcMain.handle('setup:status', () => setupStatus())
ipcMain.handle('setup:install', (_e, id: string) => install(id))

// ── Claude Code 업데이트 ──
// `claude update`는 설치 방식(네이티브·brew·npm 등)에 맞게 알아서 업데이트한다.
// 출력을 그대로 화면에 흘려 보내고, 끝난 뒤(종료 코드)에야 결과를 돌려준다. 세션 재시작은 화면이 맡는다.
// 출력을 스트리밍하며 한 단계씩 실행한다(종료 코드를 돌려준다).
function stream(file: string, args: string[], env: NodeJS.ProcessEnv) {
  if (isWin && /\.cmd$/i.test(file)) [file, args] = ['cmd.exe', ['/d', '/s', '/c', file, ...args]]
  send('update:log', `$ ${path.basename(file)} ${args.join(' ')}\n`)
  let out = ''
  return new Promise<{ code: number; out: string }>((resolve) => {
    // 자기 프로세스 그룹으로 띄워, 끝낼 때 brew가 띄운 curl까지 함께 끝낸다(남아 있으면 다음 업데이트가 잠금에 막힌다).
    const child = spawn(file, args, { env, windowsHide: true, detached: !isWin })
    const log = (d: Buffer) => {
      const t = d.toString('utf8')
      out += t
      send('update:log', t)
    }
    child.stdout.on('data', log)
    child.stderr.on('data', log)
    child.stdin.end()
    const kill = () => {
      try {
        if (!isWin && child.pid) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {}
    }
    const timer = setTimeout(kill, 60 * 60_000) // 인터넷이 느려도 기다리되, 한 시간 넘게 멈추면 실패로 끝낸다
    app.once('will-quit', kill)
    child.on('error', (err) => {
      send('update:log', `${err.message}\n`)
      resolve({ code: 1, out })
    })
    child.on('close', (c) => {
      clearTimeout(timer)
      app.removeListener('will-quit', kill)
      resolve({ code: c ?? 1, out })
    })
  })
}

// brew로 설치했으면 brew 목록을 먼저 새로 받아야 새 버전이 보인다(`claude update`만으로는 그대로였다).
// 그 밖(네이티브·npm·winget 등)은 `claude update`가 설치 방식에 맞게 처리한다.
// brew는 내려받는 동안 아무것도 출력하지 않으므로, 내려받는 중인 파일 크기를 1초마다 보여 준다.
function watchBrewDownload() {
  const dir = path.join(app.getPath('home'), 'Library', 'Caches', 'Homebrew', 'downloads')
  const timer = setInterval(async () => {
    const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith('--claude.incomplete'))
    const sizes = await Promise.all(names.map((n) => fs.stat(path.join(dir, n)).then((s) => s.size, () => 0)))
    const mb = Math.round(Math.max(0, ...sizes) / 1_000_000)
    if (mb) send('update:progress', `내려받는 중 · ${mb}MB`)
  }, 1000)
  return () => clearInterval(timer)
}

function pmCommand(out: string): [string, string[]] | null {
  const cmd = out.match(/To update, run:\s*\n\s*(.+)/)?.[1]?.trim()
  if (!cmd) return null
  if (/^winget upgrade Anthropic\.ClaudeCode$/i.test(cmd))
    return ['winget.exe', ['upgrade', 'Anthropic.ClaudeCode', '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity']]
  if (/^npm (i|install) -g @anthropic-ai\/claude-code(@latest)?$/.test(cmd)) return [isWin ? 'npm.cmd' : 'npm', cmd.split(' ').slice(1)]
  if (/^mise upgrade claude$/.test(cmd)) return ['mise', ['upgrade', 'claude']]
  return null
}

let updateRunning: Promise<{ ok: boolean; before: string; after: string } | null> | null = null
ipcMain.handle('claude:update', () => {
  // 이미 돌고 있으면 새로 띄우지 않고 그 결과를 기다린다(두 번 돌리면 brew 잠금에 막힌다).
  updateRunning ??= (async () => {
    const { claude, env } = await claudeReady
    if (!claude) return null
    const version = async () => (await run(claude, ['--version'], env, 15_000)).trim()
    const before = await version()
    const cask = (await fs.realpath(claude).catch(() => claude)).match(/[\\/]Caskroom[\\/]([^\\/]+)[\\/]/)?.[1]
    const steps: [string, string[]][] = cask ? [['brew', ['update']], ['brew', ['upgrade', '--cask', cask]]] : [[claude, ['update']]]
    const stopWatch = cask ? watchBrewDownload() : () => {}
    let ok = true
    let last = ''
    for (const [file, args] of steps) {
      const r = await stream(file, args, env)
      last = r.out
      if (r.code !== 0) {
        ok = false
        break
      }
    }
    // 패키지 관리자(winget 등)로 설치했으면 `claude update`는 실행할 명령만 알려 주고 끝난다.
    // 알려 준 명령이 아래 목록에 있을 때만 이어서 실행한다(출력에 적힌 아무 명령이나 실행하지 않는다).
    const next = ok && !cask ? pmCommand(last) : null
    let note: string | undefined
    if (next) {
      // winget은 목록을 먼저 새로 받아야 방금 나온 버전이 보인다(brew update와 같은 이유).
      if (next[0] === 'winget.exe') await stream('winget.exe', ['source', 'update', '--disable-interactivity'], env)
      const r = await stream(next[0], next[1], env)
      ok = r.code === 0
      // 패키지 관리자 목록에 새 버전이 아직 안 올라온 경우: 고장이 아니라 기다리면 된다.
      if (/사용 가능한 업그레이드를 찾을 수 없습니다|No available upgrade found|No newer package versions/i.test(r.out)) {
        note = 'winget 목록에 새 버전이 아직 올라오지 않았습니다. 보통 하루 안에 올라오니 나중에 다시 눌러 주세요.'
      }
    }
    stopWatch()
    return { ok, before, after: await version(), note }
  })().finally(() => {
    updateRunning = null
  })
  return updateRunning
})

// ── 창 ──
// 저장된 창 위치가 지금 연결된 화면 안에 있을 때만 쓴다(모니터를 뺐으면 기본 위치).
async function savedBounds() {
  const b = await readJson<{ x: number; y: number; width: number; height: number; maximized?: boolean } | null>(windowFile(), null)
  if (!b) return null
  const visible = screen.getAllDisplays().some(({ workArea: a }) => b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y)
  return visible ? b : null
}

// Mica는 Windows 11 22H2(빌드 22621) 이상에서만 된다. 그보다 낮으면 투명 배경이 검게 나와서 불투명한 색을 깐다.
const mica = isWin && Number(os.release().split('.')[2]) >= 22621
const winBg = () => (nativeTheme.shouldUseDarkColors ? '#1f2024' : '#f6f6f8') // style.css의 --inspector
const overlay = () => ({ color: mica ? '#00000000' : winBg(), symbolColor: nativeTheme.shouldUseDarkColors ? '#ffffff' : '#1d1d1f', height: 44 })

async function createWindow() {
  const bounds = await savedBounds()
  win = new BrowserWindow({
    width: bounds?.width ?? 1320,
    height: bounds?.height ?? 840,
    ...(bounds && { x: bounds.x, y: bounds.y }),
    minWidth: 980,
    minHeight: 620,
    show: false,
    title: '기획 도우미',
    backgroundColor: isWin && !mica ? winBg() : '#00000000',
    ...(isMac && {
      titleBarStyle: 'hiddenInset' as const,
      trafficLightPosition: { x: 18, y: 18 },
      vibrancy: 'sidebar' as const,
      visualEffectState: 'followWindow' as const,
    }),
    ...(isWin && {
      titleBarStyle: 'hidden' as const,
      titleBarOverlay: overlay(),
      ...(mica && { backgroundMaterial: 'mica' as const }),
    }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  })
  win.once('ready-to-show', () => {
    if (bounds?.maximized) win?.maximize()
    win?.show()
  })
  // 움직이거나 크기를 바꾸면 잠시 뒤 저장한다(끌고 있는 동안 계속 쓰지 않게).
  let saveTimer: NodeJS.Timeout | undefined
  const saveBounds = () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return
      fs.writeFile(windowFile(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() })).catch(() => {})
    }, 500)
  }
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize'] as const) win.on(ev as 'resize', saveBounds)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // 새로고침(Cmd+R)하면 화면은 비는데 claude는 계속 돌므로 함께 끝낸다. 첫 로드 때는 ptys가 비어 있다.
  win.webContents.on('did-start-loading', () => {
    for (const p of ptys.values()) p.kill()
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.on('close', (e) => {
    if (busy === 0 || closeConfirmed || !win) return
    e.preventDefault()
    dialog
      .showMessageBox(win, {
        type: 'warning',
        message: `작업 중인 세션이 ${busy}개 있습니다.`,
        detail: '종료하면 진행 중인 작업이 멈춥니다. 나중에 ‘지난 작업 이어 하기’로 이어서 할 수 있습니다.',
        buttons: ['종료', '취소'],
        defaultId: 1,
        cancelId: 1,
      })
      .then((r) => {
        if (r.response !== 0) return
        closeConfirmed = true
        win?.close()
      })
  })
  win.on('closed', () => {
    win = null
  })
  if (isWin) {
    nativeTheme.on('updated', () => {
      win?.setTitleBarOverlay(overlay())
      if (!mica) win?.setBackgroundColor(winBg())
    })
  }
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
}

if (isWin) app.setAppUserModelId('com.ljw.planner-tool') // 없으면 Windows에서 알림이 뜨지 않는다(electron-builder appId와 같아야 한다)

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win?.isMinimized()) win.restore()
    win?.show()
    win?.focus()
  })
  app.whenReady().then(() => {
    createWindow()
    if (isMac && !app.isPackaged) app.dock?.setIcon(path.join(app.getAppPath(), 'build', 'icon.png'))
  })
  // 세션은 창에 묶여 있으므로 macOS에서도 창을 닫으면 종료한다.
  app.on('window-all-closed', () => app.quit())
  app.on('will-quit', () => {
    for (const p of ptys.values()) p.kill()
    server.close()
  })
}
