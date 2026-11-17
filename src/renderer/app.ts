import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { SESSION_DEFAULTS as D, type Api, type Button, type Config, type LoadedButtons, type Effort, type HookEvent, type Instructions, type Limit, type Mode, type Model, type Role, type SetupItem, type Usage } from '../shared'
import './style.css'

declare global {
  interface Window {
    api: Api
  }
}
const api = window.api

type Status = 'starting' | 'ready' | 'working' | 'waiting' | 'done' | 'exited'
interface Session {
  tab: string
  cwd: string
  name: string | null
  status: Status
  pct: number | null
  agents: Map<string, string>
  term: Terminal
  fit: FitAddon
  el: HTMLDivElement
  closing: boolean // 사용자가 닫은 경우만 true. 그 밖의 종료는 터미널을 남겨 이유를 보이게 한다
  mode: string // permission_mode(훅 값: default·acceptEdits·plan·auto …)
  effort: Effort
  ultracode: boolean
  usage: Usage // 컨텍스트 토큰·캐시 등(상태줄)
  hadPrompt: boolean // 대화가 한 번이라도 있었는가(없으면 --resume할 대화가 없다)
  turnStart: number | null // 지시를 보낼 때의 5시간 한도 사용률(이번 작업이 얼마나 썼는지 계산용)
  turnCost: number | null // 이번(또는 지난) 작업이 쓴 5시간 한도 %
  model: string // sonnet·opus·fable(상태줄 모델 이름으로 바로잡는다)
  advisor: Model | 'off'
  sessionId?: string // Claude 세션 번호(업데이트 뒤 /resume으로 이어 붙일 때 쓴다)
}

const STATUS_LABEL: Record<Status, string> = { starting: '준비 중', ready: '준비됨', working: '작업 중', waiting: '입력 대기', done: '끝남', exited: '종료됨' }
// 이 알림만 "입력 대기"로 본다. idle_prompt는 "쉬는 중" 신호라 작업이 끝난 것으로 본다(Esc 중단 뒤 등).
const WAIT_TYPES = new Set(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input'])
// 기획자가 고를 때 보는 이름과 설명. 하이쿠는 기획 작업에 맞지 않아 뺐다.
const MODELS: [Model, string, string][] = [
  // ×n = 사용량 배수(가격 비율: Sonnet $2/$10, Opus $4/$20, Fable $8/$40 기준)
  ['sonnet', 'Sonnet ×1', '빠르고 가벼움 · 평소 작업은 이걸로'],
  ['opus', 'Opus ×2', '어려운 설계·버그에 강함 · 사용량 2배'],
  ['fable', 'Fable ×4', '가장 강력함 · 사용량 4배'],
]
const ADVISORS: [Model | 'off', string, string][] = [
  ['off', '끄기', '조언 없이 작업'],
  ['sonnet', 'Sonnet', '가벼운 조언'],
  ['opus', 'Opus', '추천 · Sonnet과 함께 쓰기 좋음'],
  ['fable', 'Fable', '가장 강한 조언 · 사용량 많음'],
]
const EFFORTS: [Effort, string, string][] = [
  ['low', '낮음', '바로 답함 · 간단한 수정'],
  ['medium', '보통', '대부분의 작업에 충분'],
  ['high', '높음', '충분히 생각 · 기본값'],
  ['xhigh', '매우 높음', '깊게 생각 · 사용량 많음'],
  ['max', '최대', '끝까지 생각 · 이번 세션만'],
]
const MODES: [Mode, string, string][] = [
  ['manual', '수동', '고치거나 실행하기 전에 매번 물어봄'],
  ['plan', '플랜', '계획을 먼저 보여 주고 승인 후 작업'],
  ['auto', '자동', '안전한 건 알아서, 위험하면 물어봄'],
]
const ACCEPT_EDITS_DESC = '편집 자동 허용 중 · 명령 실행만 물어봄'
// Shift+Tab을 누를 때 Claude Code가 모드를 바꾸는 순서(2.1.325 바이너리에서 확인).
// ponytail: 자동 모드를 못 쓰는 계정이면 플랜 다음이 바로 수동이라 '자동'을 누르면 수동으로 돌아간다. 다음 훅이 실제 값으로 바로잡는다
const MODE_CYCLE = ['default', 'acceptEdits', 'plan', 'auto']
const hookMode = (m: Mode) => (m === 'manual' ? 'default' : m)
const TERM_FONT = '"SF Mono", Menlo, "Cascadia Mono", Consolas, "Apple SD Gothic Neo", "Malgun Gothic", monospace'

const sessions = new Map<string, Session>() // 넣은 순서 = 목록 순서
let active: string | null = null
let config: Config
let buttons: Record<Role, Button[]> = { plan: [], dev: [] }
let lastBusy = -1

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
type Kid = Node | string | null | undefined | false
function h(tag: string, props: Record<string, any> = {}, ...kids: Kid[]): HTMLElement {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (v != null && v !== false) el.setAttribute(k, v === true ? '' : String(v))
  }
  for (const kid of kids) if (kid != null && kid !== false) el.append(kid)
  return el
}
const folderName = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd
const sessionName = (s: Session) => s.name ?? '새 세션'
// 보낼 수 있는 상태: 권한 선택 중(waiting)에 보내면 지연 Enter가 선택지를 눌러 버린다.
const canSend = (s?: Session | null): s is Session => !!s && (s.status === 'ready' || s.status === 'working' || s.status === 'done')
document.body.classList.add(`os-${api.platform}`)

// ── 터미널 테마(OS 다크 모드를 따른다) ──
const darkQuery = matchMedia('(prefers-color-scheme: dark)')
const DARK: ITheme = {
  background: '#151619', foreground: '#dfe2e7', cursor: '#dfe2e7', cursorAccent: '#151619', selectionBackground: '#3b4a66',
  black: '#1d1f23', red: '#ff6b6b', green: '#5fd08a', yellow: '#f2c14e', blue: '#5aa2ff', magenta: '#c49bff', cyan: '#5fd3e0', white: '#dfe2e7',
  brightBlack: '#6b7280', brightRed: '#ff8a8a', brightGreen: '#7ee2a4', brightYellow: '#ffd479', brightBlue: '#82b8ff', brightMagenta: '#d6b8ff', brightCyan: '#86e3ee', brightWhite: '#ffffff',
}
const LIGHT: ITheme = {
  background: '#ffffff', foreground: '#1d1f23', cursor: '#1d1f23', cursorAccent: '#ffffff', selectionBackground: '#cfe0ff',
  black: '#1d1f23', red: '#d1242f', green: '#1a7f37', yellow: '#9a6700', blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
  brightBlack: '#57606a', brightRed: '#e5534b', brightGreen: '#2da44e', brightYellow: '#bf8700', brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#8c959f',
}
const termTheme = () => (darkQuery.matches ? DARK : LIGHT)
darkQuery.addEventListener('change', () => {
  for (const s of sessions.values()) s.term.options.theme = termTheme()
})

// ── 세션 ──
function createTerm() {
  const el = h('div', { class: 'term' }) as HTMLDivElement
  $('terms').append(el)
  const term = new Terminal({
    fontFamily: TERM_FONT,
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true, // unicode11에 필요
    theme: termTheme(),
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11' // 한글·이모지 폭을 Claude Code와 맞춘다
  return { term, fit, el }
}

function openTerm(s: Session) {
  s.term.open(s.el)
  try {
    const gl = new WebglAddon()
    gl.onContextLoss(() => gl.dispose()) // 세션이 많아 WebGL이 모자라면 기본 렌더러로 돌아간다
    s.term.loadAddon(gl)
  } catch {}
  // Shift+Enter = 줄바꿈(Claude Code는 ESC+Enter를 줄바꿈으로 받는다)
  s.term.attachCustomKeyEventHandler((e) => {
    // Windows: 글자를 고른 채 Ctrl+C는 복사, Ctrl+V는 붙여 넣기(그냥 두면 xterm이 중단 신호로 보낸다).
    // 고른 글자가 없을 때의 Ctrl+C는 그대로 중단이다. 한글 입력 중에도 맞게 e.code로 본다.
    if (api.platform !== 'darwin' && e.ctrlKey && !e.altKey && !e.metaKey && (e.code === 'KeyV' || (e.code === 'KeyC' && s.term.hasSelection()))) {
      if (e.type === 'keydown') {
        e.preventDefault()
        if (e.code === 'KeyC') {
          navigator.clipboard.writeText(s.term.getSelection()).catch(() => {})
          s.term.clearSelection()
        } else navigator.clipboard.readText().then((t) => t && s.term.paste(t), () => {})
      }
      return false
    }
    if (e.key === 'Enter' && e.shiftKey) {
      if (e.type === 'keydown') api.write(s.tab, '\x1b\r')
      return false
    }
    return true
  })
  s.term.onData((d) => {
    api.write(s.tab, d)
    if (d === '\x1b[Z') s.mode = nextMode(s.mode) // 터미널에서 직접 Shift+Tab으로 모드를 바꿨다
    // Esc·Ctrl+C 중단(권한 거절 포함)에는 훅이 오지 않는다.
    // ponytail: Esc를 늘 중단으로 본다. 자동완성 닫기 등에서는 잠깐 '끝남'으로 잘못 보일 수 있다
    if ((s.status === 'working' || s.status === 'waiting') && (d === '\x1b' || d === '\x03')) endTurn(s)
    // 권한 선택은 Enter나 숫자로 답한다. 화살표·포커스 보고 등은 답이 아니다.
    // ponytail: 질문이 여러 개인 대화상자에서는 첫 Enter에 '작업 중'으로 바뀐다
    else if (s.status === 'waiting' && (d === '\r' || /^[1-9]$/.test(d))) setStatus(s, 'working')
  })
  s.term.onResize(({ cols, rows }) => api.resize(s.tab, cols, rows))
}

async function openSession(cwd: string, resume?: { id: string; name: string | null }): Promise<boolean> {
  const tab = crypto.randomUUID().replace(/-/g, '').slice(0, 12)
  $('empty-error').hidden = true
  if (!config.folders.includes(cwd)) saveConfig({ folders: [...config.folders, cwd] }) // 세션을 다 닫아도 폴더는 남긴다
  const s: Session = {
    tab, cwd, name: resume?.name ?? null, status: 'starting', pct: null, agents: new Map(), closing: false, sessionId: resume?.id,
    mode: hookMode(config.mode), effort: D.effort, ultracode: D.ultracode, usage: {}, hadPrompt: !!resume, turnStart: null, turnCost: null, model: D.model, advisor: D.advisor, ...createTerm(),
  }
  sessions.set(tab, s)
  activate(tab, false)
  openTerm(s) // 화면에 보이는 상태에서 열어야 글자 크기를 잴 수 있다
  s.fit.fit()
  s.term.focus() // 폴더 신뢰·로그인 질문은 터미널에서 바로 답한다
  render()
  const r = await api.newSession(tab, cwd, s.term.cols, s.term.rows, resume?.id)
  if ('error' in r) {
    removeSession(tab)
    if (sessions.size) api.alert(r.error) // 빈 화면이 안 보이므로 대화상자로
    else showError(r.error)
    return false
  }
  if (s.closing) {
    api.kill(tab) // 준비 중에 닫기를 눌렀다
    return false
  }
  // '준비됨'은 SessionStart 훅이 정한다. 그 전(폴더 신뢰 확인 화면 등)에 보내면 입력이 버려지거나 "No, exit"가 눌린다.
  loadInstructions(cwd) // main은 세션이 뜬 뒤에야 이 폴더를 읽게 해 준다
  return true
}

function removeSession(tab: string) {
  const s = sessions.get(tab)
  if (!s) return
  s.term.dispose()
  s.el.remove()
  sessions.delete(tab)
  if (active === tab) {
    const rest = [...sessions.keys()]
    active = null
    if (rest.length) activate(rest[rest.length - 1])
  }
  render()
}

async function closeSession(s: Session) {
  if (s.status === 'exited') return removeSession(s.tab)
  if (s.status === 'working' || s.status === 'waiting') {
    const ok = await api.confirm(`‘${sessionName(s)}’ 세션을 닫을까요?`, '진행 중인 작업이 멈춥니다. 나중에 ‘지난 작업 이어 하기’로 이어서 할 수 있습니다.', '닫기')
    if (!ok) return
  }
  s.closing = true
  api.kill(s.tab) // 종료되면 pty:exit로 목록에서 빠진다
}

function activate(tab: string, focus = true) {
  active = tab
  for (const s of sessions.values()) s.el.classList.toggle('on', s.tab === tab)
  const s = sessions.get(tab)
  if (s && focus) {
    requestAnimationFrame(() => {
      s.fit.fit()
      s.term.focus()
    })
  }
  render()
}

function setStatus(s: Session, status: Status) {
  s.status = status
  render()
}

function endTurn(s: Session) {
  s.status = 'done'
  s.agents.clear()
  render()
}

// 권한 질문은 터미널에서 답한다. 아무 곳에도 포커스가 없을 때만(입력 상자가 꺼진 뒤 등) 터미널로 옮긴다.
// 입력 상자에서 치는 중에 옮기면 다음 지시의 Enter가 권한 질문의 '예'를 눌러 버린다.
function focusTermForAnswer(s: Session) {
  if (s.tab === active && document.activeElement === document.body) s.term.focus()
}

// 중단: 터미널에서 Esc를 누른 것과 같다(권한 질문이면 거절).
function stop(s: Session) {
  api.write(s.tab, '\x1b')
  endTurn(s)
  s.term.focus()
}

function notify(s: Session, body: string) {
  if (document.hasFocus() && active === s.tab) return // 지금 보고 있는 세션이면 알리지 않는다
  api.notify(`${folderName(s.cwd)} · ${sessionName(s)}`, body, s.tab)
}

function showError(msg: string) {
  const el = $('empty-error')
  el.textContent = msg
  el.hidden = false
}

function sendText(text: string) {
  const s = active ? sessions.get(active) : null
  if (!canSend(s)) return
  // 여러 줄은 붙여 넣기(bracketed paste)로 보내야 줄마다 전송되지 않는다.
  api.write(s.tab, text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text)
  setTimeout(() => api.write(s.tab, '\r'), 40) // ponytail: 고정 지연, Enter가 씹히면 늘린다
}

// ── 훅 이벤트 ──
api.onHook((ev: HookEvent) => {
  const s = sessions.get(ev.tab)
  if (!s) return
  const before = [s.mode, s.effort].join()
  if (ev.mode) s.mode = ev.mode
  if (ev.effort) s.effort = ev.effort as Effort
  if (ev.sessionId) s.sessionId = ev.sessionId
  if (ev.usage) {
    s.usage = ev.usage
    const m = MODELS.find(([id]) => ev.usage!.model?.toLowerCase().includes(id))
    if (m) s.model = m[0] // 터미널에서 직접 /model로 바꾼 것도 반영
    // 한도는 계정 전체 값이라 어느 세션에서 왔든 가장 최근 값을 쓴다.
    if (ev.usage.five) {
      limits.five = ev.usage.five
      // ponytail: 한도는 계정 전체라 다른 세션이 동시에 일하면 그만큼 섞여 들어간다
      if (s.turnStart != null) s.turnCost = Math.max(0, ev.usage.five.pct - s.turnStart)
    }
    if (ev.usage.week) limits.week = ev.usage.week
    render()
  }
  if (before !== [s.mode, s.effort].join()) render()
  switch (ev.kind) {
    case 'SessionStart':
      if (s.status === 'starting') s.status = 'ready'
      if (ev.source === 'clear') {
        s.name = null
        s.pct = null
      }
      // /resume·/clear 뒤에는 Stop이 오지 않는다. compact는 작업 중 자동 압축일 수 있어 건드리지 않는다.
      if ((ev.source === 'resume' || ev.source === 'clear') && (s.status === 'working' || s.status === 'waiting')) return endTurn(s)
      break
    // PermissionRequest: 권한 대화상자가 뜨는 즉시 온다(Notification은 6초 뒤). 알림은 Notification이 보낸다.
    case 'UserPromptSubmit':
      s.status = 'working'
      s.turnStart = limits.five?.pct ?? null // 아직 한도 값이 없으면 이번 작업 사용량은 못 잰다
      s.turnCost = s.turnStart != null ? 0 : null
      s.hadPrompt = true
      if (!s.name && ev.prompt) s.name = ev.prompt.trim().split('\n')[0].slice(0, 60) || null
      break
    case 'Notification':
      if (ev.type === 'idle_prompt' && (s.status === 'working' || s.status === 'waiting')) return endTurn(s)
      if (!ev.type || !WAIT_TYPES.has(ev.type)) return
      s.status = 'waiting'
      focusTermForAnswer(s)
      notify(s, '입력을 기다리고 있습니다.')
      break
    case 'Stop':
      notify(s, '작업이 끝났습니다.')
      return endTurn(s)
    case 'StopFailure':
      notify(s, '오류로 멈췄습니다. 터미널을 확인해 주세요.')
      return endTurn(s)
    case 'SubagentStart':
      if (ev.agentId) s.agents.set(ev.agentId, ev.agentType || '에이전트')
      break
    case 'SubagentStop':
      if (ev.agentId) s.agents.delete(ev.agentId)
      break
    case 'status':
      if (ev.pct === s.pct) return
      s.pct = ev.pct ?? null
      break
    case 'PermissionRequest':
      s.status = 'waiting'
      focusTermForAnswer(s)
      break
    default:
      return
  }
  render()
})
api.onData((tab, data) => {
  sessions.get(tab)?.term.write(data)
  // Claude Code가 화면에 띄우는 업데이트 안내를 보고 업데이트 버튼을 보여 준다(누르기 전에는 아무것도 실행하지 않는다).
  // ponytail: 안내 문구가 출력 조각 사이에서 잘리면 놓친다. 다음 세션을 열 때 다시 뜬다
  const notice = /Update available!/.test(data) ? 'available' : /Restart to apply/.test(data) ? 'restart' : null
  if (notice && !updateAvailable) {
    updateAvailable = notice
    render()
  }
})
api.onExit((tab) => {
  const s = sessions.get(tab)
  if (!s || s.closing) return removeSession(tab)
  // 갑자기 끝나면 터미널을 남겨 claude가 출력한 이유를 볼 수 있게 한다.
  s.term.write('\r\n\x1b[2m[세션이 종료되었습니다. 왼쪽 목록에서 닫을 수 있습니다]\x1b[0m\r\n')
  s.agents.clear()
  setStatus(s, 'exited')
})
api.onFocusTab((tab) => sessions.has(tab) && activate(tab))

// ── 그리기 ──
// 한 프레임에 한 번만 그린다. 바뀐 부분만 다시 만들어서 누르는 중인 버튼이 사라지지 않게 한다.
let queued = false
const lastKey: Record<string, string> = {}
function render() {
  // 바쁜 세션 수는 바로 보낸다. 창을 내려 두면 rAF가 멈춰서 종료 경고가 틀어지기 때문이다.
  const busy = [...sessions.values()].filter((s) => s.status === 'working' || s.status === 'waiting').length
  if (busy !== lastBusy) api.setBusy((lastBusy = busy))
  persistSessions()
  if (queued) return
  queued = true
  requestAnimationFrame(() => {
    queued = false
    renderSidebar()
    renderMain()
    renderInspector()
  })
}
// 처음 그리는 줄에만 등장 효과를 준다(다시 그릴 때마다 목록 전체가 깜빡이지 않게).
const drawn = new Set<string>()
const enter = (key: string) => (drawn.has(key) ? '' : (drawn.add(key), ' enter'))
function changed(part: string, key: unknown) {
  const k = JSON.stringify(key)
  if (lastKey[part] === k) return false
  lastKey[part] = k
  return true
}

function renderSidebar() {
  const list = [...sessions.values()]
  if (!changed('sidebar', [active, config.folders, list.map((s) => [s.tab, s.cwd, s.name, s.status])])) return
  const groups = new Map<string, Session[]>(config.folders.map((f) => [f, []])) // 세션이 없는 폴더도 남긴다
  for (const s of list) groups.set(s.cwd, [...(groups.get(s.cwd) ?? []), s])
  const nav = $('folders')
  const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-tab]')?.dataset.tab
  nav.replaceChildren(
    ...[...groups].map(([cwd, items]) => {
      const working = items.filter((s) => s.status === 'working').length
      return h(
        'div',
        { class: 'folder' },
        h(
          'div',
          { class: 'folder-row', title: cwd },
          h('span', { class: 'folder-name' }, folderName(cwd)),
          h('span', { class: 'count' }, String(items.length)),
          working >= 2 && h('span', { class: 'warn' }, `${working}개 작업 중`),
          h(
            'span',
            { class: 'tools' },
            // 세션이 없는 폴더만 뺄 수 있다. 평소에는 숨겨 두고 줄에 마우스를 올리면 + 옆에 보인다.
            !items.length &&
              h('button', { class: 'add forget', title: '목록에서 빼기(폴더는 지우지 않음)', 'aria-label': '목록에서 빼기', onclick: async () => {
                if (!(await api.confirm(`‘${folderName(cwd)}’ 폴더를 목록에서 뺄까요?`, '목록에서만 빠지고, 폴더와 파일은 지워지지 않습니다.', '빼기'))) return
                saveConfig({ folders: config.folders.filter((f) => f !== cwd) })
                render()
              } }, '×'),
            h('button', { class: 'add', title: '이 폴더에 세션 추가', 'aria-label': '이 폴더에 세션 추가', onclick: () => openSession(cwd) }, '＋'),
          ),
        ),
        ...items.map((s) =>
          h(
            'div',
            {
              class: `session${s.tab === active ? ' on' : ''}${enter(s.tab)}`,
              role: 'button',
              tabindex: 0,
              'data-tab': s.tab,
              'aria-current': s.tab === active ? 'true' : false,
              onclick: () => activate(s.tab),
              onkeydown: (e: KeyboardEvent) => {
                if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
                e.preventDefault()
                activate(s.tab)
              },
            },
            h('i', { class: `dot ${s.status}` }),
            h('span', { class: 'name' }, sessionName(s)),
            h('span', { class: 'state' }, STATUS_LABEL[s.status]),
            h(
              'button',
              {
                class: 'close',
                title: '세션 닫기',
                'aria-label': '세션 닫기',
                onclick: (e: MouseEvent) => {
                  e.stopPropagation()
                  closeSession(s)
                },
              },
              '×',
            ),
          ),
        ),
      )
    }),
  )
  if (focused) nav.querySelector<HTMLElement>(`[data-tab="${focused}"]`)?.focus() // 다시 그려도 키보드 위치 유지
}

function renderMain() {
  const s = active ? sessions.get(active) : undefined
  const others = s ? [...sessions.values()].filter((o) => o !== s && o.cwd === s.cwd && o.status === 'working') : []
  if (!changed('main', [s?.tab, s?.name, s?.status, others.map((o) => o.name)])) return
  $('app').classList.toggle('has-session', !!s)
  $('crumb').textContent = s?.cwd ?? ''
  $('title').textContent = s ? folderName(s.cwd) : ''
  $('subtitle').replaceChildren(...(s ? [h('span', {}, sessionName(s)), h('span', { class: `chip ${s.status}` }, STATUS_LABEL[s.status])] : []))
  const notice = $('notice') // 머리 줄에 붙어 있어 나타나도 터미널을 가리거나 크기를 바꾸지 않는다
  notice.hidden = others.length === 0
  if (others.length) {
    const more = others.length > 1 ? ` 외 ${others.length - 1}개` : ''
    notice.replaceChildren('⚠ 같은 폴더에서 ', h('b', {}, `‘${sessionName(others[0])}’${more}`), '도 작업 중 · 같은 파일을 고칠 수 있음')
  }
  $<HTMLTextAreaElement>('input').disabled = !canSend(s)
  $<HTMLButtonElement>('send').disabled = !canSend(s)
  $('stop').hidden = !(s && (s.status === 'working' || s.status === 'waiting'))
  $<HTMLTextAreaElement>('input').placeholder =
    s?.status === 'starting' ? '준비 중입니다 · 터미널에 질문이 뜨면 터미널에서 답해 주세요'
    : s?.status === 'waiting' ? '터미널에서 답을 골라 주세요 (1·2·3 또는 Enter)'
    : s?.status === 'exited' ? '세션이 종료되었습니다'
    : '여기에 지시를 적습니다…'
}

function renderInspector() {
  const s = active ? sessions.get(active) : undefined
  const pct = s?.pct ?? null
  const level = pct == null ? 'none' : pct >= 75 ? 'high' : pct >= 60 ? 'mid' : 'low'
  if (changed('gauge', [pct, level])) {
    $('pct').textContent = pct == null ? '–' : `${Math.round(pct)}%`
    $('pct-label').textContent = { none: '', low: '여유 있음', mid: '압축 권장', high: '곧 자동 압축' }[level]
    $('fill').style.transform = `scaleX(${(pct ?? 0) / 100})`
    document.querySelector('.gauge')!.setAttribute('data-level', level)
  }
  renderUsage(s)
  renderRunSettings(s)
  renderUpdate()
  for (const b of $('buttons').children as HTMLCollectionOf<HTMLButtonElement>) b.disabled = !canSend(s)
  const fresh = $<HTMLButtonElement>('new-session')
  fresh.disabled = !s
  fresh.classList.toggle('suggest', level === 'mid' || level === 'high')
  const agents = s ? [...s.agents] : []
  if (s && changed('instructions-cwd', s.cwd)) loadInstructions(s.cwd)
  renderInstructions()
  if (changed('agents', agents)) {
    $('agents').replaceChildren(
      ...(agents.length
        ? agents.map(([id, type]) => h('div', { class: `agent${enter(id)}`, title: id }, h('i', { class: 'dot working' }), h('span', {}, type)))
        : [h('p', { class: 'muted' }, '지금 도는 에이전트가 없습니다')]),
    )
  }
}

// ── 한 번만 만드는 것들 ──
// ── 기획·개발 탭: 버튼 목록과 기본 지침이 바뀐다(세션은 그대로) ──
const ROLES: [Role, string, string][] = [
  ['plan', '기획', '웹게임 폴더를 열면 그 폴더에서 Claude가 작업합니다.'],
  ['dev', '개발', '프로젝트 폴더를 열면 그 폴더에서 Claude가 작업합니다. 저장소의 CLAUDE.md도 함께 따릅니다.'],
]
function buildRoles() {
  $('roles').replaceChildren(
    ...ROLES.map(([r, label]) => h('button', { class: 'seg', role: 'tab', 'data-value': r, onclick: () => setRole(r) }, label)),
  )
  renderRole()
}
function setRole(role: Role) {
  if (role === config.role) return
  saveConfig({ role })
  buildButtons()
  renderRole()
  render()
}
function renderRole() {
  for (const b of $('roles').children as HTMLCollectionOf<HTMLButtonElement>) b.setAttribute('aria-selected', String(b.dataset.value === config.role))
  $('empty-desc').textContent = ROLES.find(([r]) => r === config.role)![2]
  $('add-instructions').textContent = config.role === 'dev' ? '기본 지침 넣기 (개발)' : '기본 지침 넣기 (기획)'
}

// '편집'으로 고치고 돌아오면(창 포커스) 다시 읽는다. 바뀐 게 없으면 다시 만들지 않는다(누르는 중인 버튼이 사라지지 않게).
let buttonsKey = ''
let buttonsError = false
function applyButtons(r: LoadedButtons) {
  if (r.buttonsError && !buttonsError) api.alert('buttons.json 형식이 잘못되어 기본 버튼을 보여 줍니다. 쉼표·따옴표·괄호를 확인해 주세요.')
  buttonsError = r.buttonsError
  const key = JSON.stringify(r.buttons)
  if (key === buttonsKey) return
  buttonsKey = key
  buttons = r.buttons
  buildButtons()
  render()
}
addEventListener('focus', () => {
  if (config) api.loadButtons().then(applyButtons)
})

function buildButtons() {
  $('buttons').replaceChildren(
    ...buttons[config.role].map((b) => h('button', { class: 'btn', 'data-text': b.text, title: b.text, disabled: true, onclick: () => {
      sendText(b.text)
      if (active) sessions.get(active)?.term.focus() // 버튼에 포커스가 남으면 Enter가 같은 명령을 다시 보낸다
    } }, b.label)),
  )
}

// ── 실행 설정: 새 세션의 기본값이면서, 지금 세션에도 바로 보낸다 ──
const nextMode = (m: string) => MODE_CYCLE[(MODE_CYCLE.indexOf(m) + 1) % MODE_CYCLE.length] ?? 'default'
const activeSession = () => (active ? sessions.get(active) : undefined)
const saveConfig = (patch: Partial<Config>) => api.setConfig((config = { ...config, ...patch }))
// 지금 세션에 바로 보낼 수 있는가(권한 대화상자·시작 중·종료 뒤에는 보내지 않는다)
const live = () => {
  const s = activeSession()
  return s && canSend(s) ? s : undefined
}

// 아래 넷은 지금 세션에만 적용한다(저장하지 않음). 새 세션은 늘 SESSION_DEFAULTS로 시작한다.
function setEffort(level: Effort) {
  const s = live()
  if (s) {
    s.effort = level
    sendText(`/effort ${level}`)
  }
  render()
}

function setUltracode(on: boolean) {
  const s = live()
  if (s) {
    s.ultracode = on
    sendText(`/effort ultracode ${on ? 'on' : 'off'}`)
  }
  render()
}

function setMode(mode: Mode) {
  saveConfig({ mode })
  const s = live()
  const target = hookMode(mode)
  if (s && MODE_CYCLE.includes(s.mode)) {
    // 원하는 모드가 될 때까지 Shift+Tab을 보낸다. 한꺼번에 보내면 일부가 씹혀서 조금씩 띄운다.
    const n = (MODE_CYCLE.indexOf(target) - MODE_CYCLE.indexOf(s.mode) + MODE_CYCLE.length) % MODE_CYCLE.length
    for (let i = 0; i < n; i++) setTimeout(() => api.write(s.tab, '\x1b[Z'), i * 80)
    s.mode = target
  }
  render()
}

// 모델·어드바이저: 인자를 주면 Claude Code가 고르는 화면 없이 바로 바꾼다(/model sonnet, /advisor opus|off).
function setModel(model: Model) {
  const s = live()
  if (s) {
    s.model = model
    sendText(`/model ${model}`)
  }
  render()
}
function setAdvisor(advisor: Model | 'off') {
  const s = live()
  if (s) {
    s.advisor = advisor
    sendText(`/advisor ${advisor}`)
  }
  render()
}
const seg = <T extends string>(value: T, label: string, pick: (v: T) => void) =>
  h('button', { class: 'seg', role: 'radio', 'data-value': value, onclick: () => pick(value) }, label)

function buildRunSettings() {
  $('models').replaceChildren(...MODELS.map(([m, label]) => seg(m, label, setModel)))
  $('advisors').replaceChildren(...ADVISORS.map(([m, label]) => seg(m, label, setAdvisor)))
  const slider = $<HTMLInputElement>('effort')
  const showEffort = () => {
    $('effort-label').textContent = EFFORTS[+slider.value][1]
    $('effort-desc').textContent = EFFORTS[+slider.value][2]
  }
  slider.addEventListener('input', showEffort)
  slider.addEventListener('change', () => setEffort(EFFORTS[+slider.value][0]))
  $('modes').replaceChildren(
    ...MODES.map(([m, label]) => h('button', { class: 'seg', role: 'radio', 'data-mode': m, onclick: () => setMode(m) }, label)),
  )
  const sw = (id: string, onToggle: (on: boolean) => void) =>
    $(id).addEventListener('click', () => onToggle($(id).getAttribute('aria-checked') !== 'true'))
  sw('ultracode', setUltracode)
  sw('auto-compact', (on) => {
    saveConfig({ autoCompact: on })
    render()
  })
}

function renderRunSettings(s?: Session) {
  const effort = s?.effort ?? D.effort
  const i = Math.max(0, EFFORTS.findIndex(([e]) => e === effort))
  const slider = $<HTMLInputElement>('effort')
  if (document.activeElement !== slider) slider.value = String(i) // 끌고 있는 중에는 건드리지 않는다
  $('effort-label').textContent = EFFORTS[+slider.value][1]
  $('effort-desc').textContent = EFFORTS[+slider.value][2]
  const checks = (id: string, value: string) => {
    for (const b of $(id).children as HTMLCollectionOf<HTMLButtonElement>) b.setAttribute('aria-checked', String(b.dataset.value === value))
  }
  const model = s?.model ?? D.model
  const adv = s?.advisor ?? D.advisor
  checks('models', model)
  checks('advisors', adv)
  $('model-desc').textContent = MODELS.find(([m]) => m === model)?.[2] ?? ''
  $('advisor-desc').textContent = ADVISORS.find(([m]) => m === adv)?.[2] ?? ''
  const mode = s?.mode ?? hookMode(config.mode)
  for (const b of $('modes').children as HTMLCollectionOf<HTMLButtonElement>) {
    b.setAttribute('aria-checked', String(hookMode(b.dataset.mode as Mode) === mode))
  }
  $('mode-desc').textContent = mode === 'acceptEdits' ? ACCEPT_EDITS_DESC : (MODES.find(([m]) => hookMode(m) === mode)?.[2] ?? '')
  $('ultracode').setAttribute('aria-checked', String(s?.ultracode ?? D.ultracode))
  $('auto-compact').setAttribute('aria-checked', String(config.autoCompact))
  // 모델·어드바이저·생각 수준·울트라코드는 지금 세션에 보내는 것이라, 보낼 수 없을 때는 끈다.
  const can = !!s && canSend(s)
  for (const id of ['models', 'advisors']) for (const b of $(id).children as HTMLCollectionOf<HTMLButtonElement>) b.disabled = !can
  $<HTMLInputElement>('effort').disabled = !can
  $<HTMLButtonElement>('ultracode').disabled = !can
}

// ── 플러그인 설치 창(첫 실행 때 한 번, 그 뒤에는 '플러그인 관리'로) ──
let setupBusy = false
const setupFailed = new Set<string>() // 실패한 줄은 다시 그려도 실패했다고 남긴다
async function openSetup() {
  $('app').inert = true
  $('setup-scrim').hidden = false
  $('setup-list').replaceChildren(h('p', { class: 'muted' }, '설치 상태를 확인하는 중…'))
  renderSetup(await api.setupStatus())
}
function closeSetup() {
  if (setupBusy) return // 설치 도중에 닫으면 결과를 보여 줄 곳이 없다
  $('setup-scrim').hidden = true
  $('app').inert = false
  if (!config.setupSeen) saveConfig({ setupSeen: true })
}
function renderSetup(items: SetupItem[] | null) {
  const all = $<HTMLButtonElement>('setup-all')
  if (!items) {
    $('setup-list').replaceChildren(h('p', { class: 'error' }, 'claude를 찾을 수 없습니다. Claude Code를 설치한 뒤 다시 열어 주세요.'))
    all.disabled = true
    return
  }
  all.disabled = setupBusy || items.every((it) => it.installed)
  $('setup-list').replaceChildren(
    ...items.map((it) =>
      h(
        'div',
        { class: 'setup-row' },
        h('div', {}, h('b', {}, it.label), h('p', {}, it.desc),
          it.note && h('p', { class: 'warn-text' }, it.note),
          !it.installed && setupFailed.has(it.id) && h('p', { class: 'warn-text' }, '설치하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 눌러 주세요.')),
        it.installed
          ? h('span', { class: 'installed' }, '설치됨')
          : h('button', { class: 'pill', 'data-id': it.id, disabled: setupBusy, onclick: () => installAll([it.id]) }, setupFailed.has(it.id) ? '다시 설치' : '설치'),
      ),
    ),
  )
}
async function installAll(ids: string[]) {
  if (setupBusy) return
  setupBusy = true
  $<HTMLButtonElement>('setup-all').disabled = true
  for (const id of ids) {
    const btn = document.querySelector<HTMLButtonElement>(`#setup-list [data-id="${id}"]`)
    if (btn) {
      btn.disabled = true
      btn.classList.add('loading')
      btn.textContent = '설치 중'
    }
    // 오류가 나도 실패로 보고 넘어간다(창이 잠기지 않게)
    if (await api.install(id).catch(() => false)) setupFailed.delete(id)
    else setupFailed.add(id)
  }
  setupBusy = false
  renderSetup(await api.setupStatus())
}

// ── 지침(CLAUDE.local.md) ──
const instructions = new Map<string, Instructions>() // 폴더별
async function loadInstructions(cwd: string) {
  const r = await api.readInstructions(cwd)
  if (r) instructions.set(cwd, r)
  renderInstructions()
}
function renderInstructions() {
  const s = active ? sessions.get(active) : undefined
  const r = s ? instructions.get(s.cwd) : undefined
  const state = $('instructions-state')
  $<HTMLButtonElement>('edit-instructions').disabled = !r?.exists || !!r.tooLarge
  $('add-instructions').hidden = !r || r.exists
  if (!s) state.textContent = '세션을 열면 이 폴더의 지침을 보여 줍니다'
  else if (!r) state.textContent = '읽는 중…'
  else if (r.tooLarge) state.textContent = 'CLAUDE.local.md가 너무 커서 여기서 고칠 수 없습니다'
  else if (r.exists) state.textContent = `CLAUDE.local.md · ${r.text ? r.text.replace(/\n$/, '').split('\n').length : 0}줄`
  else state.textContent = '이 폴더에는 개인 지침이 없습니다'
}

let sheetCwd: string | null = null
let sheetOriginal = ''
const sheetText = $<HTMLTextAreaElement>('sheet-text')
function openSheet(cwd: string, text: string) {
  sheetCwd = cwd
  sheetText.value = text
  sheetOriginal = sheetText.value // textarea가 줄바꿈을 바꿔 담으므로 담긴 값과 비교한다
  $('sheet-path').textContent = `${cwd}${api.platform === 'win32' ? '\\' : '/'}CLAUDE.local.md`
  $('app').inert = true // 시트가 떠 있는 동안 뒤의 터미널로 입력이 가지 않게
  $('sheet-scrim').hidden = false
  requestAnimationFrame(() => sheetText.focus())
}
async function closeSheet(force = false) {
  if (!force && sheetText.value !== sheetOriginal && !(await api.confirm('저장하지 않고 닫을까요?', '고친 내용이 사라집니다.', '닫기'))) return
  $('sheet-scrim').hidden = true
  $('app').inert = false
  sheetCwd = null
  if (active) sessions.get(active)?.term.focus()
}
async function saveSheet() {
  if (!sheetCwd) return
  const cwd = sheetCwd
  if (!(await api.saveInstructions(cwd, sheetText.value))) return api.alert('지침을 저장하지 못했습니다.')
  await closeSheet(true)
  loadInstructions(cwd)
}
// 열 때마다 다시 읽는다. 그사이 Claude가 파일을 고쳤을 수 있어서, 옛 내용으로 덮어쓰지 않게 하기 위해서다.
async function editInstructions() {
  const s = active ? sessions.get(active) : undefined
  if (!s) return
  const r = await api.readInstructions(s.cwd)
  if (!r || r.tooLarge) return loadInstructions(s.cwd)
  instructions.set(s.cwd, r)
  openSheet(s.cwd, r.exists ? r.text : await api.instructionsTemplate(config.role)) // 없으면 기본 지침. 저장해야 파일이 생긴다
}
$('edit-instructions').addEventListener('click', editInstructions)
$('add-instructions').addEventListener('click', editInstructions)
$('sheet-cancel').addEventListener('click', () => closeSheet())
$('sheet-save').addEventListener('click', saveSheet)
document.addEventListener('keydown', (e) => {
  if (!sheetCwd) return
  if (e.key === 'Escape') closeSheet()
  if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    saveSheet()
  }
})

// ── Claude Code 업데이트: 작업 중인 세션이 없을 때만, 업데이트 뒤 세션을 이어서 다시 연다 ──
let updateAvailable: false | 'available' | 'restart' = false // 'restart' = 이미 설치됐고 다시 시작만 하면 된다
// 진행은 카드 안에 바로 보여 준다(창을 오가도 사라지지 않게). 끝난 결과는 '확인'을 누를 때까지 남긴다.
let updatePhase: 'idle' | 'running' | 'ok' | 'fail' = 'idle'
function renderUpdate() {
  const busy = [...sessions.values()].some((s) => s.status === 'working' || s.status === 'waiting' || s.status === 'starting')
  $('update-card').hidden = !updateAvailable && updatePhase === 'idle'
  const btn = $<HTMLButtonElement>('update-run')
  btn.hidden = updatePhase === 'running'
  btn.textContent = updatePhase === 'ok' ? '확인' : updatePhase === 'fail' ? '다시 시도' : '업데이트'
  btn.disabled = updatePhase !== 'ok' && busy
  $('update-note').hidden = updatePhase !== 'idle'
  $('update-note').textContent = busy ? '작업 중인 세션이 끝나면 업데이트할 수 있습니다.' : '누르면 업데이트한 뒤 열려 있는 세션을 이어서 다시 엽니다.'
  $('update-status').hidden = updatePhase === 'idle'
  updateLog.hidden = updatePhase === 'idle'
}
const updateLog = $('update-log')
const stripAnsi = (t: string) => t.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '').replace(/\r(?!\n)/g, '\n')
api.onUpdateProgress((text) => {
  if (updatePhase === 'running') $('update-status').textContent = `업데이트하는 중입니다 · ${text}`
})
api.onUpdateLog((text) => {
  updateLog.textContent += stripAnsi(text)
  updateLog.scrollTop = updateLog.scrollHeight
})
function updateStatus(text: string, state: 'running' | 'ok' | 'fail') {
  updatePhase = state
  const el = $('update-status')
  el.textContent = text
  el.className = `update-status ${state}`
  render()
}

// 세션을 먼저 닫고 업데이트한 뒤 다시 연다. Windows는 실행 중인 claude.exe를 바꿀 수 없어서다.
// 실패해도 세션은 다시 열어 둔다(대화가 있던 세션은 --resume으로 이어서, 없던 세션은 새로).
async function runUpdate() {
  if (updatePhase === 'ok') {
    updatePhase = 'idle' // 결과 확인
    return render()
  }
  updateLog.textContent = ''
  updateStatus('세션을 잠시 닫는 중입니다…', 'running')
  const reopen = [...sessions.values()]
    .filter((s) => s.status !== 'exited')
    .map((s) => ({ cwd: s.cwd, id: s.hadPrompt ? s.sessionId : undefined, name: s.name }))
  for (const s of [...sessions.values()]) {
    if (s.status === 'exited') removeSession(s.tab)
    else {
      s.closing = true
      api.kill(s.tab)
    }
  }
  await new Promise<void>((resolve) => {
    const started = Date.now()
    const t = setInterval(() => {
      if (!sessions.size || Date.now() - started > 5000) {
        clearInterval(t)
        resolve()
      }
    }, 100)
  })
  updateStatus('업데이트하는 중입니다… 끝날 때까지 기다려 주세요.', 'running')
  const r = await api.updateClaude()
  const ok = !!r?.ok && (r.before !== r.after || updateAvailable === 'restart')
  if (ok) updateAvailable = false
  for (const it of reopen) await openSession(it.cwd, it.id ? { id: it.id, name: it.name } : undefined)
  if (r?.note) updateStatus(`${r.note} 세션은 다시 열었습니다.`, 'fail')
  else if (!r || !r.ok) updateStatus('업데이트하지 못했습니다. 세션은 다시 열었습니다. 아래 기록을 확인해 주세요.', 'fail')
  else if (!ok) updateStatus(`새 버전이 설치되지 않았습니다 (${r.after || '?'}). 세션은 다시 열었습니다. 아래 기록을 확인해 주세요.`, 'fail')
  else updateStatus(`업데이트를 마쳤습니다 (${r.before || '?'} → ${r.after || '?'}). 세션 ${reopen.length}개를 이어서 다시 열었습니다.`, 'ok')
  render()
}

// ── 사용량: 컨텍스트(세션별)와 사용 한도(계정 전체) ──
const limits: { five?: Limit; week?: Limit } = {}
const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
const resetText = (sec?: number) => {
  if (!sec) return ''
  const d = new Date(sec * 1000)
  const sameDay = d.toDateString() === new Date().toDateString()
  const fmt = new Intl.DateTimeFormat('ko-KR', sameDay ? { hour: 'numeric', minute: '2-digit' } : { month: 'long', day: 'numeric', weekday: 'short', hour: 'numeric', minute: '2-digit' })
  return ` · ${fmt.format(d)} 초기화`
}
function renderLimit(id: string, l?: Limit) {
  $(`${id}-row`).hidden = !l
  if (!l) return
  $(`${id}-pct`).textContent = `${Math.round(l.pct)}% 사용 · ${Math.max(0, 100 - Math.round(l.pct))}% 남음`
  $(`${id}-fill`).style.transform = `scaleX(${Math.min(l.pct, 100) / 100})`
  $(`${id}-row`).dataset.level = l.pct >= 90 ? 'high' : l.pct >= 70 ? 'mid' : 'low'
  $(`${id}-reset`).textContent = resetText(l.resets).replace(/^ · /, '')
}
function renderUsage(s?: Session) {
  const u = s?.usage ?? {}
  const pct = s?.pct ?? null
  const parts = [
    u.tokens != null && u.size ? `${k(u.tokens)} / ${k(u.size)} 토큰` : '',
    pct != null ? `${Math.max(0, 100 - Math.round(pct))}% 남음` : '',
    u.model ?? '',
  ].filter(Boolean)
  $('ctx-detail').textContent = parts.length ? parts.join(' · ') : s ? '첫 응답이 오면 보입니다' : ''
  // 이번 작업이 5시간 한도를 얼마나 썼는지: 비싼 설정이 실제로 얼마나 드는지 눈으로 보게 한다.
  const cost = s?.turnCost
  $('turn-cost').hidden = cost == null
  if (cost != null) {
    const amount = cost < 1 ? '1% 미만' : `${Math.round(cost)}%`
    $('turn-cost').textContent = `${s!.status === 'working' || s!.status === 'waiting' ? '이번 작업' : '지난 작업'}: 5시간 한도 ${amount} 사용`
  }
  renderLimit('five', limits.five)
  renderLimit('week', limits.week)
  $('limits-empty').hidden = !!(limits.five || limits.week)
  renderCache()
}
// 캐시가 식기 전에 보내면 싸게 이어지고, 식은 뒤에는 대화 전체를 제값에 다시 읽는다.
function renderCache() {
  const exp = activeSession()?.usage.cacheExpires
  const el = $('cache')
  el.hidden = !exp
  if (!exp) return
  const left = Math.round(exp - Date.now() / 1000)
  el.dataset.state = left > 0 ? 'warm' : 'cold'
  el.textContent = left > 0
    ? `캐시 ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} 남음 · 그 안에 보내면 사용량이 적습니다`
    : '캐시가 식었습니다 · 다음 메시지는 대화 전체를 다시 읽습니다'
}
setInterval(renderCache, 1000)

async function pickAndOpen() {
  const dir = await api.pickFolder()
  if (dir) openSession(dir)
}

// ── 입력 상자 ──
const input = $<HTMLTextAreaElement>('input')
function autosize() {
  input.style.height = 'auto'
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`
}
function submit() {
  const text = input.value.replace(/\s+$/, '')
  if (!text.trim()) return
  sendText(text)
  input.value = ''
  autosize()
}
input.addEventListener('input', autosize)
input.addEventListener('keydown', (e) => {
  const s = activeSession()
  if (e.key === 'Escape' && !e.isComposing && s?.status === 'working') {
    e.preventDefault()
    return stop(s)
  }
  // 한글 조합 중 Enter(isComposing, keyCode 229)는 글자 확정이므로 보내지 않는다.
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault()
    submit()
  }
})
$('composer').addEventListener('submit', (e) => {
  e.preventDefault()
  submit()
})

// 창 크기가 바뀌면 보이는 터미널만 다시 맞춘다(한 프레임에 한 번).
let fitQueued = false
new ResizeObserver(() => {
  if (fitQueued) return
  fitQueued = true
  requestAnimationFrame(() => {
    fitQueued = false
    const s = active ? sessions.get(active) : undefined
    s?.fit.fit()
  })
}).observe($('terms'))

$('open-folder').addEventListener('click', pickAndOpen)
$('empty-open').addEventListener('click', pickAndOpen)
// 대화가 길어졌을 때 바꿔 타는 버튼이다. 쉬고 있던 이전 세션은 닫아서 세션이 쌓이지 않게 한다
// (대화는 '지난 작업 이어 하기'로 되살릴 수 있다). 작업 중인 세션은 그대로 둔다.
$('new-session').addEventListener('click', async () => {
  const s = active ? sessions.get(active) : undefined
  if (!s || !(await openSession(s.cwd))) return
  if (s.status === 'ready' || s.status === 'done' || s.status === 'exited') closeSession(s)
})
$('stop').addEventListener('click', () => {
  const s = activeSession()
  if (s && (s.status === 'working' || s.status === 'waiting')) stop(s)
})
$('edit-buttons').addEventListener('click', () => api.editButtons())
$('open-setup').addEventListener('click', openSetup)
$('update-run').addEventListener('click', runUpdate)
$('setup-close').addEventListener('click', closeSetup)
$('setup-all').addEventListener('click', async () => {
  const items = await api.setupStatus()
  if (items) installAll(items.filter((it) => !it.installed).map((it) => it.id))
})
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('setup-scrim').hidden) closeSetup()
})

// ── 사용법 안내(첫 실행 때, 그 뒤에는 '사용법'으로): 실제 화면의 해당 부분을 밝히며 하나씩 설명한다 ──
interface Step {
  target?: () => Element | null // 밝힐 곳. 없으면 가운데 안내
  title: string
  body: () => Node[]
}
const p = (...kids: Kid[]) => h('p', {}, ...kids)
const em = (t: string) => h('b', { class: 'em' }, t)
const card = (id: string) => () => document.getElementById(id)?.closest('.card') ?? null
const costBars = () =>
  h('div', { class: 'tour-bars' }, ...MODELS.map(([, label], i) =>
    h('div', { class: 'tour-bar' }, h('span', {}, label.split(' ')[0]), h('i', { style: `--w:${[25, 50, 100][i]}%` }), h('b', {}, label.split(' ')[1]))))
const STEPS: Step[] = [
  { title: '기획 도우미에 오신 것을 환영합니다', body: () => [
    p('Claude에게 웹게임 프로토타입과 기획서를 맡기는 프로그램입니다. 명령어를 몰라도 버튼과 입력 상자로 쓸 수 있습니다.'),
    p('1분이면 둘러볼 수 있습니다. ', em('→'), ' 를 눌러 시작하세요.'),
  ] },
  { target: () => $('roles'), title: '기획 · 개발', body: () => [
    p('기획자는 ', em('기획'), ', 개발자는 ', em('개발'), ' 탭을 고르세요. 오른쪽 버튼과 기본 지침이 그 일에 맞게 바뀝니다.'),
  ] },
  { target: () => $('sidebar'), title: '폴더와 세션', body: () => [
    p(em('새 폴더 열기'), '로 작업할 폴더를 고르면 그 폴더에서 Claude가 일합니다. 대화 하나가 ', em('세션'), ' 하나입니다.'),
    p('폴더 옆 ', em('＋'), '로 같은 폴더에 세션을 더 열 수 있습니다. 앱을 껐다 켜도 열려 있던 세션은 그대로 이어집니다.'),
  ] },
  { target: () => $('stage'), title: 'Claude가 일하는 화면', body: () => [
    p('여기에 Claude의 작업이 그대로 보입니다. 파일을 고쳐도 되는지 물어보면 ', em('1·2·3'), ' 중 하나를 누르면 됩니다.'),
  ] },
  { target: () => $('composer'), title: '지시는 여기에', body: () => [
    p('하고 싶은 일을 평소 말투로 적고 ', em('Enter'), '를 누릅니다. 줄을 바꾸려면 Shift+Enter입니다.'),
    p('한 번에 하나씩, 무엇을 바꾸고 싶은지 구체적으로 적을수록 결과가 좋고 사용량도 적습니다.'),
  ] },
  { target: card('buttons'), title: '자주 쓰는 일은 버튼으로', body: () => [
    p(em('작업 커밋'), '은 지금까지 한 일을 저장합니다. ', em('노션 동기화'), '와 ', em('노션에 반영'), '은 기획서를 주고받습니다.'),
    p('결과가 의심될 때만 ', em('고급 검수'), '를 누르세요. 그때만 Opus가 검사합니다.'),
  ] },
  { target: card('pct'), title: '사용량 보기', body: () => [
    p(em('컨텍스트'), '는 대화가 얼마나 찼는지입니다. 노랗게 되면 ', em('같은 폴더에 새 세션'), '이 압축보다 쌉니다.'),
    p(em('캐시'), '가 남아 있을 때 이어서 보내면 사용량이 적습니다. 플레이하다 오래 쉬면 다음 메시지는 대화 전체를 다시 읽습니다.'),
    p(em('이번 작업'), '이 5시간 한도를 얼마나 썼는지도 여기 보입니다.'),
  ] },
  { target: card('models'), title: '모델과 생각 수준', body: () => [
    p('새 세션은 늘 ', em('Sonnet + 어드바이저 Opus'), '로 시작합니다. 평소 일은 Sonnet이 하고, 중요한 판단만 Opus에게 묻는 조합입니다.'),
    costBars(),
    p('더 강한 모델은 그 세션에만 잠깐 쓰세요. 다음 세션은 다시 Sonnet으로 시작합니다.'),
  ] },
  { title: 'AI를 현명하게 쓰는 법', body: () => [
    h('ul', { class: 'tour-tips' },
      h('li', {}, em('작업 하나 = 세션 하나.'), ' 끝나면 새 세션으로. 긴 대화는 메시지마다 비싸집니다.'),
      h('li', {}, em('수치는 직접.'), ' 속도·쿨타임은 화면의 조정 패널이나 데이터 파일에서 바로 바꾸세요. AI에게 물을 필요가 없습니다.'),
      h('li', {}, em('시뮬레이션은 스크립트로.'), ' 항목마다 AI가 머리로 계산하게 하지 말고, 한 번 만든 스크립트를 돌리게 하세요.'),
      h('li', {}, em('노션은 동기화로 읽기.'), ' 매번 노션에서 가져오지 말고 동기화된 파일을 읽게 하세요.'),
      h('li', {}, em('비싼 설정은 잠깐만.'), ' Opus·Fable·울트라코드는 어려운 작업에만 켜세요.'),
    ),
  ] },
  { target: card('instructions-state'), title: '지침', body: () => [
    p('폴더마다 Claude가 늘 지킬 규칙을 적어 둘 수 있습니다. ', em('기본 지침 넣기'), '를 누르면 위 습관들이 들어간 지침이 기획·개발 탭에 맞게 채워집니다.'),
  ] },
  { target: () => $('open-tour'), title: '준비 끝', body: () => [
    p('이 안내는 언제든 왼쪽 아래 ', em('사용법'), '에서 다시 볼 수 있습니다. 이제 폴더를 열어 시작해 보세요.'),
  ] },
]
let tourStep = -1
function openTour() {
  tourStep = 0
  $('tour').hidden = false
  showStep()
}
function closeTour() {
  $('tour').hidden = true
  tourStep = -1
  if (!config.tutorialSeen) {
    saveConfig({ tutorialSeen: true })
    if (!config.setupSeen) openSetup()
  }
}
function showStep() {
  const step = STEPS[tourStep]
  const el = step.target?.()
  el?.scrollIntoView({ block: 'nearest' })
  requestAnimationFrame(() => {
    const spot = $('tour-spot')
    if (el) {
      const r = el.getBoundingClientRect()
      const pad = 6
      Object.assign(spot.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px`, opacity: '1' })
    } else {
      Object.assign(spot.style, { left: '50%', top: '50%', width: '0px', height: '0px', opacity: '1' }) // 가운데로 모으면 화면 전체가 어두워진다
    }
    $('tour').classList.toggle('centered', !el)
  })
  $('tour-title').textContent = step.title
  $('tour-body').replaceChildren(...step.body())
  $('tour-count').textContent = `${tourStep + 1} / ${STEPS.length}`
  $('tour-progress').style.transform = `scaleX(${(tourStep + 1) / STEPS.length})`
  $<HTMLButtonElement>('tour-prev').disabled = tourStep === 0
  $('tour-next').textContent = tourStep === STEPS.length - 1 ? '시작하기' : '→'
}
function moveTour(d: number) {
  const next = tourStep + d
  if (next >= STEPS.length) return closeTour()
  if (next < 0) return
  tourStep = next
  showStep()
}
$('tour-prev').addEventListener('click', () => moveTour(-1))
$('tour-next').addEventListener('click', () => moveTour(1))
$('tour-close').addEventListener('click', closeTour)
$('open-tour').addEventListener('click', openTour)
document.addEventListener('keydown', (e) => {
  if (tourStep < 0) return
  if (e.key === 'ArrowRight' || e.key === 'Enter') moveTour(1)
  else if (e.key === 'ArrowLeft') moveTour(-1)
  else if (e.key === 'Escape') closeTour()
  else return
  e.preventDefault()
})
addEventListener('resize', () => tourStep >= 0 && showStep())

// ── 앱을 다시 켜면 열려 있던 세션을 그대로: 대화가 있던 세션은 --resume으로 이어서, 없던 세션은 새로 연다 ──
let restoring = true // 되살리는 동안에는 목록을 저장하지 않는다(덮어써서 잃지 않게)
function persistSessions() {
  if (restoring) return
  const list = [...sessions.values()].filter((s) => s.status !== 'exited')
  const saved = list.map((s) => ({ cwd: s.cwd, id: s.hadPrompt ? s.sessionId : undefined, name: s.name }))
  const activeIndex = Math.max(0, list.findIndex((s) => s.tab === active))
  if (!changed('persist', [saved, activeIndex])) return
  saveConfig({ sessions: saved, active: activeIndex })
}

api.init().then(async (r) => {
  config = r.config
  buildRoles()
  buildRunSettings()
  applyButtons(r)
  render()
  const saved = config.sessions ?? []
  for (const it of saved) await openSession(it.cwd, it.id ? { id: it.id, name: it.name } : undefined)
  const tabs = [...sessions.keys()]
  if (tabs.length) activate(tabs[Math.min(config.active ?? 0, tabs.length - 1)])
  restoring = false
  render()
  // 처음 켤 때: 사용법 → 플러그인 설치 순서로 안내한다.
  if (!config.tutorialSeen) openTour()
  else if (!config.setupSeen) openSetup()
})
