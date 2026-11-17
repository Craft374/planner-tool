"""프로젝트별 설정. 토큰이 필요 없다(공개 링크만 사용)."""
import re
from pathlib import Path

from . import storage

STATE_DIR = ".notion-sync"
DEFAULT_DOCS_DIR = "Docs/Notion"


class ConfigError(Exception):
    pass


def norm_id(value: str) -> str:
    """URL 또는 ID 문자열에서 Notion ID를 뽑아 대시 포함 소문자 UUID로 만든다."""
    path = value.split("?")[0].split("#")[0]
    found = re.findall(
        r"(?<![0-9a-fA-F])(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-fA-F]{32})(?![0-9a-fA-F])",
        path,
    )
    raw = found[-1].replace("-", "").lower() if found else ""
    if len(raw) != 32:
        raise ConfigError(f"Notion 페이지 ID를 찾을 수 없습니다: {value}")
    return f"{raw[:8]}-{raw[8:12]}-{raw[12:16]}-{raw[16:20]}-{raw[20:]}"


def load(project: Path) -> dict:
    cfg = storage.load_json(Path(project) / STATE_DIR / "config.json", None)
    if cfg is None:
        raise ConfigError("초기 설정이 없습니다. 먼저 /notion-sync:init 을 실행하세요.")
    cfg.setdefault("docs_dir", DEFAULT_DOCS_DIR)
    cfg.setdefault("root_pages", [])
    return cfg


def workspace(project: Path, cfg: dict) -> "storage.Workspace":
    return storage.Workspace(Path(project), cfg["docs_dir"], STATE_DIR)
