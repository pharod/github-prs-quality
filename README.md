# PR Quality Dashboard (SPA)

A single-page React app that pulls GitHub PR data directly from the API, computes reviewability signals, and renders a dashboard with weekly trends and before/after deltas. Token is stored locally (localStorage or sessionStorage) and data is cached in IndexedDB for faster reloads.

## Quickstart
```bash
npm install
npm run dev
```

## Build
```bash
npm run build
npm run preview
```

## How it works
- The app requests a GitHub token (stored locally in localStorage or sessionStorage).
- You can pick any repo you have access to (user + org repos).
- It computes a PR score and supporting metrics for recent merged PRs.
- Charts show weekly medians and distribution signals.

## Notes
- IndexedDB cache reduces API calls. Use "Clear cache" to refetch.
- CI fail-before-merge is approximated via check runs + commit statuses.
- Review churn is based on commit stats after the first non-author review.

## CLI (optional)
The earlier CLI prototype remains in `pr_quality_dashboard.py` if you want a one-off HTML export.
