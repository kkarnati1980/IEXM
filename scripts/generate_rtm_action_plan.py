from __future__ import annotations

import csv
from collections import defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RTM_CSV = ROOT / "docs" / "requirements-traceability-matrix.csv"
OUT_MD = ROOT / "docs" / "rtm-category-action-plan.md"


ORDER = [
    ("Deferred/Gap", "Decide: build now, defer formally, or remove from launch scope."),
    ("Needs Review", "Deferred by product decision; no immediate production build work unless re-opened."),
    ("Partially Implemented", "Decide: acceptable for pilot, production backlog, or must-build before launch."),
    ("Implemented by Exclusion", "Validate the exclusion remains true and add guard tests/docs where needed."),
]


def primary_area(row: dict[str, str]) -> str:
    area = row.get("implementation_area", "")
    return area.split(", ")[0] if area else "manual_review"


def escape_cell(value: str) -> str:
    return " ".join(str(value).split()).replace("|", "/")


def main() -> None:
    with RTM_CSV.open(encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))

    lines = [
        "# RTM Category Action Plan",
        "",
        "This is the step-by-step working plan for reviewing the non-fully-implemented RTM categories.",
        "The complete row-level matrix remains in `docs/requirements-traceability-matrix.csv` and `docs/requirements-traceability-matrix.xlsx`.",
        "",
        "Recommended review order:",
        "1. Deferred/Gap",
        "2. Partially Implemented",
        "3. Implemented by Exclusion",
        "",
        "Production decision: the prior Needs Review category has been formally deferred. Those rows are now tracked inside Deferred/Gap as `manual_review_deferred` and should not be built unless the scope is explicitly re-opened.",
        "",
    ]

    for status, purpose in ORDER:
        subset = [row for row in rows if row["coverage_status"] == status]
        groups: dict[str, list[dict[str, str]]] = defaultdict(list)
        for row in subset:
            groups[primary_area(row)].append(row)

        lines.extend([
            f"## {status}",
            "",
            f"Count: {len(subset)}",
            "",
            f"Purpose: {purpose}",
            "",
            "| Step | Work package | Count | RTM IDs | Representative items |",
            "|---:|---|---:|---|---|",
        ])

        ordered_groups = sorted(groups.items(), key=lambda item: (-len(item[1]), item[0]))
        for step, (area, items) in enumerate(ordered_groups, start=1):
            ids = ", ".join(row["requirement_id"] for row in items)
            representatives = []
            for row in items[:6]:
                representatives.append(f"{row['requirement_id']}: {escape_cell(row['requirement'][:170])}")
            if len(items) > 6:
                representatives.append(f"... {len(items) - 6} more in full RTM")
            lines.append(
                f"| {step} | `{area}` | {len(items)} | {ids} | {'<br>'.join(representatives)} |"
            )
        lines.append("")

    OUT_MD.write_text("\n".join(lines), encoding="utf-8")
    print(OUT_MD)


if __name__ == "__main__":
    main()
