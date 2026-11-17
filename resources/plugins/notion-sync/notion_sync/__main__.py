import sys
from pathlib import Path

if not __package__:  # bin/ 래퍼가 파일 경로로 직접 실행하는 경우(PYTHONPATH 설정 불필요)
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from notion_sync.cli import main

sys.exit(main())
