"""독립 실행 CLI: python -m notion_sync <init|sync|diff|status|history>"""
import argparse
import sys
from pathlib import Path

from . import config, history, storage, sync_engine
from .client import NotionClient, NotionError
from .comparator import normalize, sha256
from .scanner import PageInfo

ICON = {"ADDED": "+", "MODIFIED": "~", "RENAMED": ">", "UNCHANGED": "=", "DELETED": "-", "CONFLICT": "!", "ERROR": "x"}


def _client() -> NotionClient:
    return NotionClient()


def cmd_init(args) -> int:
    project = Path(args.project)
    try:
        cfg = config.load(project)
    except config.ConfigError:
        cfg = {"docs_dir": args.docs_dir or config.DEFAULT_DOCS_DIR, "root_pages": []}
    if args.docs_dir:
        cfg["docs_dir"] = args.docs_dir
    ws = config.workspace(project, cfg)  # 경로 검증(실패 시 PathError)
    client = _client()
    for url in args.page:
        pid = config.norm_id(url)
        block = client.records("block", [pid]).get(pid)
        if block is None or not block.get("alive", True):
            raise config.ConfigError(
                f"페이지를 읽을 수 없습니다: {url}\n"
                "Notion 페이지 오른쪽 위 '공유' → 일반 액세스를 '링크가 있는 모든 사용자'로 바꾸거나 "
                "'게시' 탭에서 웹에 게시한 뒤 다시 시도하세요.")
        info = PageInfo.from_block(block)
        if pid not in cfg["root_pages"]:
            cfg["root_pages"].append(pid)
        print(f"확인됨: {info.title} ({pid})")
    if not cfg["root_pages"]:
        raise config.ConfigError("최상위 페이지를 하나 이상 지정하세요: --page <Notion 페이지 URL>")
    ws.docs.mkdir(parents=True, exist_ok=True)
    storage.save_json(ws, ws.st("config.json"), cfg)
    print(f"설정 저장: {ws.st('config.json')}\n문서 폴더: {ws.docs}")
    if args.sync:
        return cmd_sync(argparse.Namespace(project=args.project, dry_run=False))
    return 0


def _print_record(rec: dict, show_diff: bool) -> None:
    title = "동기화 미리보기(파일 변경 없음)" if rec["dry_run"] else f"동기화 {rec['run_id']}"
    print(title)
    for item in rec["items"]:
        if item["status"] == "UNCHANGED" and not item["note"]:
            continue
        print(f" {ICON[item['status']]} {item['status']:<9} {item['file']}" + (f"\n     {item['note']}" if item["note"] else ""))
        if show_diff and item["diff"]:
            print("\n".join("     " + l for l in item["diff"].splitlines()))
    for w in rec["warnings"]:
        print(f" [경고] {w}")
    c = rec["counts"]
    print("결과: " + ", ".join(f"{k} {v}" for k, v in c.items() if v) + (" (변경 없음)" if not any(v for k, v in c.items() if k != "UNCHANGED") else ""))
    if not rec["scan_complete"]:
        print("탐색이 일부 실패해 삭제 판정을 하지 않았습니다.")


def cmd_sync(args) -> int:
    rec = sync_engine.sync(Path(args.project), _client(), dry_run=args.dry_run)
    _print_record(rec, show_diff=args.dry_run)
    return 0 if rec["success"] and not rec["counts"]["CONFLICT"] else 1


def cmd_status(args) -> int:
    project = Path(args.project)
    cfg = config.load(project)
    ws = config.workspace(project, cfg)
    pages = storage.load_json(ws.st("manifest.json"), {"pages": {}})["pages"]
    print(f"문서 폴더: {ws.docs}\n최상위 페이지: {len(cfg['root_pages'])}개, 관리 문서: {len(pages)}개")
    modified, missing, deleted = [], [], []
    for entry in pages.values():
        if entry.get("deleted"):
            deleted.append(entry["file"])
            continue
        text = storage.read_text(ws.doc(entry["file"]))
        if text is None:
            missing.append(entry["file"])
        elif sha256(normalize(text)) != entry["hash"]:
            modified.append(entry["file"])
    for label, files in (("로컬 수정됨(다음 sync 시 충돌)", modified), ("로컬 파일 없음", missing),
                         ("삭제 후보", deleted)):
        if files:
            print(f"{label}: " + ", ".join(files))
    runs = history.list_runs(ws)
    if runs:
        r = runs[0]
        print(f"마지막 동기화: {r['started']} {'성공' if r['success'] else '일부 실패'} — "
              + ", ".join(f"{k} {v}" for k, v in r["counts"].items() if v))
    else:
        print("아직 동기화한 적이 없습니다.")
    state = storage.load_json(ws.st("run.json"), None)
    if state and state.get("status") in ("running", "failed"):
        print(f"[경고] 동기화 {state['run_id']} 가 완료되지 않았습니다({state['status']}). 다시 sync 하면 이어서 처리합니다.")
    return 0


def cmd_history(args) -> int:
    project = Path(args.project)
    ws = config.workspace(project, config.load(project))
    runs = history.list_runs(ws)
    if args.run_id:
        run = next((r for r in runs if r["run_id"] == args.run_id), None)
        if not run:
            print(f"실행 기록이 없습니다: {args.run_id}")
            return 1
        for item in run["items"]:
            print(f" {ICON[item['status']]} {item['status']:<9} {item['file']}  {item['note']}")
        diff = storage.read_text(ws.st("history", f"{args.run_id}.diff"))
        if diff:
            print(diff)
        return 0
    if not runs:
        print("동기화 기록이 없습니다.")
    for r in runs[: args.limit]:
        counts = ", ".join(f"{k} {v}" for k, v in r["counts"].items() if v and k != "UNCHANGED")
        print(f"{r['run_id']}  {'성공' if r['success'] else '실패'}  {counts or '변경 없음'}")
    return 0


def main(argv=None) -> int:
    for stream in (sys.stdout, sys.stderr):  # Windows 콘솔 한글 깨짐 방지
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass
    p = argparse.ArgumentParser(prog="notion-sync", description="Notion → 로컬 Markdown 단방향 동기화")
    p.add_argument("--project", default=".", help="동기화 대상 프로젝트 폴더(기본: 현재 폴더)")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("init", help="프로젝트 초기 설정")
    s.add_argument("--page", action="append", default=[], help="최상위 Notion 페이지 URL (여러 번 지정 가능)")
    s.add_argument("--docs-dir", help=f"문서 폴더(기본 {config.DEFAULT_DOCS_DIR})")
    s.add_argument("--sync", action="store_true", help="설정 후 바로 동기화")
    s.set_defaults(func=cmd_init)
    for name, dry in (("sync", False), ("diff", True)):
        s = sub.add_parser(name, help="변경 파일 동기화" if not dry else "변경 사항 미리보기(파일 수정 없음)")
        s.set_defaults(func=cmd_sync, dry_run=dry)
    s = sub.add_parser("status", help="현재 상태(네트워크 사용 안 함)")
    s.set_defaults(func=cmd_status)
    s = sub.add_parser("history", help="이전 동기화 내역(네트워크 사용 안 함)")
    s.add_argument("run_id", nargs="?")
    s.add_argument("-n", "--limit", type=int, default=20)
    s.set_defaults(func=cmd_history)
    args = p.parse_args(argv)
    try:
        return args.func(args)
    except (config.ConfigError, storage.PathError, storage.LockError, NotionError) as e:
        print(f"오류: {e}", file=sys.stderr)
        return 1
