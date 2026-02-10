#!/usr/bin/env python3
"""
Generate an HTML dashboard for recent GitHub PRs and quality signals.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from statistics import median
from typing import Any, Dict, List, Optional, Tuple

API_BASE = "https://api.github.com"
DEFAULT_MAX_PRS = 50
DEFAULT_MONTHS = 12
DEFAULT_SCORE_THRESHOLD = 70
DEFAULT_MAX_COMMITS_CHECK = 20


class GitHubAPI:
    def __init__(self, token: str, user_agent: str = "pr-quality-dashboard") -> None:
        self.token = token
        self.user_agent = user_agent

    def _request(self, url: str) -> Any:
        headers = {
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {self.token}",
            "User-Agent": self.user_agent,
        }
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req) as resp:
            data = resp.read().decode("utf-8")
            if not data:
                return None
            return json.loads(data)

    def get_paginated(self, url: str, max_pages: int = 10) -> List[Any]:
        items: List[Any] = []
        next_url = url
        pages = 0
        while next_url and pages < max_pages:
            data, next_url = self._get_page(next_url)
            if not data:
                break
            items.extend(data)
            pages += 1
        return items

    def _get_page(self, url: str) -> Tuple[List[Any], Optional[str]]:
        headers = {
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {self.token}",
            "User-Agent": self.user_agent,
        }
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req) as resp:
            data = resp.read().decode("utf-8")
            parsed = json.loads(data) if data else []
            link = resp.headers.get("Link")
            next_url = None
            if link:
                parts = link.split(",")
                for part in parts:
                    if 'rel="next"' in part:
                        next_url = part[part.find("<") + 1 : part.find(">")]
                        break
            return parsed, next_url


def parse_iso8601(value: Optional[str]) -> Optional[dt.datetime]:
    if not value:
        return None
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


def iso_week_key(value: dt.datetime) -> str:
    year, week, _ = value.isocalendar()
    return f"{year}-W{week:02d}"


def percentile(values: List[float], pct: float) -> Optional[float]:
    if not values:
        return None
    if len(values) == 1:
        return values[0]
    values_sorted = sorted(values)
    k = (len(values_sorted) - 1) * (pct / 100.0)
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return values_sorted[int(k)]
    d0 = values_sorted[f] * (c - k)
    d1 = values_sorted[c] * (k - f)
    return d0 + d1


def safe_median(values: List[float]) -> Optional[float]:
    if not values:
        return None
    return median(values)


def clamp(value: float, min_value: float, max_value: float) -> float:
    return max(min_value, min(max_value, value))


def score_pr(metrics: Dict[str, Any]) -> Tuple[float, Dict[str, float]]:
    """
    Compute PR reviewability/risk score (0-100). Higher is better.
    Returns score and component contributions.
    """
    additions = metrics.get("additions", 0)
    deletions = metrics.get("deletions", 0)
    files_changed = metrics.get("files_changed", 0)
    size = additions + deletions

    review_rounds = metrics.get("review_rounds") or 0
    churn_ratio = metrics.get("churn_ratio") or 0.0
    time_to_first_review_hours = metrics.get("time_to_first_review_hours")
    time_to_merge_hours = metrics.get("time_to_merge_hours")
    ci_failed = metrics.get("ci_failed") is True

    # Normalize metrics to 0..1 risk scale (higher is worse)
    size_risk = clamp(math.log1p(size) / math.log1p(2000), 0.0, 1.0)
    files_risk = clamp(files_changed / 50.0, 0.0, 1.0)
    review_rounds_risk = clamp(review_rounds / 3.0, 0.0, 1.0)
    churn_risk = clamp(churn_ratio / 0.5, 0.0, 1.0)

    if time_to_first_review_hours is None:
        tfr_risk = 0.5
    else:
        tfr_risk = clamp(time_to_first_review_hours / 72.0, 0.0, 1.0)

    if time_to_merge_hours is None:
        ttm_risk = 0.5
    else:
        ttm_risk = clamp(time_to_merge_hours / 240.0, 0.0, 1.0)

    ci_risk = 1.0 if ci_failed else 0.0

    weights = {
        "size": 0.20,
        "files": 0.10,
        "review_rounds": 0.20,
        "churn": 0.15,
        "time_to_first_review": 0.10,
        "time_to_merge": 0.15,
        "ci_fail": 0.10,
    }

    risk = (
        size_risk * weights["size"]
        + files_risk * weights["files"]
        + review_rounds_risk * weights["review_rounds"]
        + churn_risk * weights["churn"]
        + tfr_risk * weights["time_to_first_review"]
        + ttm_risk * weights["time_to_merge"]
        + ci_risk * weights["ci_fail"]
    )

    score = clamp(100.0 * (1.0 - risk), 0.0, 100.0)
    components = {
        "size_risk": size_risk,
        "files_risk": files_risk,
        "review_rounds_risk": review_rounds_risk,
        "churn_risk": churn_risk,
        "tfr_risk": tfr_risk,
        "ttm_risk": ttm_risk,
        "ci_risk": ci_risk,
    }
    return score, components


def build_html(payload: Dict[str, Any]) -> str:
    data_json = json.dumps(payload)
    return f"""<!doctype html>
<html lang=\"en\">
<head>
  <meta charset=\"utf-8\" />
  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />
  <title>PR Quality Dashboard</title>
  <script src=\"https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js\"></script>
  <style>
    :root {{
      color-scheme: light;
      --bg: #f7f5f0;
      --card: #ffffff;
      --ink: #1a1a1a;
      --muted: #6b6b6b;
      --accent: #0b7285;
      --accent-2: #f59f00;
      --danger: #c92a2a;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
      background: radial-gradient(circle at top, #fff6e6, var(--bg));
      color: var(--ink);
    }}
    header {{
      padding: 32px 28px 10px;
    }}
    h1 {{
      margin: 0 0 6px;
      font-size: 28px;
      letter-spacing: -0.02em;
    }}
    .subtitle {{
      color: var(--muted);
      font-size: 14px;
    }}
    .grid {{
      display: grid;
      gap: 18px;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      padding: 18px 28px 32px;
    }}
    .card {{
      background: var(--card);
      border-radius: 14px;
      padding: 18px;
      box-shadow: 0 10px 24px rgba(0,0,0,0.08);
    }}
    .card h2 {{
      margin: 0 0 12px;
      font-size: 18px;
    }}
    .kpis {{
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 12px;
    }}
    .kpi {{
      background: #f3f1ec;
      border-radius: 10px;
      padding: 12px;
      font-size: 13px;
    }}
    .kpi .value {{
      font-size: 20px;
      font-weight: 600;
      margin-top: 6px;
    }}
    table {{
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }}
    th, td {{
      text-align: left;
      padding: 10px 8px;
      border-bottom: 1px solid #ebe7df;
      vertical-align: top;
    }}
    th {{
      color: var(--muted);
      font-weight: 600;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }}
    .badge {{
      display: inline-block;
      padding: 2px 6px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
    }}
    .badge.good {{ background: #d3f9d8; color: #2b8a3e; }}
    .badge.warn {{ background: #fff3bf; color: #d9480f; }}
    .badge.bad {{ background: #ffe3e3; color: #c92a2a; }}
    a {{ color: var(--accent); text-decoration: none; }}
    a:hover {{ text-decoration: underline; }}
    .note {{ font-size: 12px; color: var(--muted); margin-top: 8px; }}
  </style>
</head>
<body>
  <header>
    <h1>PR Quality Dashboard</h1>
    <div class=\"subtitle\">Repository: {payload['repo']} - Generated {payload['generated_at']}</div>
  </header>
  <section class=\"grid\">
    <div class=\"card\">
      <h2>Before vs After Adoption</h2>
      <div class=\"kpis\" id=\"delta-kpis\"></div>
      <div class=\"note\">Adoption date: {payload['adoption_date'] or 'Not set'} - Metrics use merged PRs only.</div>
    </div>
    <div class=\"card\">
      <h2>Weekly Score Trend</h2>
      <canvas id=\"scoreTrend\" height=\"160\"></canvas>
    </div>
    <div class=\"card\">
      <h2>Weekly Operational Signals</h2>
      <canvas id=\"opsTrend\" height=\"160\"></canvas>
    </div>
    <div class=\"card\" style=\"grid-column: 1 / -1;\">
      <h2>Recent PRs</h2>
      <table>
        <thead>
          <tr>
            <th>PR</th>
            <th>Author</th>
            <th>Score</th>
            <th>CI</th>
            <th>Size</th>
            <th>Review Rounds</th>
            <th>Churn</th>
            <th>Time to 1st Review</th>
            <th>Time to Merge</th>
          </tr>
        </thead>
        <tbody id=\"prs-body\"></tbody>
      </table>
    </div>
  </section>
  <script>
    const payload = {data_json};

    const formatHours = (value) => {
      if (value === null || value === undefined) return "-";
      if (value < 1) return `${Math.round(value * 60)}m`;
      return `${value.toFixed(1)}h`;
    };

    const formatPct = (value) => value === null || value === undefined ? "-" : `${(value * 100).toFixed(1)}%`;

    const scoreBadge = (score) => {
      if (score >= 85) return "good";
      if (score >= 70) return "warn";
      return "bad";
    };

    const prsBody = document.getElementById("prs-body");
    payload.prs.forEach(pr => {
      const row = document.createElement("tr");
      row.innerHTML = `
        <td><a href=\"${pr.url}\" target=\"_blank\" rel=\"noreferrer\">#${pr.number} ${pr.title}</a></td>
        <td>${pr.author}</td>
        <td><span class=\"badge ${scoreBadge(pr.score)}\">${pr.score.toFixed(1)}</span></td>
        <td>${pr.ci_failed ? "Failed" : "Clean"}</td>
        <td>${pr.additions + pr.deletions} / ${pr.files_changed} files</td>
        <td>${pr.review_rounds}</td>
        <td>${formatPct(pr.churn_ratio)}</td>
        <td>${formatHours(pr.time_to_first_review_hours)}</td>
        <td>${formatHours(pr.time_to_merge_hours)}</td>
      `;
      prsBody.appendChild(row);
    });

    const deltaContainer = document.getElementById("delta-kpis");
    payload.deltas.forEach(delta => {
      const box = document.createElement("div");
      box.className = "kpi";
      box.innerHTML = `
        <div>${delta.label}</div>
        <div class=\"value\">${delta.after ?? "-"}</div>
        <div class=\"note\">Before: ${delta.before ?? "-"} - Delta ${delta.delta ?? "-"}</div>
      `;
      deltaContainer.appendChild(box);
    });

    const labels = payload.weekly.map(w => w.week);
    const scoreData = {
      labels,
      datasets: [
        {
          label: "Median Score",
          data: payload.weekly.map(w => w.median_score),
          borderColor: "#0b7285",
          backgroundColor: "rgba(11,114,133,0.08)",
          tension: 0.3,
        },
        {
          label: "P25",
          data: payload.weekly.map(w => w.p25_score),
          borderColor: "rgba(11,114,133,0.2)",
          borderDash: [4, 4],
        },
        {
          label: "P75",
          data: payload.weekly.map(w => w.p75_score),
          borderColor: "rgba(11,114,133,0.2)",
          borderDash: [4, 4],
        }
      ]
    };

    new Chart(document.getElementById("scoreTrend"), {
      type: "line",
      data: scoreData,
      options: {
        responsive: true,
        plugins: { legend: { position: "bottom" } },
        scales: { y: { min: 0, max: 100 } }
      }
    });

    const opsData = {
      labels,
      datasets: [
        {
          label: "% Below Threshold",
          data: payload.weekly.map(w => w.pct_below_threshold),
          borderColor: "#c92a2a",
          backgroundColor: "rgba(201,42,42,0.1)",
          tension: 0.3,
        },
        {
          label: "CI Fail Rate",
          data: payload.weekly.map(w => w.ci_fail_rate),
          borderColor: "#f59f00",
          backgroundColor: "rgba(245,159,0,0.1)",
          tension: 0.3,
        },
        {
          label: "Median Churn",
          data: payload.weekly.map(w => w.median_churn),
          borderColor: "#1864ab",
          backgroundColor: "rgba(24,100,171,0.1)",
          tension: 0.3,
        },
        {
          label: "Median Size",
          data: payload.weekly.map(w => w.median_size),
          borderColor: "#2f9e44",
          backgroundColor: "rgba(47,158,68,0.1)",
          tension: 0.3,
          yAxisID: "y2",
        },
        {
          label: "Median Review Rounds",
          data: payload.weekly.map(w => w.median_review_rounds),
          borderColor: "#7048e8",
          backgroundColor: "rgba(112,72,232,0.1)",
          tension: 0.3,
          yAxisID: "y2",
        }
      ]
    };

    new Chart(document.getElementById("opsTrend"), {
      type: "line",
      data: opsData,
      options: {
        responsive: true,
        plugins: { legend: { position: "bottom" } },
        scales: {
          y: { min: 0, max: 1, ticks: { callback: (v) => `${Math.round(v * 100)}%` } },
          y2: { position: "right", min: 0, grid: { drawOnChartArea: false } }
        }
      }
    });
  </script>
</body>
</html>
"""


def get_repo_from_git_remote() -> Optional[str]:
    # Try to read git remote origin
    git_dir = os.path.join(os.getcwd(), ".git", "config")
    if not os.path.exists(git_dir):
        return None
    try:
        with open(git_dir, "r", encoding="utf-8") as fh:
            content = fh.read()
        for line in content.splitlines():
            if line.strip().startswith("url ="):
                url = line.split("=", 1)[1].strip()
                # Support git@github.com:owner/repo.git or https://github.com/owner/repo.git
                if "github.com" in url:
                    if url.startswith("git@github.com:"):
                        path = url.replace("git@github.com:", "")
                    else:
                        path = urllib.parse.urlparse(url).path.lstrip("/")
                    if path.endswith(".git"):
                        path = path[:-4]
                    return path
    except OSError:
        return None
    return None


def compute_review_rounds(reviews: List[Dict[str, Any]]) -> int:
    return sum(1 for review in reviews if review.get("state") == "CHANGES_REQUESTED")


def compute_first_review_time(reviews: List[Dict[str, Any]], author: str) -> Optional[dt.datetime]:
    times = []
    for review in reviews:
        user = review.get("user") or {}
        if user.get("login") == author:
            continue
        submitted = parse_iso8601(review.get("submitted_at"))
        if submitted:
            times.append(submitted)
    return min(times) if times else None


def compute_churn_ratio(
    api: GitHubAPI,
    repo: str,
    pr_number: int,
    author: str,
    first_review_time: Optional[dt.datetime],
    max_commits_check: int,
) -> Optional[float]:
    commits_url = f"{API_BASE}/repos/{repo}/pulls/{pr_number}/commits?per_page=100"
    commits = api.get_paginated(commits_url)
    if not commits:
        return None

    total_changes = 0
    after_review_changes = 0

    for idx, commit in enumerate(commits):
        if idx >= max_commits_check:
            break
        sha = commit.get("sha")
        commit_details = api._request(f"{API_BASE}/repos/{repo}/commits/{sha}")
        stats = commit_details.get("stats") or {}
        commit_changes = (stats.get("additions", 0) + stats.get("deletions", 0))
        total_changes += commit_changes

        commit_time = parse_iso8601(commit_details.get("commit", {}).get("committer", {}).get("date"))
        if first_review_time and commit_time and commit_time > first_review_time:
            after_review_changes += commit_changes

    if total_changes == 0:
        return 0.0
    return after_review_changes / total_changes


def compute_ci_failed(
    api: GitHubAPI,
    repo: str,
    pr_number: int,
    max_commits_check: int,
) -> bool:
    commits_url = f"{API_BASE}/repos/{repo}/pulls/{pr_number}/commits?per_page=100"
    commits = api.get_paginated(commits_url)
    if not commits:
        return False

    for idx, commit in enumerate(commits):
        if idx >= max_commits_check:
            break
        sha = commit.get("sha")
        check_runs_url = f"{API_BASE}/repos/{repo}/commits/{sha}/check-runs"
        try:
            runs = api._request(check_runs_url) or {}
        except urllib.error.HTTPError:
            runs = {}
        for run in runs.get("check_runs", []) if isinstance(runs, dict) else []:
            conclusion = run.get("conclusion")
            if conclusion in {"failure", "cancelled", "timed_out", "action_required"}:
                return True

        status_url = f"{API_BASE}/repos/{repo}/commits/{sha}/status"
        try:
            status = api._request(status_url) or {}
        except urllib.error.HTTPError:
            status = {}
        state = status.get("state")
        if state in {"failure", "error"}:
            return True

    return False


def format_delta(before: Optional[float], after: Optional[float], fmt: str) -> Tuple[Optional[str], Optional[str], Optional[str]]:
    if before is None or after is None:
        return None, None, None
    delta = after - before
    return fmt.format(before), fmt.format(after), fmt.format(delta)


def build_deltas(prs: List[Dict[str, Any]], adoption_date: Optional[dt.datetime]) -> List[Dict[str, Optional[str]]]:
    if not adoption_date:
        return [
            {"label": "Median Score", "before": None, "after": None, "delta": None},
            {"label": "CI Fail Rate", "before": None, "after": None, "delta": None},
            {"label": "Median Churn", "before": None, "after": None, "delta": None},
            {"label": "Median Size", "before": None, "after": None, "delta": None},
        ]

    before_prs = [pr for pr in prs if pr.get("merged_at") and pr["merged_at"] < adoption_date]
    after_prs = [pr for pr in prs if pr.get("merged_at") and pr["merged_at"] >= adoption_date]

    def median_of(key: str, values: List[Dict[str, Any]]) -> Optional[float]:
        filtered = [pr[key] for pr in values if pr.get(key) is not None]
        return safe_median(filtered) if filtered else None

    def rate_of(key: str, values: List[Dict[str, Any]]) -> Optional[float]:
        if not values:
            return None
        count = sum(1 for pr in values if pr.get(key))
        return count / len(values)

    deltas = []
    before_score = median_of("score", before_prs)
    after_score = median_of("score", after_prs)
    b, a, d = format_delta(before_score, after_score, "{:.1f}")
    deltas.append({"label": "Median Score", "before": b, "after": a, "delta": d})

    before_ci = rate_of("ci_failed", before_prs)
    after_ci = rate_of("ci_failed", after_prs)
    b, a, d = format_delta(before_ci, after_ci, "{:.1%}")
    deltas.append({"label": "CI Fail Rate", "before": b, "after": a, "delta": d})

    before_churn = median_of("churn_ratio", before_prs)
    after_churn = median_of("churn_ratio", after_prs)
    b, a, d = format_delta(before_churn, after_churn, "{:.1%}")
    deltas.append({"label": "Median Churn", "before": b, "after": a, "delta": d})

    before_size = median_of("size", before_prs)
    after_size = median_of("size", after_prs)
    b, a, d = format_delta(before_size, after_size, "{:.1f}")
    deltas.append({"label": "Median Size", "before": b, "after": a, "delta": d})

    return deltas


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate PR quality dashboard HTML.")
    parser.add_argument("--repo", help="GitHub repo in owner/name form. Defaults to git remote origin.")
    parser.add_argument("--token", help="GitHub token (or set GITHUB_TOKEN/GH_TOKEN env var).")
    parser.add_argument("--max-prs", type=int, default=DEFAULT_MAX_PRS, help="Max merged PRs to include.")
    parser.add_argument("--months", type=int, default=DEFAULT_MONTHS, help="Months of history for weekly charts.")
    parser.add_argument("--adoption-date", help="Adoption date YYYY-MM-DD for before/after deltas.")
    parser.add_argument("--score-threshold", type=int, default=DEFAULT_SCORE_THRESHOLD)
    parser.add_argument("--max-commits-check", type=int, default=DEFAULT_MAX_COMMITS_CHECK)
    parser.add_argument("--output", default="pr_quality_dashboard.html")

    args = parser.parse_args()

    repo = args.repo or get_repo_from_git_remote()
    if not repo:
        print("Error: --repo not provided and git remote origin not found.")
        return 1

    token = args.token or os.getenv("GITHUB_TOKEN") or os.getenv("GH_TOKEN")
    if not token:
        print("Error: GitHub token required via --token or GITHUB_TOKEN/GH_TOKEN.")
        return 1

    adoption_date = parse_iso8601(args.adoption_date) if args.adoption_date else None

    api = GitHubAPI(token)

    print(f"Fetching PRs for {repo}...")
    prs_url = f"{API_BASE}/repos/{repo}/pulls?state=closed&per_page=100&sort=updated&direction=desc"
    raw_prs = api.get_paginated(prs_url, max_pages=10)

    merged_prs = [pr for pr in raw_prs if pr.get("merged_at")]
    merged_prs = sorted(merged_prs, key=lambda pr: pr.get("merged_at"), reverse=True)[: args.max_prs]

    since = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=30 * args.months)

    processed_prs: List[Dict[str, Any]] = []
    weekly_buckets: Dict[str, List[Dict[str, Any]]] = {}

    for pr in merged_prs:
        number = pr.get("number")
        pr_details = api._request(f"{API_BASE}/repos/{repo}/pulls/{number}")
        reviews = api.get_paginated(f"{API_BASE}/repos/{repo}/pulls/{number}/reviews?per_page=100")

        author = pr_details.get("user", {}).get("login", "unknown")
        first_review_time = compute_first_review_time(reviews, author)

        churn_ratio = compute_churn_ratio(
            api,
            repo,
            number,
            author,
            first_review_time,
            args.max_commits_check,
        )
        ci_failed = compute_ci_failed(api, repo, number, args.max_commits_check)

        merged_at = parse_iso8601(pr_details.get("merged_at"))
        created_at = parse_iso8601(pr_details.get("created_at"))

        time_to_first_review = None
        if created_at and first_review_time:
            time_to_first_review = (first_review_time - created_at).total_seconds() / 3600

        time_to_merge = None
        if created_at and merged_at:
            time_to_merge = (merged_at - created_at).total_seconds() / 3600

        metrics = {
            "additions": pr_details.get("additions", 0),
            "deletions": pr_details.get("deletions", 0),
            "files_changed": pr_details.get("changed_files", 0),
            "review_rounds": compute_review_rounds(reviews),
            "churn_ratio": churn_ratio,
            "time_to_first_review_hours": time_to_first_review,
            "time_to_merge_hours": time_to_merge,
            "ci_failed": ci_failed,
        }

        score, _ = score_pr(metrics)
        size = metrics["additions"] + metrics["deletions"]

        pr_entry = {
            "number": number,
            "title": pr_details.get("title", ""),
            "url": pr_details.get("html_url"),
            "author": author,
            "score": score,
            "ci_failed": ci_failed,
            "additions": metrics["additions"],
            "deletions": metrics["deletions"],
            "files_changed": metrics["files_changed"],
            "review_rounds": metrics["review_rounds"],
            "churn_ratio": churn_ratio,
            "time_to_first_review_hours": time_to_first_review,
            "time_to_merge_hours": time_to_merge,
            "merged_at": merged_at,
            "size": size,
        }
        processed_prs.append(pr_entry)

        if merged_at and merged_at >= since:
            key = iso_week_key(merged_at)
            weekly_buckets.setdefault(key, []).append(pr_entry)

    weekly_stats = []
    for week in sorted(weekly_buckets.keys()):
        items = weekly_buckets[week]
        scores = [pr["score"] for pr in items]
        churns = [pr["churn_ratio"] for pr in items if pr.get("churn_ratio") is not None]
        sizes = [pr["size"] for pr in items]
        rounds = [pr["review_rounds"] for pr in items]
        ci_fail_rate = sum(1 for pr in items if pr.get("ci_failed")) / len(items)
        pct_below = sum(1 for pr in items if pr.get("score", 0) < args.score_threshold) / len(items)

        weekly_stats.append(
            {
                "week": week,
                "median_score": safe_median(scores),
                "p25_score": percentile(scores, 25),
                "p75_score": percentile(scores, 75),
                "pct_below_threshold": pct_below,
                "ci_fail_rate": ci_fail_rate,
                "median_churn": safe_median(churns),
                "median_size": safe_median(sizes),
                "median_review_rounds": safe_median(rounds),
            }
        )

    payload = {
        "repo": repo,
        "generated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "adoption_date": args.adoption_date,
        "prs": processed_prs,
        "weekly": weekly_stats,
        "score_threshold": args.score_threshold,
        "deltas": build_deltas(processed_prs, adoption_date),
    }

    html = build_html(payload)
    with open(args.output, "w", encoding="utf-8") as fh:
        fh.write(html)

    print(f"Wrote {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
