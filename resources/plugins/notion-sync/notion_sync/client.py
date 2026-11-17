"""공개 공유된 Notion 페이지를 토큰 없이 읽는 클라이언트(표준 라이브러리만 사용).

Notion 웹 화면이 쓰는 비공식 엔드포인트(/api/v3)를 사용한다. Notion이 형식을 바꾸면 이 파일만 고치면 된다.
요청은 순차 처리하고 속도를 제한한다.
"""
import json
import time
import urllib.error
import urllib.request

API_BASE = "https://www.notion.so/api/v3"
USER_AGENT = "notion-sync-plugin/1.0"
MAX_CHUNKS = 50  # 페이지 하나당 최대 50 x 100 블록
MAX_DOWNLOAD = 50 << 20  # 이미지 하나당 최대 50MB
FILL_ROUNDS = 10  # 청크에 빠진 하위 블록을 추가로 가져오는 최대 횟수


class NotionError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(f"[{status}] {message}" if status else message)
        self.status = status


class NotFoundError(NotionError):
    """존재하지 않거나 공개 공유되지 않은 페이지."""


def _retry_after(headers) -> float:
    try:
        return min(max(float(headers.get("Retry-After", "1")), 0.5), 60.0)
    except (TypeError, ValueError):
        return 1.0


def unwrap(record: dict) -> dict:
    """recordMap 의 {"value": {"value": {...}}} / {"value": {...}} 두 형식을 모두 푼다."""
    v = record.get("value") or {}
    return v.get("value", v) if isinstance(v.get("value"), dict) else v


def merge(rm: dict, new: dict) -> None:
    for table, records in new.items():
        if table != "__version__":
            for rid, rec in records.items():
                value = unwrap(rec)
                if value:
                    rm.setdefault(table, {})[rid] = value


class NotionClient:
    def __init__(self, *, opener=urllib.request.urlopen, sleep=time.sleep,
                 max_retries: int = 4, min_interval: float = 0.34):
        self._open = opener
        self._sleep = sleep
        self.max_retries = max_retries
        self.min_interval = min_interval  # 초당 약 3회
        self._last = 0.0

    def _throttle(self):
        wait = self._last + self.min_interval - time.monotonic()
        if wait > 0:
            self._sleep(wait)
        self._last = time.monotonic()

    def post(self, endpoint: str, body: dict) -> dict:
        data = json.dumps(body).encode("utf-8")
        headers = {"Content-Type": "application/json", "User-Agent": USER_AGENT}
        for attempt in range(self.max_retries + 1):
            self._throttle()
            req = urllib.request.Request(f"{API_BASE}/{endpoint}", data=data, method="POST", headers=headers)
            try:
                with self._open(req, timeout=30) as resp:
                    return json.loads(resp.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                status = e.code
                try:
                    payload = json.loads(e.read().decode("utf-8"))
                    message = payload.get("debugMessage") or payload.get("message") or e.reason
                except Exception:
                    message = str(e.reason)
                finally:
                    e.close()
                retryable = status in (429, 529) or status >= 500
                if retryable and attempt < self.max_retries:
                    self._sleep(_retry_after(e.headers) if status in (429, 529) else 2 ** attempt)
                    continue
                if retryable:
                    raise NotionError(status, f"재시도 {self.max_retries}회 실패: {message}")
                raise (NotFoundError if status in (400, 401, 403, 404) else NotionError)(status, message)
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                if attempt < self.max_retries:
                    self._sleep(2 ** attempt)
                    continue
                raise NotionError(0, f"네트워크 오류: {getattr(e, 'reason', e)}")

    def download(self, url: str) -> bytes:
        """이미지 파일 내려받기. 실패하면 NotionError."""
        self._throttle()
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with self._open(req, timeout=60) as resp:
                data = resp.read(MAX_DOWNLOAD + 1)
        except urllib.error.HTTPError as e:
            e.close()
            raise NotionError(e.code, f"이미지 다운로드 실패: {url}")
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            raise NotionError(0, f"이미지 다운로드 실패: {getattr(e, 'reason', e)}")
        if len(data) > MAX_DOWNLOAD:
            raise NotionError(0, f"이미지가 {MAX_DOWNLOAD >> 20}MB 를 넘습니다: {url}")
        return data

    # --- 엔진이 쓰는 API (tests/fake.py 의 FakeNotion 과 같은 인터페이스) ---
    def records(self, table: str, ids: list[str]) -> dict:
        """id -> 레코드. 접근할 수 없는 레코드는 결과에 없다."""
        out = {}
        for i in range(0, len(ids), 100):
            reqs = [{"pointer": {"table": table, "id": rid}, "version": -1} for rid in ids[i:i + 100]]
            rm = {}
            merge(rm, self.post("syncRecordValues", {"requests": reqs}).get("recordMap", {}))
            out.update(rm.get(table, {}))
        return out

    def load_page(self, page_id: str) -> dict:
        """페이지 하나의 recordMap({table: {id: value}}). 하위 페이지 본문은 포함하지 않는다."""
        rm, cursor = {}, {"stack": []}
        for chunk in range(MAX_CHUNKS):
            resp = self.post("loadPageChunk", {"pageId": page_id, "limit": 100, "cursor": cursor,
                                               "chunkNumber": chunk, "verticalColumns": False})
            merge(rm, resp.get("recordMap", {}))
            cursor = resp.get("cursor") or {"stack": []}
            if not cursor.get("stack"):
                break
        blocks = rm.setdefault("block", {})
        if page_id not in blocks:
            raise NotFoundError(404, "페이지에 접근할 수 없습니다")
        denied = set()
        for _ in range(FILL_ROUNDS):  # 청크에 빠진 하위 블록 보충
            missing = [c for b in walk(page_id, blocks) if b["id"] == page_id or b.get("type") not in PAGE_TYPES
                       for c in b.get("content", []) if c not in blocks and c not in denied]
            if not missing:
                break
            found = self.records("block", missing)
            blocks.update(found)
            denied |= set(missing) - set(found)  # 요청은 성공했지만 안 온 블록 = 접근 불가(비공개 하위 페이지 등)
        rm["denied"] = sorted(denied)
        return rm

    def query_collection(self, collection_id: str, view_id: str, space_id: str) -> tuple[list, bool, dict]:
        """(행 페이지 ID 목록, 전부 가져왔는지, recordMap)"""
        resp = self.post("queryCollection", {
            "source": {"type": "collection", "id": collection_id, "spaceId": space_id},
            "collectionView": {"id": view_id, "spaceId": space_id},
            "loader": {"type": "reducer", "searchQuery": "", "userTimeZone": "UTC",
                       "reducers": {"collection_group_results": {"type": "results", "limit": 1000}}},
        })
        res = (resp.get("result") or {}).get("reducerResults", {}).get("collection_group_results", {})
        rm = {}
        merge(rm, resp.get("recordMap", {}))
        return res.get("blockIds", []), not res.get("hasMore"), rm


PAGE_TYPES = ("page", "collection_view_page")


def walk(page_id: str, blocks: dict):
    """페이지 본문의 살아 있는 블록을 순서대로 순회. 하위 페이지 블록은 내놓지만 그 안으로는 들어가지 않는다."""
    stack = [page_id]
    while stack:
        b = blocks.get(stack.pop())
        if not b or not b.get("alive", True):
            continue
        yield b
        if b["id"] == page_id or b.get("type") not in PAGE_TYPES:
            stack.extend(reversed(b.get("content", [])))
