"""Notion recordMap(블록 트리) → Markdown. 지원하지 않는 블록은 조용히 빼지 않고 주석과 경고로 남긴다."""
import hashlib
import re
import urllib.parse
from datetime import datetime, timezone

from .comparator import normalize
from .storage import safe_filename

HEADINGS = {"header": "##", "sub_header": "###", "sub_sub_header": "####", "header_4": "#####"}  # 페이지 제목이 #
MEDIA = {"image", "video", "audio", "file", "pdf"}
LINKS = {"bookmark", "embed", "figma", "gist", "maps", "codepen", "tweet", "drive", "typeform"}
IMAGE_DIR = "assets"  # docs_dir 기준
SILENT = {"table_of_contents", "breadcrumb", "column_list", "column", "transclusion_container"}


class IncompleteError(Exception):
    """본문 일부를 불러오지 못함 → 기존 파일을 덮어쓰지 않는다."""


def page_url(block_id: str) -> str:
    return f"https://www.notion.so/{block_id.replace('-', '')}"


def plain(rt) -> str:
    return "".join(seg[0] for seg in rt or [] if seg and isinstance(seg[0], str))


def rich(rt) -> str:
    """Notion rich text [[텍스트, [[서식, 값], ...]], ...] → Markdown 인라인."""
    out = []
    for seg in rt or []:
        text, anns = seg[0], (seg[1] if len(seg) > 1 else [])
        link = None
        for ann in anns:
            kind = ann[0]
            if kind == "p":  # 페이지 멘션
                text, link = text if text != "‣" else "페이지", page_url(ann[1])
            elif kind == "u":
                text = "@사용자"
            elif kind == "d":
                d = ann[1] if len(ann) > 1 else {}
                text = "~".join(filter(None, [d.get("start_date"), d.get("end_date")])) or text
            elif kind == "e":
                text = f"${ann[1]}$"
        if not text.strip():
            out.append(text)
            continue
        kinds = {a[0] for a in anns}
        if "c" in kinds:
            text = f"`{text}`"
        if "b" in kinds:
            text = f"**{text}**"
        if "i" in kinds:
            text = f"*{text}*"
        if "s" in kinds:
            text = f"~~{text}~~"
        link = next((a[1] for a in anns if a[0] == "a"), link)
        out.append(f"[{text}]({link})" if link else text)
    return "".join(out)


def _fence(text: str) -> str:
    return "`" * max(3, 1 + max((len(r) for r in re.findall(r"`+", text)), default=0))


def _media_url(b: dict) -> str:
    src = plain((b.get("properties") or {}).get("source")) or (b.get("format") or {}).get("display_source", "")
    if src.startswith("attachment:") or "amazonaws.com" in src:
        # 업로드된 파일은 공개 페이지용 프록시 URL로 연결(만료되는 S3 서명 URL 대신)
        return f"https://www.notion.so/image/{urllib.parse.quote(src, safe='')}?table=block&id={b['id']}"
    return src


def _image_name(url: str) -> str:
    """같은 이미지는 항상 같은 파일명(URL 해시). 이미지를 바꾸면 URL이 바뀌어 문서 변경으로 잡힌다."""
    m = re.search(r"\.(png|jpe?g|gif|webp|svg|bmp|avif)(?=$|[?#&])", urllib.parse.unquote(url), re.I)
    return f"{hashlib.sha256(url.encode()).hexdigest()[:16]}.{m.group(1).lower() if m else 'png'}"


def iso(ms) -> str:
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat(timespec="seconds") if ms else ""


class _Renderer:
    def __init__(self, rm, page_id, collections, schema):
        self.blocks = rm.get("block", {})
        self.denied = set(rm.get("denied", []))
        self.page_id = page_id
        self.collections = collections  # block_id -> {"name", "rows": [(id, title)], "complete"}
        self.schema = schema
        self.warnings = []
        self.images = {}  # assets/ 아래 파일명 -> 다운로드 URL

    def child_link(self, bid: str, title: str) -> str:
        return f"[{title}](<{safe_filename(title, bid)}>)"

    def children(self, b: dict, indent: str) -> list[str]:
        lines = []
        prev = None
        for cid in b.get("content", []):
            c = self.blocks.get(cid)
            if c is None and cid in self.denied:
                self.warnings.append(f"접근할 수 없는 블록(비공개 하위 페이지 등)을 주석으로 남겼습니다: {cid}")
                c = {"id": cid, "type": "denied"}
            elif c is None:
                raise IncompleteError(f"블록 {cid} 를 불러오지 못했습니다.")
            if not c.get("alive", True):
                continue
            ctype = c.get("type")
            out = self.block(c, indent)
            if not out:  # 빈 문단
                continue
            # 같은 종류 목록(하위 페이지 링크 포함)은 붙여 쓰고, 나머지 블록 사이에는 빈 줄
            if lines and not (ctype == prev and ctype in ("bulleted_list", "numbered_list", "to_do", "page")):
                lines.append("")
            lines += out
            prev = ctype
        return lines

    def block(self, b: dict, indent: str) -> list[str]:
        t = b.get("type")
        props, fmt = b.get("properties") or {}, b.get("format") or {}
        title = rich(props.get("title"))
        sub = indent + "  "
        if t == "text":
            return ([indent + title] if title else []) + self.children(b, sub)
        if t in HEADINGS:
            return [f"{indent}{HEADINGS[t]} {title}"] + self.children(b, indent)
        if t in ("bulleted_list", "numbered_list", "toggle", "to_do"):
            mark = {"bulleted_list": "-", "numbered_list": "1.", "toggle": "- ▶"}.get(t)
            if t == "to_do":
                mark = "- [x]" if plain(props.get("checked")) == "Yes" else "- [ ]"
            return [f"{indent}{mark} {title}"] + self.children(b, sub)
        if t in ("quote", "callout"):
            icon = fmt.get("page_icon", "") if t == "callout" else ""
            head = f"{icon} {title}".strip()
            inner = ([head] if head else []) + self.children(b, "")
            return [indent + ("> " + l if l else ">") for l in inner]
        if t == "code":
            code = plain(props.get("title"))
            lang = plain(props.get("language")).lower().replace(" ", "")
            fence = _fence(code)
            return [f"{indent}{fence}{'' if lang == 'plaintext' else lang}", *[indent + l for l in code.split("\n")],
                    indent + fence]
        if t == "divider":
            return [indent + "---"]
        if t == "equation":
            return [indent + "$$", indent + plain(props.get("title")), indent + "$$"]
        if t == "table":
            return self.table(b, indent)
        if t in ("page", "collection_view_page") and b["id"] != self.page_id:
            return [f"{indent}- 📄 {self.child_link(b['id'], plain(props.get('title')).strip() or 'Untitled')}"]
        if t in ("collection_view", "collection_view_page"):
            return self.collection(b, indent)
        if t == "alias":
            target = (fmt.get("alias_pointer") or {}).get("id", "")
            return [f"{indent}- 🔗 [링크된 페이지]({page_url(target)})"]
        if t in MEDIA:
            caption = rich(props.get("caption")) or plain(props.get("title")) or t
            url = _media_url(b)
            if url.startswith("/"):
                url = "https://www.notion.so" + url
            if t == "image" and url.startswith(("http://", "https://")):
                name = _image_name(url)
                self.images[name] = url
                url = f"<{IMAGE_DIR}/{name}>"
            return [f"{indent}![{caption}]({url})" if t == "image" else f"{indent}[📎 {caption}]({url})"]
        if t in LINKS:
            url = plain(props.get("link")) or plain(props.get("source"))
            return [f"{indent}[🔗 {plain(props.get('title')) or url}]({url})"]
        if t == "denied":
            return [f"{indent}<!-- notion-sync: 접근할 수 없는 블록 {b['id']} -->"]
        if t in SILENT:
            return self.children(b, indent)
        self.warnings.append(f"지원하지 않는 블록 '{t}' 을 주석으로 남겼습니다 ({b.get('id')}).")
        return [f"{indent}<!-- notion-sync: 지원하지 않는 블록 {t} -->"] + self.children(b, indent)

    def table(self, b, indent):
        order = (b.get("format") or {}).get("table_block_column_order", [])
        rows = []
        for rid in b.get("content", []):
            r = self.blocks.get(rid)
            if r is None:
                raise IncompleteError(f"표 행 {rid} 를 불러오지 못했습니다.")
            cells = [rich((r.get("properties") or {}).get(col)).replace("|", "\\|").replace("\n", "<br>") for col in order]
            rows.append(f"{indent}| " + " | ".join(cells) + " |")
        if rows:
            rows.insert(1, indent + "|" + "---|" * len(order))
        return rows

    def collection(self, b, indent):
        coll = self.collections.get(b["id"])
        if coll is None:
            self.warnings.append(f"데이터베이스 {b['id']} 를 불러오지 못했습니다.")
            return [f"{indent}<!-- notion-sync: 데이터베이스를 불러오지 못함 -->"]
        lines = [f"{indent}**🗂 {coll['name'] or '데이터베이스'}**", ""]
        lines += [f"{indent}- {self.child_link(rid, title)}" for rid, title in coll["rows"]] or [f"{indent}(비어 있음)"]
        return lines

    def properties(self) -> list[str]:
        page = self.blocks[self.page_id]
        lines = []
        for pid, spec in (self.schema or {}).items():
            if spec.get("type") == "title":
                continue
            value = rich((page.get("properties") or {}).get(pid))
            if value:
                lines.append(f"- **{spec.get('name', pid)}**: {value}")
        return lines


def render(rm: dict, page_id: str, collections: dict | None = None, schema: dict | None = None):
    """(정규화된 Markdown, 경고, {이미지 파일명: URL}). 본문 블록이 빠져 있으면 IncompleteError."""
    r = _Renderer(rm, page_id, collections or {}, schema)
    page = r.blocks[page_id]
    title = plain((page.get("properties") or {}).get("title")).strip() or "Untitled"
    lines = [f"# {title}", "", f"> 원본: {page_url(page_id)}", ""]
    props = r.properties()
    if props:
        lines += props + [""]
    if page.get("type") == "collection_view_page":
        lines += r.collection(page, "")
    else:
        lines += r.children(page, "")
    return normalize("\n".join(lines)), r.warnings, r.images
