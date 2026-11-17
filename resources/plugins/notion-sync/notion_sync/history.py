"""실행 ID, JSON 이력, unified diff, 스냅샷, CHANGELOG. 모두 결정적 알고리즘(difflib)으로 생성한다."""
import difflib
import re
import secrets
from datetime import datetime

from . import storage

CHANGELOG_HEADER = "# Notion Sync CHANGELOG\n\n최신 실행이 위에 옵니다. 상세 diff는 `history/<run_id>.diff` 를 보세요.\n\n"
MAX_CHANGELOG_DIFF_LINES = 40


def new_run_id() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(2)


def now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def unified(old: str, new: str, old_name: str, new_name: str) -> str:
    lines = difflib.unified_diff(
        old.splitlines(), new.splitlines(), f"a/{old_name}", f"b/{new_name}", lineterm=""
    )
    return "\n".join(lines)


def changed_lines(diff: str) -> list[str]:
    return [l for l in diff.splitlines() if l[:1] in "+-" and not l.startswith(("+++", "---"))]


def snapshot(ws, run_id: str, name: str, text: str) -> None:
    storage.write_text(ws, ws.st("snapshots", run_id, name), text)


def save_conflict(ws, run_id: str, name: str, text: str) -> str:
    path = ws.st("conflicts", run_id, name)
    storage.write_text(ws, path, text)
    return str(path.relative_to(ws.project))


def finalize(ws, record: dict) -> None:
    run_id = record["run_id"]
    diffs = "\n\n".join(i["diff"] for i in record["items"] if i.get("diff"))
    if diffs:
        storage.write_text(ws, ws.st("history", f"{run_id}.diff"), diffs + "\n")
    stored = {**record, "items": [{k: v for k, v in i.items() if k != "diff"} for i in record["items"]]}
    storage.save_json(ws, ws.st("history", f"{run_id}.json"), stored)
    if any(v for k, v in record["counts"].items() if k != "UNCHANGED") or record["warnings"]:
        _append_changelog(ws, record)  # 변경 없는 실행은 CHANGELOG 에 남기지 않음(history 에는 남음)


def _append_changelog(ws, record: dict) -> None:
    c = record["counts"]
    when = record["started"][:16].replace("T", " ")
    out = [
        f"## [{when}] {record['run_id']} — {'성공' if record['success'] else '일부 실패'}",
        "",
        f"처리 {record['processed']} · 실패 {record['failed']} · "
        + " · ".join(f"{k} {v}" for k, v in c.items() if v),
        "",
    ]
    for item in record["items"]:
        if item["status"] == "UNCHANGED" and not item.get("note"):
            continue
        out.append(f"{item['status']}: {item['file']}" + (f"  ({item['note']})" if item.get("note") else ""))
        lines = changed_lines(item.get("diff", "")) if item["status"] == "MODIFIED" else []
        if lines:
            shown = lines[:MAX_CHANGELOG_DIFF_LINES]
            if len(lines) > len(shown):
                shown.append(f"... 외 {len(lines) - len(shown)}줄")
            # 본문 속 ``` 코드 블록보다 긴 펜스를 써야 CHANGELOG 렌더링이 깨지지 않는다
            fence = "`" * max(3, 1 + max((len(r) for l in shown for r in re.findall(r"`+", l)), default=0))
            out += ["", f"{fence}diff", *shown, fence]
        out.append("")
    if c.get("UNCHANGED"):
        out += [f"UNCHANGED: {c['UNCHANGED']}개 파일", ""]
    path = ws.st("CHANGELOG.md")
    old = storage.read_text(path) or CHANGELOG_HEADER
    body = old[len(CHANGELOG_HEADER):] if old.startswith(CHANGELOG_HEADER) else old
    storage.write_text(ws, path, CHANGELOG_HEADER + "\n".join(out) + "\n" + body)


def list_runs(ws) -> list[dict]:
    hist = ws.state / "history"
    if not hist.is_dir():
        return []
    runs = [storage.load_json(p, {}) for p in sorted(hist.glob("*.json"), reverse=True)]
    return [r for r in runs if r]
