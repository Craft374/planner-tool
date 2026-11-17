---
description: 파일을 수정하지 않고 Notion 원격 변경 사항을 미리 봅니다.
disable-model-invocation: true
---
`<실행기>`는 `notion-sync`입니다. 플러그인의 `bin/`이 PATH에 들어 있어 macOS, Windows(Git Bash, PowerShell) 모두 그대로 실행됩니다. 명령을 찾지 못하면 `"${CLAUDE_PLUGIN_ROOT}/bin/notion-sync"`를 사용합니다. Windows PowerShell이라면 `notion-sync.cmd`를 사용합니다. 명령은 현재 프로젝트 루트에서 실행합니다.

다음을 실행합니다: `<실행기> diff`

파일은 수정되지 않습니다. 변경 예정인 파일과 줄 단위 diff를 요약해 보고하고, 반영하려면 `/notion-sync:sync`를 실행하라고 안내합니다.
