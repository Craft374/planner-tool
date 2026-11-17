---
description: 공개 공유된 Notion 기획 문서를 로컬 Docs/Notion 으로 동기화합니다. 바뀐 문서만 다시 저장합니다.
disable-model-invocation: true
---
`<실행기>`는 `notion-sync`입니다. 플러그인의 `bin/`이 PATH에 들어 있어 macOS, Windows(Git Bash, PowerShell) 모두 그대로 실행됩니다. 명령을 찾지 못하면 `"${CLAUDE_PLUGIN_ROOT}/bin/notion-sync"`를 사용합니다. Windows PowerShell이라면 `notion-sync.cmd`를 사용합니다. 명령은 현재 프로젝트 루트에서 실행합니다.

다음을 실행합니다: `<실행기> sync`

- 출력을 그대로 요약해 보고합니다: 추가/수정/이름 변경/삭제 후보/충돌/오류 수와 파일명을 알려 줍니다.
- CONFLICT가 있으면 출력에 나온 해결 방법을 안내합니다. 로컬 파일을 대신 고치거나 덮어쓰지 않습니다.
- 페이지를 불러오지 못했다는 경고가 나오면 해당 Notion 페이지가 '링크가 있는 모든 사용자' 공유 또는 웹 게시 상태인지 확인하라고 안내합니다.
- Unity 코드나 다른 파일은 수정하지 않습니다. 변경의 영향이 궁금하면 `/notion-sync:impact`를 안내합니다.
