"""공개 링크의 최상위 페이지부터 하위 페이지·데이터베이스 행을 재귀 탐색하고 본문을 Markdown으로 만든다."""
from dataclasses import dataclass, field

from . import converter
from .client import NotionError, walk
from .config import norm_id

COLLECTION_TYPES = ("collection_view", "collection_view_page")


@dataclass
class PageInfo:
    id: str
    parent_id: str | None
    title: str
    last_edited: str
    archived: bool
    url: str
    markdown: str | None = None  # None 이면 error 참고
    error: str = ""
    warnings: list = field(default_factory=list)
    images: dict = field(default_factory=dict)  # assets/ 파일명 -> URL

    @classmethod
    def from_block(cls, b: dict) -> "PageInfo":
        return cls(
            id=norm_id(b["id"]),
            parent_id=b.get("parent_id") if b.get("parent_table") != "space" else None,
            title=converter.plain((b.get("properties") or {}).get("title")).strip() or "Untitled",
            last_edited=converter.iso(b.get("last_edited_time")),
            archived=not b.get("alive", True),
            url=converter.page_url(b["id"]),
        )


@dataclass
class ScanResult:
    pages: dict  # id -> PageInfo
    complete: bool  # False 이면 삭제 판정을 하지 않는다
    warnings: list


def scan(client, root_ids: list[str]) -> ScanResult:
    result = ScanResult({}, True, [])
    seen: set[str] = set()

    def fail(msg: str):
        result.complete = False
        result.warnings.append(msg)

    def visit(pid: str, schema: dict | None = None):
        if pid in seen:
            return
        seen.add(pid)
        try:
            rm = client.load_page(pid)
        except NotionError as e:
            fail(f"페이지 {pid} 를 불러오지 못했습니다(공개 공유 상태인지 확인하세요): {e}")
            return
        blocks = rm["block"]
        info = PageInfo.from_block(blocks[pid])
        result.pages[info.id] = info
        if info.archived:
            return
        child_pages, collections, rows = [], {}, []
        for b in walk(pid, blocks):
            if b["id"] != pid and b.get("type") == "page":
                child_pages.append(b["id"])
            elif b.get("type") in COLLECTION_TYPES and (b["id"] == pid or b.get("type") == "collection_view"):
                coll = load_collection(b, rm)
                if coll:
                    collections[b["id"]] = coll
                    rows += [(rid, coll["schema"]) for rid, _ in coll["rows"]]
            elif b["id"] != pid and b.get("type") == "collection_view_page":
                child_pages.append(b["id"])  # 전체 페이지 데이터베이스는 별도 문서
        try:
            info.markdown, info.warnings, info.images = converter.render(rm, pid, collections, schema)
        except converter.IncompleteError as e:
            info.error = str(e)
            result.complete = False
        for cid in child_pages:
            visit(cid)
        for rid, row_schema in rows:
            visit(rid, row_schema)

    def load_collection(b: dict, rm: dict) -> dict | None:
        fmt = b.get("format") or {}
        cid = (fmt.get("collection_pointer") or {}).get("id") or b.get("collection_id")
        view_ids = b.get("view_ids") or []
        if not cid or not view_ids:
            fail(f"데이터베이스 {b['id']} 정보를 읽지 못했습니다.")
            return None
        try:
            row_ids, complete, qrm = client.query_collection(cid, view_ids[0], b.get("space_id", ""))
            coll = rm.get("collection", {}).get(cid) or client.records("collection", [cid]).get(cid) or {}
        except NotionError as e:
            fail(f"데이터베이스 {b['id']} 조회 실패: {e}")
            return None
        if not complete:
            fail(f"데이터베이스 '{converter.plain(coll.get('name'))}' 결과가 잘렸습니다.")
        row_blocks = qrm.get("block", {})
        rows = [(rid, converter.plain((row_blocks.get(rid, {}).get("properties") or {}).get("title")).strip() or "Untitled")
                for rid in row_ids]
        return {"name": converter.plain(coll.get("name")), "rows": rows, "schema": coll.get("schema") or {}}

    for rid in root_ids:
        visit(norm_id(rid))
    return result

