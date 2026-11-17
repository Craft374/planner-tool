# 기획 도우미 (가칭)

기획자가 CLI 없이 Claude Code를 쓰는 데스크톱 프로그램입니다.

## 실행

```sh
npm install
npm start          # 빌드 후 실행
npm run typecheck  # 타입 검사
npm run dist:mac   # .dmg 만들기 (release/)
npm run dist:win   # Windows x64 설치 파일 (Mac에서도 빌드됨, release/)
```

`claude`(Claude Code)가 설치되어 있고 로그인되어 있어야 합니다.

## 구조

| 파일 | 하는 일 |
|---|---|
| `src/main.ts` | 창, `claude` 실행(node-pty), 훅·상태줄을 받는 로컬 서버, 알림 |
| `src/preload.ts` | 화면에 열어 주는 API |
| `src/renderer/` | 화면(세션 목록, 터미널, 입력 상자, 오른쪽 정보) |
| `resources/buttons.json` | 기본 버튼. "편집"을 처음 누를 때 사용자 폴더로 복사되고, 고친 뒤 창으로 돌아오면 반영됩니다 |
| `resources/logo.svg` | 로고 원본. `build/icon.png`는 `rsvg-convert -w 1024 -h 1024 resources/logo.svg -o build/icon.png`로 만듭니다 |

## 동작 방식

- 세션마다 `claude --settings <탭 설정> --effort high`로 띄웁니다("깊게 생각하기"를 켜면 xhigh).
- 작업 지침은 각 폴더의 `CLAUDE.local.md`(개인 파일)에 둡니다. 오른쪽 "지침"에서 보고 고치며, 없으면 `resources/CLAUDE.local.template.md`로 기본 지침을 넣습니다. 저장할 때 `.git/info/exclude`에 넣어 git에 올라가지 않게 합니다.
- 탭 설정에는 `http` 훅(SessionStart, UserPromptSubmit, Notification, Stop, SubagentStart, SubagentStop)과 `curl` 상태줄이 들어 있고, 둘 다 `127.0.0.1`의 프로그램 서버로 보냅니다. URL에 탭 id가 들어 있어서 같은 폴더에 세션이 여러 개여도 구분됩니다.
- 사용자 설정(`~/.claude`)과 프로젝트 `CLAUDE.md`는 건드리지 않습니다.
- 버튼은 그 자체로 완결된 지시를 보냅니다(지침 파일이 없어도 동작). 지침에는 "작업 저장 요청 때만 커밋·푸시" 같은 늘 지킬 규칙만 둡니다.
- 앱에 넣은 노션 싱크를 고치면 `resources/plugins/notion-sync/.claude-plugin/plugin.json`의 `version`을 올립니다. 이미 설치한 PC의 플러그인 관리 창에 업데이트가 뜹니다.
- Windows PC에는 Git for Windows가 있어야 합니다(작업 커밋, 포니테일 설치). 서명하지 않은 설치 파일이라 처음 실행 때 "Windows의 PC 보호 → 추가 정보 → 실행"을 누릅니다.
