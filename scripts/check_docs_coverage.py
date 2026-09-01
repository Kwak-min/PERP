#!/usr/bin/env python3
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OMO = ROOT / ".omo"
DOCS = ROOT / "docs"

SCREEN_RE = re.compile(
    r"\b(?:AUTH|ONB|COM|DASH|ORG|PRJ|TSK|CAL|FIN|AST|HR|DOC|HND|APR|AI|AUT|INT|ANL|NOT|ADM)-\d{3}\b"
)
REQ_RE = re.compile(r"\b(?:SFR|SIR|PER|DAR|TER|SER)-\d{3}\b")

COMMON_FIELDS = [
    "id",
    "tenant_id",
    "created_at",
    "created_by",
    "updated_at",
    "updated_by",
    "version",
    "deleted_at",
]

REQUIRED_DOCS = [
    "00-requirements-traceability.md",
    "01-repo-structure.md",
    "02-tech-stack.md",
    "03-erd.md",
    "04-api-list.md",
    "05-permission-matrix.md",
    "06-screen-routes.md",
    "07-design-tokens.md",
    "08-ai-agent-tools.md",
    "09-data-classification.md",
    "10-schedule.md",
    "11-risks.md",
]


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8") if path.exists() else ""


def sheet(xls: str, name: str) -> str:
    m = re.search(rf"===== SHEET: {re.escape(name)}.*?=====\n(.*?)(?=\n===== SHEET|\Z)", xls, re.S)
    return m.group(1) if m else ""


def parse_sources() -> dict[str, list[str]]:
    doc = read(OMO / "src-과업지시서.txt")
    xls = read(OMO / "src-요구사항정의서.txt")
    if not doc or not xls:
        print("FATAL: 원본 추출 텍스트(.omo/src-*.txt)가 없습니다.")
        sys.exit(2)
    src = doc + "\n" + xls

    entities = [
        line.split("|")[0].strip()
        for line in sheet(xls, "07_데이터모델").strip().split("\n")[3:]
        if "|" in line
    ]
    apis = [
        line.split("|")[0].strip()
        for line in sheet(xls, "08_API").strip().split("\n")
        if line.strip().startswith("/")
    ]
    roles = [
        line.split("|")[0].strip()
        for line in sheet(xls, "05_역할권한").strip().split("\n")[3:]
        if "|" in line
    ]
    return {
        "screens": sorted(set(SCREEN_RE.findall(src))),
        "requirements": sorted(set(REQ_RE.findall(src))),
        "entities": entities,
        "apis": apis,
        "roles": roles,
    }


def entity_tokens(name: str) -> list[str]:
    return [part.strip() for part in name.split("/") if part.strip()]


def main() -> int:
    src = parse_sources()
    docs_blob = "\n".join(read(p) for p in sorted(DOCS.glob("*.md")))
    failures: list[str] = []

    missing_docs = [d for d in REQUIRED_DOCS if not (DOCS / d).exists()]
    print(f"[docs] required={len(REQUIRED_DOCS)} missing={len(missing_docs)}")
    if missing_docs:
        failures.append("docs: " + ", ".join(missing_docs))
        for d in missing_docs:
            print(f"  MISSING doc: {d}")

    checks = [
        ("screens", src["screens"], read(DOCS / "06-screen-routes.md")),
        ("requirements", src["requirements"], read(DOCS / "00-requirements-traceability.md")),
        ("apis", src["apis"], read(DOCS / "04-api-list.md")),
        ("roles", src["roles"], read(DOCS / "05-permission-matrix.md")),
    ]
    for label, items, blob in checks:
        target = blob or docs_blob
        missing = [i for i in items if i not in target]
        print(f"[{label}] total={len(items)} missing={len(missing)}")
        if missing:
            failures.append(f"{label}: {', '.join(missing)}")
            for i in missing:
                print(f"  MISSING {label}: {i}")

    erd = read(DOCS / "03-erd.md")
    ent_missing = [
        e for e in src["entities"] if not all(tok in (erd or docs_blob) for tok in entity_tokens(e))
    ]
    print(f"[entities] total={len(src['entities'])} missing={len(ent_missing)}")
    if ent_missing:
        failures.append("entities: " + ", ".join(ent_missing))
        for e in ent_missing:
            print(f"  MISSING entity: {e}")

    field_missing = [f for f in COMMON_FIELDS if f not in erd]
    print(f"[common-fields] total={len(COMMON_FIELDS)} missing={len(field_missing)}")
    if field_missing:
        failures.append("common-fields: " + ", ".join(field_missing))
        for f in field_missing:
            print(f"  MISSING common-field: {f}")

    if failures:
        print(f"\nRESULT: FAIL ({len(failures)} category)")
        return 1
    print("\nRESULT: PASS (MISSING 0)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
