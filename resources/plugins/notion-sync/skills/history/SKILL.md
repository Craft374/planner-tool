---
description: 이전 동기화 내역을 봅니다(네트워크 사용 안 함). 실행 ID를 주면 상세 diff를 보여 줍니다.
argument-hint: "[run_id] [-n 개수]"
disable-model-invocation: true
---
`<실행기>`는 `notion-sync`입니다. 플러그인의 `bin/`이 PATH에 들어 있어 macOS, Windows(Git Bash, PowerShell) 모두 그대로 실행됩니다. 명령을 찾지 못하면 `"${CLAUDE_PLUGIN_ROOT}/bin/notion-sync"`를 사용합니다. Windows PowerShell이라면 `notion-sync.cmd`를 사용합니다. 명령은 현재 프로젝트 루트에서 실행합니다.

다음을 실행합니다: `<실행기> history $ARGUMENTS`

결과를 표로 정리해 보여 줍니다. 사람이 읽는 요약은 `.notion-sync/CHANGELOG.md`에도 있습니다.
