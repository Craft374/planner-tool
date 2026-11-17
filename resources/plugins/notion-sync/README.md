# Notion Sync — Claude Code 플러그인

Notion 기획 문서의 **공유 링크만으로** 프로젝트 안에 Markdown 파일을 만들고 계속 최신으로 유지합니다(Notion → 로컬 단방향).
API 토큰도, integration 설정도 필요 없습니다.
Git과 비슷하게 변경을 추적합니다. 바뀐 문서만 다시 저장하고, 변경 이력·diff·복구용 스냅샷을 남기며, 로컬 수정은 덮어쓰지 않습니다.
Unity 프로젝트를 포함해 어떤 프로젝트에서도 쓸 수 있고, macOS와 Windows를 모두 지원합니다. 외부 패키지가 필요 없습니다(Python 3.11+ 표준 라이브러리만 사용).

## 준비

1. Python 3.11 이상을 설치합니다. 확인: `python3 --version` 또는 Windows에서 `py -3 --version`
2. 이 폴더를 Claude Code 플러그인으로 불러옵니다.
   - 테스트용: `claude --plugin-dir /path/to/notion-sync-plugin`
   - 상시 사용: 이 폴더를 마켓플레이스에 등록한 뒤 `/plugin install notion-sync@<marketplace>`를 실행합니다.
3. Notion에서 동기화할 최상위 페이지를 공개로 설정합니다. 오른쪽 위 **공유** → 일반 액세스를 **링크가 있는 모든 사용자**로 바꾸거나, **게시** 탭에서 웹에 게시하면 됩니다. 하위 페이지는 자동으로 따라옵니다.
4. **링크 복사**로 주소를 얻습니다. 예: `https://app.notion.com/p/40ba56ac...?source=copy_link`

## 사용법

```
/notion-sync:init https://app.notion.com/p/40ba56ac5c288060868ae2f174d25d73?source=copy_link
/notion-sync:sync
```

| 명령어 | 기능 | 네트워크 |
|---|---|---|
| `/notion-sync:init <링크...>` | 프로젝트 초기 설정(링크 여러 개 가능, `--docs-dir` 지정 가능) | 사용 |
| `/notion-sync:sync` | 바뀐 문서만 동기화 | 사용 |
| `/notion-sync:diff` | 파일 수정 없이 변경 미리보기 | 사용 |
| `/notion-sync:status` | 로컬 수정, 삭제 후보, 마지막 실행 | 사용 안 함 |
| `/notion-sync:history [run_id]` | 이전 동기화 내역과 diff | 사용 안 함 |
| `/notion-sync:impact [run_id]` | 기획 변경이 코드에 주는 영향 분석(읽기 전용) | 사용 안 함 |

모든 명령은 사용자가 직접 호출할 때만 실행됩니다(`disable-model-invocation`).

### CLI로 직접 실행 (Claude Code 없이)

```bash
# macOS / Linux / Git Bash
/path/to/notion-sync-plugin/bin/notion-sync init --page "<링크>" --sync
# Windows cmd / PowerShell
\path\to\notion-sync-plugin\bin\notion-sync.cmd sync
```

`--project <폴더>`를 하위 명령 앞에 붙이면 다른 폴더를 대상으로 실행합니다(기본: 현재 폴더). 종료 코드는 성공 시 0이고, 오류·충돌·불완전한 탐색이 있으면 1입니다.

## 생성되는 파일

```
<프로젝트>/
├── Docs/Notion/전투시스템__89b6debb.md   # 제목 + 페이지 ID 끝 8자
└── .notion-sync/
    ├── config.json      # 최상위 페이지 ID, 문서 폴더
    ├── manifest.json    # 페이지 ID ↔ 파일, 해시
    ├── CHANGELOG.md     # 사람이 읽는 요약(최신이 위, 변경이 있을 때만 기록)
    ├── history/         # <run_id>.json(실행 결과), <run_id>.diff(unified diff)
    ├── snapshots/       # 덮어쓰기 전 원본
    └── conflicts/       # 충돌 시 Notion 최신본
```

각 문서는 `# 제목`과 원본 링크로 시작합니다. 하위 페이지와 데이터베이스 행은 상대 링크로 연결됩니다.
지원하는 블록은 제목, 문단, 목록, 할 일, 토글, 인용, 콜아웃, 코드, 표, 구분선, 수식, 이미지/파일, 북마크, 컬럼, 데이터베이스(행과 속성)입니다.

이미지는 `Docs/Notion/assets/`에 내려받고, 문서에는 로컬 경로(`![](<assets/…png>)`)로 넣습니다. 이미 받은 이미지는 다시 받지 않습니다. 다운로드에 실패하면 경고만 남기고 다음 sync 때 다시 시도합니다. 파일·PDF·영상은 링크만 남깁니다.
지원하지 않는 블록은 `<!-- notion-sync: 지원하지 않는 블록 … -->` 주석으로 남기고 경고합니다.

`Docs/Notion/`과 `.notion-sync/`를 Git에 커밋할지는 팀에서 정합니다. 플러그인은 Git 커밋이나 push를 하지 않습니다.

## 동작 방식

- 매 실행마다 모든 페이지를 받아 Markdown으로 바꾼 뒤 SHA-256 해시를 비교하고, **실제로 바뀐 파일만** 씁니다. 줄바꿈(CRLF/LF), 줄 끝 공백, BOM, 한글 유니코드 정규화(NFC) 차이는 변경으로 보지 않습니다.
- 상태: `ADDED` `MODIFIED` `UNCHANGED` `RENAMED` `DELETED` `CONFLICT` `ERROR`
- **충돌**: 로컬 파일이 마지막 동기화 이후 수정되었으면 덮어쓰지 않습니다. Notion 최신본은 `.notion-sync/conflicts/<run_id>/`에 저장합니다.
  - Notion 내용을 쓰려면 로컬 파일을 삭제하거나 최신본으로 교체한 뒤 다시 sync합니다.
  - 로컬 수정 내용을 지키려면 그 내용을 Notion에 먼저 반영합니다.
- **삭제**: 탐색이 완전히 성공하고 페이지가 휴지통에 있거나 접근 불가(공개 해제)로 확인된 경우에만 삭제 후보로 표시합니다. 로컬 파일은 지우지 않습니다.
- **불완전한 응답**: 본문 블록을 하나라도 못 받으면 그 페이지의 기존 파일을 유지하고 ERROR로 기록합니다.
- **안전**: 임시 파일 → 검증 → 원자적 교체 순서로 씁니다. 잠금 파일로 동시 실행을 막습니다. 문서 폴더와 `.notion-sync/` 밖에는 쓰지 않으며, 심볼릭 링크 탈출과 `.cs`/`.meta`/`.unity`/`.prefab`/`.asset`/`CLAUDE.md` 쓰기를 차단합니다.
- **요청**: 순차 처리합니다(약 3 req/s). 429/529는 `Retry-After`를 따르고, 5xx와 네트워크 오류는 최대 4회 재시도합니다.

## 주의: 비공식 엔드포인트

토큰 없이 읽기 위해 Notion 웹 화면이 쓰는 내부 엔드포인트(`www.notion.so/api/v3`의 `loadPageChunk`, `syncRecordValues`, `queryCollection`)를 사용합니다.
Notion이 형식을 바꾸면 동작이 깨질 수 있습니다. 그 경우에도 기존 파일은 그대로 유지되며, 수정은 `notion_sync/client.py`에만 하면 됩니다.

## 테스트

```bash
python3 -m unittest discover -s tests -t .
```

네트워크 없이 가짜 Notion(`tests/fake.py`)으로 명세의 13개 시나리오, Markdown 변환, Windows 파일명 케이스를 검증합니다.

## 미구현 / 한계

- 비공개 페이지는 읽을 수 없습니다(공개 공유 필수).
- Phase 3(Git 연동 옵션, 첨부파일 다운로드, GUI, 여러 팀 관리 기능)은 구현하지 않았습니다. Notion에서 지운 이미지 파일도 로컬에서는 지우지 않습니다.
- 동기화 블록(synced block)의 참조본, 데이터베이스 뷰의 필터·정렬은 반영하지 않습니다.
- 자동 병합과 AI 의미 요약은 없습니다. `impact`가 필요할 때만 분석합니다.
