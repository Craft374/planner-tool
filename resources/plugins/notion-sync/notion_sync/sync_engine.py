"""동기화 엔진. 파일 갱신 순서: 응답 검증 → 충돌 검사 → 스냅샷 → 임시 파일 → 검증 → 원자적 교체 → manifest → 이력."""
import os
from pathlib import Path

from . import config, converter, history, scanner, storage
from .client import NotionError
from .comparator import ADDED, CONFLICT, DELETED, ERROR, MODIFIED, RENAMED, UNCHANGED, classify, normalize, sha256

CONFLICT_HELP = (
    "로컬 파일이 수정되어 덮어쓰지 않았습니다. Notion 최신본: {path} | "
    "해결: Notion 내용을 쓰려면 최신본으로 파일을 교체하거나 로컬 파일을 삭제한 뒤 다시 sync 하세요. "
    "로컬 수정 내용을 지키려면 그 내용을 Notion에 먼저 반영하세요."
)


def sync(project: Path, client, *, dry_run: bool = False) -> dict:
    cfg = config.load(project)
    ws = config.workspace(project, cfg)
    if dry_run:
        return _Run(ws, cfg, client, dry_run=True).execute()
    with storage.lock(ws):
        return _Run(ws, cfg, client, dry_run=False).execute()


class _Run:
    def __init__(self, ws, cfg, client, dry_run):
        self.ws, self.cfg, self.client, self.dry = ws, cfg, client, dry_run
        self.run_id = history.new_run_id()
        self.manifest_path = ws.st("manifest.json")
        self.state_path = ws.st("run.json")
        self.manifest = storage.load_json(self.manifest_path, {"version": 1, "pages": {}})
        self.pages = self.manifest["pages"]
        self.record = {
            "run_id": self.run_id, "dry_run": dry_run,
            "started": history.now(), "items": [], "warnings": [],
        }

    # --- 쓰기 헬퍼: dry-run 이면 아무것도 쓰지 않는다 ---
    def _save_manifest(self):
        if not self.dry:
            storage.save_json(self.ws, self.manifest_path, self.manifest)

    def _set_state(self, status: str, **extra):
        if not self.dry:
            storage.save_json(self.ws, self.state_path,
                              {"run_id": self.run_id, "status": status, "started": self.record["started"], **extra})

    def _item(self, status, page_id, title, file, note="", diff=""):
        self.record["items"].append(
            {"status": status, "page_id": page_id, "title": title, "file": file, "note": note, "diff": diff})

    def execute(self) -> dict:
        prev = storage.load_json(self.state_path, None)
        if prev and prev.get("status") in ("running", "failed"):
            self.record["warnings"].append(
                f"이전 동기화 {prev['run_id']} 가 완료되지 않았습니다. 파일과 manifest는 파일 단위로 원자적으로 "
                f"기록되므로 이어서 동기화합니다. 변경 전 원본: .notion-sync/snapshots/{prev['run_id']}/")
        self._set_state("running")
        try:
            scan = scanner.scan(self.client, self.cfg["root_pages"])
            self.record["warnings"] += scan.warnings
            for page in scan.pages.values():
                if page.archived:
                    continue
                try:
                    self._sync_page(page)
                except storage.PathError:
                    raise  # 잘못된 경로는 즉시 중단
                except OSError as e:
                    entry = self.pages.get(page.id) or {}
                    self._item(ERROR, page.id, page.title,
                               entry.get("file") or storage.safe_filename(page.title, page.id),
                               f"{e} (기존 파일 유지)")
            self._detect_deleted(scan)
        except BaseException as e:
            self._set_state("failed", error=str(e))
            raise
        rec = self.record
        counts = {s: 0 for s in (ADDED, MODIFIED, RENAMED, UNCHANGED, DELETED, CONFLICT, ERROR)}
        for i in rec["items"]:
            counts[i["status"]] += 1
        rec.update(finished=history.now(), counts=counts, processed=len(rec["items"]),
                   failed=counts[ERROR], scan_complete=scan.complete,
                   success=counts[ERROR] == 0 and scan.complete)
        if not self.dry:
            history.finalize(self.ws, rec)
            self._set_state("done", finished=rec["finished"])
        return rec

    def _sync_page(self, page):
        ws, entry = self.ws, self.pages.get(page.id)
        target = storage.safe_filename(page.title, page.id)
        cur = entry["file"] if entry else target
        cur_path, target_path = ws.doc(cur), ws.doc(target)
        local_raw = storage.read_text(cur_path)
        local = normalize(local_raw) if local_raw is not None else None
        local_hash = sha256(local) if local is not None else None
        base = entry.get("hash") if entry else None

        if page.markdown is None:  # 본문 일부를 못 불러옴 → 기존 파일 유지
            self._item(ERROR, page.id, page.title, cur, f"{page.error} (기존 파일 유지)")
            return
        remote = page.markdown
        remote_hash = sha256(remote)
        self.record["warnings"] += [f"{page.title}: {w}" for w in page.warnings]

        title_changed = cur != target
        status = classify(base, local_hash, remote_hash, title_changed)
        notes = []
        if entry and entry.get("parent_id") != page.parent_id:
            notes.append("상위 페이지 변경(이동)")
        if entry and entry.get("deleted"):
            notes.append("다시 나타난 페이지")
        if title_changed and status in (RENAMED, MODIFIED) and target_path.exists() and not (
                cur_path.exists() and os.path.samefile(cur_path, target_path)):
            status = CONFLICT
            notes.append(f"새 파일명 {target} 이 이미 존재합니다")
        diff = ""

        if status == CONFLICT:
            diff = history.unified(local or "", remote, cur, f"notion/{target}")
            path = history.save_conflict(ws, self.run_id, target, remote) if not self.dry else "(diff 모드)"
            self._item(CONFLICT, page.id, page.title, cur, "; ".join(notes + [CONFLICT_HELP.format(path=path)]), diff)
            return  # manifest 의 base 해시를 유지해야 다음 실행에서도 충돌로 남는다

        if status == ADDED:
            if entry:
                notes.append("로컬 파일이 없어 다시 생성")
            diff = history.unified("", remote, "/dev/null", target)
            if not self.dry:
                storage.write_text(ws, target_path, remote)
        elif status == RENAMED:
            notes.append(f"{cur} → {target}")
            if not self.dry:
                storage.move(ws, cur_path, target_path)
        elif status == MODIFIED:
            if title_changed:
                notes.append(f"{cur} → {target}")
            diff = history.unified(local, remote, cur, target)
            if not self.dry:
                history.snapshot(ws, self.run_id, cur, local_raw)
                if title_changed:
                    storage.move(ws, cur_path, target_path)
                storage.write_text(ws, target_path, remote)

        self._download_images(page)
        new_entry = {
            "title": page.title, "file": target, "hash": remote_hash or base,
            "last_edited": page.last_edited, "parent_id": page.parent_id, "url": page.url,
        }
        if new_entry != entry:
            self.pages[page.id] = new_entry
            self._save_manifest()
        self._item(status, page.id, page.title, target, "; ".join(notes), diff)

    def _download_images(self, page):
        """로컬에 없는 이미지만 받는다. 실패는 경고로 남기고 다음 sync 때 다시 시도한다."""
        for name, url in page.images.items():
            path = self.ws.doc(f"{converter.IMAGE_DIR}/{name}")
            if self.dry or path.exists():
                continue
            try:
                storage.write_bytes(self.ws, path, self.client.download(url))
            except (NotionError, OSError) as e:  # 문서는 이미 썼으므로 페이지를 ERROR 로 만들지 않는다
                self.record["warnings"].append(f"{page.title}: {e} (다음 sync 때 다시 시도)")

    def _detect_deleted(self, scan):
        """탐색이 완전하고 페이지 상태까지 확인된 경우에만 삭제 후보로 표시. 로컬 파일은 지우지 않는다."""
        for pid, entry in list(self.pages.items()):
            page = scan.pages.get(pid)
            if entry.get("deleted") or (page and not page.archived):
                continue
            if page:
                reason = "Notion 휴지통으로 이동됨"
            elif not scan.complete:
                self.record["warnings"].append(f"탐색이 불완전해 삭제 판정을 보류합니다: {entry['file']}")
                continue
            else:
                try:
                    block = self.client.records("block", [pid]).get(pid)
                except NotionError as e:
                    self._item(ERROR, pid, entry["title"], entry["file"], f"삭제 확인 실패: {e}")
                    continue
                if block is None:
                    reason = "페이지 접근 불가(삭제 또는 공개 공유 해제)"
                elif not block.get("alive", True):
                    reason = "Notion 휴지통으로 이동됨"
                else:
                    reason = "동기화 범위 밖으로 이동됨"
            entry["deleted"] = history.now()
            self._save_manifest()
            self._item(DELETED, pid, entry["title"], entry["file"], f"{reason}. 로컬 파일은 삭제하지 않았습니다.")
