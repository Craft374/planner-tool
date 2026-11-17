"""안전한 파일 입출력: 허용 경로 검사, 원자적 쓰기, 파일명 정리, 잠금. Windows/macOS 공용."""
import json
import os
import re
import time
import unicodedata
from contextlib import contextmanager
from pathlib import Path

PROTECTED_DIRS = {"assets", "packages", "projectsettings", "library", "usersettings", ".git"}
PROTECTED_EXTS = {".meta", ".unity", ".prefab", ".asset", ".cs"}
PROTECTED_NAMES = {"claude.md"}
WIN_RESERVED = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}
LOCK_STALE_SECONDS = 30 * 60


class PathError(Exception):
    """허용되지 않은 경로. 동기화를 즉시 중단해야 한다."""


class LockError(Exception):
    pass


def _inside(child: Path, parent: Path) -> bool:
    # 두 OS 모두 기본 파일시스템이 대소문자를 무시하므로 casefold 비교
    c, p = str(child).casefold(), str(parent).casefold().rstrip("\\/")
    return c == p or c.startswith(p + os.sep)


class Workspace:
    """동기화 엔진이 쓸 수 있는 경로는 docs_dir 와 state_dir 아래뿐이다."""

    def __init__(self, project: Path, docs_dir: str, state_dir: str):
        self.project = Path(project).resolve()
        if not self.project.is_dir():
            raise PathError(f"프로젝트 폴더가 없습니다: {project}")
        self.docs = self._root(docs_dir)
        self.state = self._root(state_dir)

    def _root(self, rel: str) -> Path:
        rel_path = Path(rel)
        if rel_path.is_absolute() or rel_path.drive or ".." in rel_path.parts or not rel_path.parts:
            raise PathError(f"프로젝트 내부 상대 경로만 허용됩니다: {rel}")
        if rel_path.parts[0].casefold() in PROTECTED_DIRS:
            raise PathError(f"보호된 폴더에는 쓸 수 없습니다: {rel}")
        root = (self.project / rel_path).resolve()  # 심볼릭 링크/정션을 따라가 실제 위치 확인
        if not _inside(root, self.project) or root == self.project:
            raise PathError(f"프로젝트 밖으로 나가는 경로입니다: {rel} -> {root}")
        return root

    def check(self, path: Path) -> Path:
        """쓰기 직전 경로 검사. 허용 루트 밖, 링크 탈출, Unity 보호 파일이면 PathError."""
        real = Path(path).resolve()
        if not (_inside(real, self.docs) or _inside(real, self.state)):
            raise PathError(f"허용되지 않은 경로입니다: {path}")
        if real.suffix.casefold() in PROTECTED_EXTS or real.name.casefold() in PROTECTED_NAMES:
            raise PathError(f"보호된 파일 형식입니다: {path}")
        return real

    def doc(self, name: str) -> Path:
        return self.check(self.docs / name)

    def st(self, *parts: str) -> Path:
        return self.check(self.state.joinpath(*parts))


def safe_filename(title: str, page_id: str, max_len: int = 80) -> str:
    """`{제목}__{id끝8자}.md`. 같은 워크스페이스는 ID 앞부분이 같으므로 무작위인 끝부분을 쓴다.
    Windows 금지 문자/예약어, macOS NFD 한글 모두 처리."""
    name = unicodedata.normalize("NFC", title)
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name)
    name = re.sub(r"\s+", " ", name).strip().rstrip(". ")[:max_len].rstrip(". ")
    if not name or name.split(".")[0].casefold() in WIN_RESERVED:
        name = f"_{name}" if name else "Untitled"
    return f"{name}__{page_id.replace('-', '')[-8:]}.md"


def read_text(path: Path) -> str | None:
    try:
        return Path(path).read_text(encoding="utf-8")
    except FileNotFoundError:
        return None


def _replace(src: Path, dst: Path) -> None:
    # Windows는 다른 프로세스(에디터, 백신)가 파일을 열고 있으면 PermissionError가 난다
    for attempt in range(5):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if attempt == 4:
                raise
            time.sleep(0.2 * (attempt + 1))


def write_bytes(ws: Workspace, path: Path, data: bytes) -> None:
    """임시 파일 → fsync → 원자적 교체. 실패해도 기존 파일은 그대로 남는다."""
    path = ws.check(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        with open(tmp, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        if tmp.read_bytes() != data:  # 콘텐츠 검증
            raise OSError(f"임시 파일 검증 실패: {tmp}")
        _replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)
    if os.name == "posix":
        fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def write_text(ws: Workspace, path: Path, text: str) -> None:
    write_bytes(ws, path, text.encode("utf-8"))  # 줄바꿈은 normalize 된 LF 그대로


def move(ws: Workspace, src: Path, dst: Path) -> None:
    src, dst = ws.check(src), ws.check(dst)
    if str(src).casefold() == str(dst).casefold() and src != dst:
        # 대소문자만 바뀐 이름: 대소문자 무시 파일시스템에서 2단계로 이동
        mid = src.with_name(f".{src.name}.{os.getpid()}.mv")
        _replace(src, mid)
        _replace(mid, dst)
    else:
        _replace(src, dst)


def load_json(path: Path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def save_json(ws: Workspace, path: Path, data) -> None:
    write_text(ws, path, json.dumps(data, ensure_ascii=False, indent=2) + "\n")


@contextmanager
def lock(ws: Workspace):
    """동시 실행 방지. PID 확인은 OS마다 달라 시간 기준으로 오래된 잠금을 회수한다."""
    path = ws.st("sync.lock")
    path.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(2):
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            break
        except FileExistsError:
            try:
                age = time.time() - path.stat().st_mtime
            except FileNotFoundError:
                continue
            if attempt == 0 and age > LOCK_STALE_SECONDS:
                path.unlink(missing_ok=True)
                continue
            raise LockError(
                f"다른 동기화가 실행 중입니다({int(age)}초 전 시작). "
                f"확실히 멈춘 상태라면 {path} 를 삭제하세요."
            )
    else:
        raise LockError(f"잠금을 얻지 못했습니다: {path}")
    try:
        os.write(fd, f"{os.getpid()} {time.time()}".encode())
        os.close(fd)
        yield
    finally:
        path.unlink(missing_ok=True)
