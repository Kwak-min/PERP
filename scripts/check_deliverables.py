#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"

REQUIRED: dict[str, list[str]] = {
    "20-operations-manual.md": ["시스템 구성", "기동", "백업", "장애 대응", "모니터링"],
    "21-deployment-manual.md": ["환경 분리", "배포 절차", "배포 게이트", "롤백"],
    "22-admin-manual.md": ["권한 관리", "회계 통제", "AI 정책", "개인 Vault", "감사", "가져오기"],
    "23-user-manual.md": ["시작하기", "개인 AI Agent", "개인 Vault", "인수인계", "화면 상태"],
    "reports/test-result-report.md": ["테스트 범위", "실행 결과", "미결 사항"],
    "reports/ai-eval-report.md": ["정확도", "근거", "권한", "승인"],
    "reports/security-review-report.md": ["인증", "권한", "AI 안전성", "취약점", "조치"],
}


def main() -> int:
    failures: list[str] = []
    for name, sections in REQUIRED.items():
        path = DOCS / name
        if not path.exists():
            print(f"  MISSING file: docs/{name}")
            failures.append(name)
            continue
        text = path.read_text(encoding="utf-8")
        missing = [s for s in sections if s not in text]
        print(f"[{name}] sections={len(sections)} missing={len(missing)}")
        for section in missing:
            print(f"  MISSING section: {name} -> {section}")
        if missing:
            failures.append(name)

    if failures:
        print(f"\nRESULT: FAIL ({len(failures)} deliverables)")
        return 1
    print("\nRESULT: PASS (MISSING 0)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
