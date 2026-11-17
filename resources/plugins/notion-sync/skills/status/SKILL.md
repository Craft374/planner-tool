---
description: 동기화 상태를 확인합니다(네트워크 사용 안 함). 로컬 수정, 삭제 후보, 마지막 실행을 보여 줍니다.
disable-model-invocation: true
---
`<실행기>`는 `notion-sync`입니다. 플러그인의 `bin/`이 PATH에 들어 있어 macOS, Windows(Git Bash, PowerShell) 모두 그대로 실행됩니다. 명령을 찾지 못하면 `"${CLAUDE_PLUGIN_ROOT}/bin/notion-sync"`를 사용합니다. Windows PowerShell이라면 `notion-sync.cmd`를 사용합니다. 명령은 현재 프로젝트 루트에서 실행합니다.

다음을 실행합니다: `<실행기> status`

결과를 짧게 요약합니다. 로컬에서 수정된 파일이 있으면 다음 sync 때 충돌로 처리되어 덮어쓰지 않는다는 점을 알려 줍니다.
