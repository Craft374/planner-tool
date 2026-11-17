---
description: 최근 Notion 기획 변경이 프로젝트 코드에 주는 영향을 분석합니다(읽기 전용, 코드 수정 없음).
argument-hint: "[run_id]"
disable-model-invocation: true
allowed-tools: Read, Grep, Glob
---
이 작업은 **읽기 전용**입니다. 어떤 파일도 만들거나 고치지 않고, Unity Editor나 Git도 조작하지 않습니다.

1. 분석할 변경을 고릅니다. `$ARGUMENTS`에 실행 ID가 있으면 `.notion-sync/history/<run_id>.json`과 `.diff`를 읽습니다. 없으면 `.notion-sync/history/`에서 가장 최근 `.json` 파일과 같은 이름의 `.diff`를 읽습니다. 이력이 없으면 `/notion-sync:sync`를 먼저 하라고 안내하고 멈춥니다.
2. ADDED, MODIFIED, RENAMED, DELETED 항목의 diff에서 바뀐 수치, 규칙, 용어, 기능 이름을 뽑습니다.
3. 프로젝트 코드(`Assets/**/*.cs` 등)에서 관련 클래스, 필드, 상수, ScriptableObject, 데이터 파일을 Grep과 Glob으로 찾습니다.
4. 다음 형식으로 보고합니다.
   - 변경 요약(문서별)
   - 영향 받는 코드: `파일:줄`, 이유, 확신도(높음/중간/낮음)
   - 기획과 코드가 어긋날 수 있는 지점, 확인할 질문
   - 권장 작업 목록(제안만 하고 실행하지 않음)
