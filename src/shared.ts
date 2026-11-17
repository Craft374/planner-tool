// main ↔ preload ↔ renderer가 함께 쓰는 타입

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type Role = 'plan' | 'dev' // 위쪽 탭: 기획·개발(버튼과 기본 지침이 바뀐다)
export type Model = 'sonnet' | 'opus' | 'fable'
export type Mode = 'manual' | 'plan' | 'auto' // claude --permission-mode 값(훅에서는 manual이 'default'로 온다)

/** 저장해 두는 설정. 모델·어드바이저·생각 수준·울트라코드는 저장하지 않는다(세션마다 SESSION_DEFAULTS로 시작). */
// 새 세션은 늘 이 값으로 시작한다. 비싼 설정이 다음 세션까지 굳지 않게 하기 위해서다.
// Sonnet + 어드바이저 Opus는 Claude Code가 권하는 조합이다("near-Opus performance with reduced token usage").
export const SESSION_DEFAULTS = { model: 'sonnet', advisor: 'opus', effort: 'high', ultracode: false } as const satisfies {
  model: Model
  advisor: Model | 'off'
  effort: Effort
  ultracode: boolean
}

export interface SavedSession {
  cwd: string
  id?: string // 대화가 있었던 세션만(없으면 새로 연다)
  name: string | null
  named?: boolean // 사용자가 직접 지은 이름(/clear로 지우지 않는다)
}

export interface Config {
  role: Role
  autoCompact: boolean
  mode: Mode
  setupSeen: boolean // 첫 실행 때 플러그인 설치 창을 한 번 보여 줬는가
  folders: string[] // 세션을 모두 닫아도 목록에 남길 폴더
  sessions: SavedSession[] // 앱을 다시 켜면 이어서 열 세션
  active: number // 마지막에 보던 세션(sessions의 순번)
  tutorialSeen: boolean
}

export interface SetupItem {
  id: string
  label: string
  desc: string
  installed: boolean
  note?: string
}

export interface Instructions {
  exists: boolean
  text: string
  tooLarge?: boolean
}

export interface SlashCommand {
  name: string // 앞의 / 없이(플러그인은 plugin:이름)
  desc: string
}

export interface Button {
  label: string
  text: string
}

export interface Limit {
  pct: number // 사용한 %
  resets?: number // 초기화 시각(유닉스 초)
}

/** 상태줄로 받는 사용량. 한도(five·week)는 계정 전체 값이다. */
export interface Usage {
  tokens?: number // 지금 컨텍스트에 든 입력 토큰
  size?: number // 컨텍스트 창 크기
  five?: Limit // 5시간 한도
  week?: Limit // 주간 한도
  cacheExpires?: number // 프롬프트 캐시가 식는 시각(유닉스 초)
  model?: string
}

/** 훅·상태줄이 보낸 것을 main이 필요한 필드만 골라 renderer로 넘긴다. */
export interface HookEvent {
  tab: string
  kind: string // 훅 이름(SessionStart, Stop …) 또는 'status'(상태줄)
  prompt?: string
  type?: string // Notification의 notification_type
  agentId?: string
  agentType?: string
  source?: string // SessionStart의 source
  pct?: number | null // 상태줄 context_window.used_percentage
  mode?: string // 훅 공통 필드 permission_mode
  effort?: string // effort.level(상태줄·훅)
  usage?: Usage // 상태줄일 때만
  sessionId?: string // 훅·상태줄 공통 session_id(/resume에 쓴다)
}

export interface LoadedButtons {
  buttons: Record<Role, Button[]>
  buttonsError: boolean // 사용자 buttons.json의 문법이 틀려 기본 버튼을 쓴다
}

export interface Api {
  platform: NodeJS.Platform
  init(): Promise<{ config: Config } & LoadedButtons>
  loadButtons(): Promise<LoadedButtons>
  pickFolder(): Promise<string | null>
  newSession(tab: string, cwd: string, cols: number, rows: number, resume?: string): Promise<{ ok: true } | { error: string }>
  write(tab: string, data: string): void
  resize(tab: string, cols: number, rows: number): void
  kill(tab: string): void
  confirm(message: string, detail: string, ok: string): Promise<boolean>
  alert(message: string): Promise<void>
  notify(title: string, body: string, tab: string): void
  setBusy(count: number): void
  setConfig(config: Config): void
  editButtons(): void
  setupStatus(): Promise<SetupItem[] | null>
  install(id: string): Promise<boolean>
  updateClaude(): Promise<{ ok: boolean; before: string; after: string; note?: string } | null>
  onUpdateLog(cb: (text: string) => void): void
  onUpdateProgress(cb: (text: string) => void): void
  readInstructions(cwd: string): Promise<Instructions | null>
  saveInstructions(cwd: string, text: string): Promise<boolean>
  instructionsTemplate(role: Role): Promise<string>
  listCommands(cwd: string): Promise<SlashCommand[]>
  onData(cb: (tab: string, data: string) => void): void
  onExit(cb: (tab: string) => void): void
  onHook(cb: (ev: HookEvent) => void): void
  onFocusTab(cb: (tab: string) => void): void
}
