---
description: 현재 프로젝트에 Notion 동기화를 설정합니다. 공개 공유 링크만 있으면 되고 토큰은 필요 없습니다.
argument-hint: "<Notion 페이지 URL> [URL ...] [--docs-dir 경로]"
disable-model-invocation: true
---
`<실행기>`는 `notion-sync`입니다. 플러그인의 `bin/`이 PATH에 들어 있어 macOS, Windows(Git Bash, PowerShell) 모두 그대로 실행됩니다. 명령을 찾지 못하면 `"${CLAUDE_PLUGIN_ROOT}/bin/notion-sync"`를 사용합니다. Windows PowerShell이라면 `notion-sync.cmd`를 사용합니다. 명령은 현재 프로젝트 루트에서 실행합니다.

1. 인자: `$ARGUMENTS`. Notion 페이지 URL이 없으면 사용자에게 동기화할 최상위 페이지 URL을 물어봅니다(여러 개 가능).
2. 각 URL마다 `--page <URL>`을 붙여 실행합니다: `<실행기> init --page <URL1> --page <URL2> [--docs-dir 경로]`
3. 페이지를 읽을 수 없다는 오류가 나면 출력된 안내대로 Notion에서 '공유 → 링크가 있는 모든 사용자' 또는 '게시'를 켜라고 알려 주고 멈춥니다.
4. 성공하면 바로 초기 동기화를 할지 묻습니다. 사용자가 원하면 `<실행기> sync`를 실행합니다.
