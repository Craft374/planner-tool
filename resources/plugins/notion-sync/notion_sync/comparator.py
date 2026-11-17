"""정규화, 해시, 3-way 상태 분류."""
import hashlib
import re
import unicodedata

ADDED, MODIFIED, UNCHANGED, RENAMED, DELETED, CONFLICT, ERROR = (
    "ADDED", "MODIFIED", "UNCHANGED", "RENAMED", "DELETED", "CONFLICT", "ERROR",
)


def normalize(text: str) -> str:
    """원격·로컬 모두 같은 규칙: 줄바꿈 LF, 줄 끝 공백 제거, NFC, 끝 줄바꿈 1개."""
    text = text.removeprefix("﻿")  # Visual Studio 등이 붙이는 BOM
    text = unicodedata.normalize("NFC", text.replace("\r\n", "\n").replace("\r", "\n"))
    text = re.sub(r"[ \t]+$", "", text, flags=re.M).strip("\n")
    return text + "\n" if text else ""


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def classify(base_hash: str | None, local_hash: str | None, remote_hash: str | None,
             title_changed: bool) -> str:
    """
    base   = 이전 동기화 시점 해시(manifest), 없으면 신규
    local  = 현재 로컬 파일 해시, 파일이 없으면 None
    remote = 현재 Notion 해시, 조회하지 않았으면 None(Fast 모드에서 수정 시각 동일)
    """
    if local_hash is None:
        return ADDED  # 신규이거나 로컬 파일이 사라짐 → 다시 생성
    if remote_hash is not None and local_hash == remote_hash:
        return RENAMED if title_changed else UNCHANGED  # 이미 같은 내용(충돌 해결 포함)
    if base_hash is None or local_hash != base_hash:
        return CONFLICT  # 관리되지 않던 파일이 있거나 로컬이 수정됨 → 덮어쓰지 않음
    if remote_hash is None or remote_hash == base_hash:
        return RENAMED if title_changed else UNCHANGED
    return MODIFIED
