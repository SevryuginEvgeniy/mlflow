import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path
from typing import Any, cast

REPOSITORY = "mlflow/mlflow"


def post(endpoint: str, data: Any = None) -> dict[str, Any]:
    result = subprocess.run(
        ["gh", "api", f"repos/{REPOSITORY}/{endpoint}", "--method", "POST", "--input", "-"],
        input=json.dumps(data or {}),
        stdout=subprocess.PIPE,
        text=True,
        check=True,
    )
    return cast(dict[str, Any], json.loads(result.stdout)) if result.stdout.strip() else {}


def published_issues() -> list[dict[str, Any]]:
    result = subprocess.run(
        [
            "gh",
            "api",
            "--paginate",
            "--slurp",
            f"repos/{REPOSITORY}/issues?state=all&labels=nightly&per_page=100",
        ],
        stdout=subprocess.PIPE,
        text=True,
        check=True,
    )
    return [
        issue for page in json.loads(result.stdout) for issue in page if "pull_request" not in issue
    ]


def issue_body(group: dict[str, Any]) -> str:
    body = f"{group['summary']}\n\n### Evidence\n\n{group['evidence']}"
    jobs = "\n".join(
        f"- [{job['workflow_name']} / {job['job_name']}]({job['job_run_url']})"
        for job in group["jobs"]
    )
    return f"{body}\n\n### Failed jobs\n\n{jobs}"


def issue_marker(title: str, body: str) -> str:
    digest = hashlib.sha256(json.dumps({"title": title, "body": body}).encode()).hexdigest()
    return f"<!-- nightly-group:{digest} -->"


def publish(report: dict[str, Any], *, dry_run: bool) -> None:
    new_count = 0
    existing: list[dict[str, Any]] | None = None
    for group in report["groups"]:
        if group["verdict"] != "new":
            sys.stdout.write(f"{group['verdict']}: {group['summary']}\n")
            continue
        body = issue_body(group)
        marker = issue_marker(group["title"], body)
        body = f"{body}\n\n{marker}"
        new_count += 1
        if dry_run:
            sys.stdout.write(f"Would create issue: {group['title']}\n\n{body}\n\n")
        else:
            if existing is None:
                existing = published_issues()
            match = next((issue for issue in existing if marker in (issue.get("body") or "")), None)
            if match:
                sys.stdout.write(f"Already created {match['html_url']}\n")
                continue
            number = post("issues", {"title": group["title"], "body": body, "labels": ["nightly"]})[
                "number"
            ]
            url = f"https://github.com/{REPOSITORY}/issues/{number}"
            existing.append({"body": body, "html_url": url})
            sys.stdout.write(f"Created {url}\n")
    if new_count == 0:
        sys.stdout.write("No new nightly issues.\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Print or create nightly issues")
    parser.add_argument("report", type=Path)
    parser.add_argument(
        "--dry-run", action="store_true", help="Print issue drafts without creating issues"
    )
    args = parser.parse_args()
    publish(json.loads(args.report.read_text()), dry_run=args.dry_run)
