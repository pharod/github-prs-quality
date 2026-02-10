import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
  Filler,
} from "chart.js";
import { Line } from "react-chartjs-2";
import SettingsDialog from "./components/SettingsDialog";
import { cacheClear } from "./cache";
import {
  fetchCheckRuns,
  fetchCommitStats,
  fetchCommits,
  fetchMergedPRs,
  fetchPrDetails,
  fetchRepos,
  fetchReviews,
  fetchStatuses,
  fetchViewer,
} from "./github";
import {
  buildDeltas,
  buildWeeklyStats,
  computeChurnRatio,
  scorePrWithDetails,
} from "./metrics";
import type { PRMetrics, RepoSummary } from "./types";
import { formatHours, formatPercent, runWithConcurrency } from "./utils";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
  Filler
);

const TOKEN_KEY = "prQualityToken";
const REMEMBER_KEY = "prQualityRemember";

const DEFAULT_SETTINGS = {
  maxPrs: 50,
  months: 12,
  scoreThreshold: 70,
  maxCommitsCheck: 20,
};

const App = () => {
  const [token, setToken] = useState("");
  const [rememberToken, setRememberToken] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [viewer, setViewer] = useState<string | null>(null);
  const [repos, setRepos] = useState<RepoSummary[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [prMetrics, setPrMetrics] = useState<PRMetrics[]>([]);

  const [adoptionDate, setAdoptionDate] = useState<string>("");
  const [maxPrs, setMaxPrs] = useState(DEFAULT_SETTINGS.maxPrs);
  const [months, setMonths] = useState(DEFAULT_SETTINGS.months);
  const [scoreThreshold, setScoreThreshold] = useState(DEFAULT_SETTINGS.scoreThreshold);
  const [maxCommitsCheck, setMaxCommitsCheck] = useState(DEFAULT_SETTINGS.maxCommitsCheck);

  useEffect(() => {
    const remember = localStorage.getItem(REMEMBER_KEY);
    const rememberFlag = remember ? remember === "true" : true;
    setRememberToken(rememberFlag);
    const storedToken = rememberFlag
      ? localStorage.getItem(TOKEN_KEY)
      : sessionStorage.getItem(TOKEN_KEY);
    if (storedToken) {
      setToken(storedToken);
    }
  }, []);

  useEffect(() => {
    if (!token) {
      setViewer(null);
      setRepos([]);
      setSelectedRepo("");
      setPrMetrics([]);
      return;
    }

    const load = async () => {
      try {
        setLoading(true);
        setError(null);
        setStatus("Fetching account info...");
        const viewerData = await fetchViewer(token);
        setViewer(viewerData.login);
        setStatus("Loading repositories...");
        const repoList = await fetchRepos(token);
        const sorted = [...repoList].sort((a, b) =>
          b.updatedAt.localeCompare(a.updatedAt)
        );
        setRepos(sorted);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
        setStatus("");
      }
    };

    load();
  }, [token]);

  const saveToken = useCallback(async (nextToken: string, remember: boolean) => {
    setToken(nextToken);
    setRememberToken(remember);
    localStorage.setItem(REMEMBER_KEY, String(remember));
    if (remember) {
      localStorage.setItem(TOKEN_KEY, nextToken);
      sessionStorage.removeItem(TOKEN_KEY);
    } else {
      sessionStorage.setItem(TOKEN_KEY, nextToken);
      localStorage.removeItem(TOKEN_KEY);
    }
    await cacheClear();
    setShowSettings(false);
  }, []);

  const clearCache = useCallback(async () => {
    await cacheClear();
    setStatus("Cache cleared.");
    setTimeout(() => setStatus(""), 1500);
  }, []);

  const adoptionDateValue = useMemo(() => {
    return adoptionDate ? new Date(`${adoptionDate}T00:00:00`) : null;
  }, [adoptionDate]);
  const sinceDate = useMemo(() => {
    const now = new Date();
    const days = months * 30;
    const since = new Date(now.getTime());
    since.setDate(now.getDate() - days);
    return since;
  }, [months]);

  const weeklyStats = useMemo(() => {
    return buildWeeklyStats(prMetrics, scoreThreshold, sinceDate);
  }, [prMetrics, scoreThreshold, sinceDate]);

  const deltas = useMemo(() => {
    return buildDeltas(prMetrics, adoptionDateValue);
  }, [prMetrics, adoptionDateValue]);

  const runAnalysis = useCallback(async () => {
    if (!token || !selectedRepo) return;
    setLoading(true);
    setError(null);
    setStatus("Fetching merged PRs...");

    try {
      const prSummaries = await fetchMergedPRs(token, selectedRepo, maxPrs);
      const processed = await runWithConcurrency(prSummaries, 4, async (summary, index) => {
        setStatus(`Processing PR ${index + 1} / ${prSummaries.length}`);

        const [details, reviews, commits] = await Promise.all([
          fetchPrDetails(token, selectedRepo, summary.number),
          fetchReviews(token, selectedRepo, summary.number),
          fetchCommits(token, selectedRepo, summary.number),
        ]);

        const author = details.userLogin;
        const firstReviewAt = reviews
          .filter((review) => review.userLogin !== author)
          .map((review) => review.submittedAt)
          .filter((value): value is string => Boolean(value))
          .map((value) => new Date(value))
          .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;

        const limitedCommits = commits.slice(0, maxCommitsCheck);

        const commitStats = await runWithConcurrency(limitedCommits, 4, async (commit) =>
          fetchCommitStats(token, selectedRepo, commit.sha)
        );

        const churnRatio = computeChurnRatio(commitStats, firstReviewAt);

        const ciFlags = await runWithConcurrency(limitedCommits, 4, async (commit) => {
          const [runs, status] = await Promise.all([
            fetchCheckRuns(token, selectedRepo, commit.sha),
            fetchStatuses(token, selectedRepo, commit.sha),
          ]);
          const failedRun = runs.some((run) =>
            ["failure", "cancelled", "timed_out", "action_required"].includes(
              run.conclusion ?? ""
            )
          );
          const failedStatus = ["failure", "error"].includes(status.state ?? "");
          return failedRun || failedStatus;
        });

        const ciFailed = ciFlags.some(Boolean);

        const createdAt = new Date(details.createdAt);
        const mergedAt = details.mergedAt ? new Date(details.mergedAt) : null;

        const timeToFirstReviewHours = firstReviewAt
          ? (firstReviewAt.getTime() - createdAt.getTime()) / 36e5
          : null;
        const timeToMergeHours = mergedAt
          ? (mergedAt.getTime() - createdAt.getTime()) / 36e5
          : null;

        const reviewRounds = reviews.filter(
          (review) => review.state === "CHANGES_REQUESTED"
        ).length;
        const reviewCount = reviews.filter(
          (review) => review.userLogin !== author && review.submittedAt
        ).length;

        const { score, components: scoreBreakdown } = scorePrWithDetails({
          additions: details.additions,
          deletions: details.deletions,
          filesChanged: details.changedFiles,
          reviewRounds,
          churnRatio,
          timeToFirstReviewHours,
          timeToMergeHours,
          ciFailed,
        });

        return {
          number: details.number,
          title: details.title,
          url: details.htmlUrl,
          author,
          mergedAt,
          additions: details.additions,
          deletions: details.deletions,
          filesChanged: details.changedFiles,
          reviewRounds,
          reviewCount,
          churnRatio,
          timeToFirstReviewHours,
          timeToMergeHours,
          ciFailed,
          score,
          scoreBreakdown,
        } satisfies PRMetrics;
      });

      setPrMetrics(processed);
      setStatus("Analysis complete.");
      setTimeout(() => setStatus(""), 1500);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [token, selectedRepo, maxPrs, maxCommitsCheck]);

  const scoreChartData = useMemo(() => {
    return {
      labels: weeklyStats.map((week) => week.week),
      datasets: [
        {
          label: "Median Score",
          data: weeklyStats.map((week) => week.medianScore),
          borderColor: "#0b7285",
          backgroundColor: "rgba(11,114,133,0.12)",
          tension: 0.3,
          fill: true,
        },
        {
          label: "P25",
          data: weeklyStats.map((week) => week.p25Score),
          borderColor: "rgba(11,114,133,0.35)",
          borderDash: [4, 4],
          tension: 0.3,
        },
        {
          label: "P75",
          data: weeklyStats.map((week) => week.p75Score),
          borderColor: "rgba(11,114,133,0.35)",
          borderDash: [4, 4],
          tension: 0.3,
        },
      ],
    };
  }, [weeklyStats]);

  const opsChartData = useMemo(() => {
    return {
      labels: weeklyStats.map((week) => week.week),
      datasets: [
        {
          label: "% Below Threshold",
          data: weeklyStats.map((week) => week.pctBelowThreshold),
          borderColor: "#c92a2a",
          backgroundColor: "rgba(201,42,42,0.12)",
          tension: 0.3,
          fill: true,
        },
        {
          label: "CI Fail Rate",
          data: weeklyStats.map((week) => week.ciFailRate),
          borderColor: "#f08c00",
          backgroundColor: "rgba(240,140,0,0.12)",
          tension: 0.3,
          fill: true,
        },
        {
          label: "Median Churn",
          data: weeklyStats.map((week) => week.medianChurn),
          borderColor: "#1864ab",
          backgroundColor: "rgba(24,100,171,0.12)",
          tension: 0.3,
          fill: true,
        },
        {
          label: "Median Size",
          data: weeklyStats.map((week) => week.medianSize),
          borderColor: "#2f9e44",
          backgroundColor: "rgba(47,158,68,0.12)",
          tension: 0.3,
          fill: true,
          yAxisID: "y2",
        },
        {
          label: "Median Changes Requested",
          data: weeklyStats.map((week) => week.medianReviewRounds),
          borderColor: "#a0610a",
          backgroundColor: "rgba(160,97,10,0.12)",
          tension: 0.3,
          fill: true,
          yAxisID: "y2",
        },
      ],
    };
  }, [weeklyStats]);

  return (
    <div className="app">
      <header className="hero">
        <div>
          <h1>PR Quality Radar</h1>
          <p className="subtitle">
            Objective reviewability signals for any repo you can access.
          </p>
          <p className="subtitle faint">
            {viewer ? `Signed in as ${viewer}` : "Add a token to get started."}
          </p>
        </div>
        <div className="hero-actions">
          <button className="ghost" onClick={() => setShowSettings(true)}>
            Settings
          </button>
          <button className="ghost" onClick={clearCache}>
            Clear cache
          </button>
        </div>
      </header>

      <SettingsDialog
        isOpen={showSettings}
        token={token}
        rememberToken={rememberToken}
        onClose={() => setShowSettings(false)}
        onSave={saveToken}
      />

      <section className="controls">
        <div className="control-card">
          <h2>Repository</h2>
          <label className="field">
            <span>Pick a repo</span>
            <select
              value={selectedRepo}
              onChange={(event) => setSelectedRepo(event.target.value)}
              disabled={!repos.length}
            >
              <option value="">Select repo</option>
              {repos.map((repo) => (
                <option key={repo.id} value={repo.fullName}>
                  {repo.fullName}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Adoption date</span>
            <input
              type="date"
              value={adoptionDate}
              onChange={(event) => setAdoptionDate(event.target.value)}
            />
          </label>
          <div className="button-row">
            <button
              className="primary"
              onClick={runAnalysis}
              disabled={!selectedRepo || loading}
            >
              {loading ? "Running..." : "Run analysis"}
            </button>
          </div>
        </div>

        <div className="control-card">
          <h2>Scope</h2>
          <label className="field">
            <span>Max recent PRs</span>
            <input
              type="number"
              min={10}
              max={200}
              value={maxPrs}
              onChange={(event) => setMaxPrs(Number(event.target.value))}
            />
          </label>
          <label className="field">
            <span>Months of history</span>
            <input
              type="number"
              min={3}
              max={24}
              value={months}
              onChange={(event) => setMonths(Number(event.target.value))}
            />
          </label>
          <label className="field">
            <span>Score threshold</span>
            <input
              type="number"
              min={40}
              max={95}
              value={scoreThreshold}
              onChange={(event) => setScoreThreshold(Number(event.target.value))}
            />
          </label>
          <label className="field">
            <span>Max commits to inspect</span>
            <input
              type="number"
              min={5}
              max={50}
              value={maxCommitsCheck}
              onChange={(event) => setMaxCommitsCheck(Number(event.target.value))}
            />
          </label>
        </div>
      </section>

      {status && <div className="status">{status}</div>}
      {error && <div className="error">{error}</div>}

      <section className="grid">
        <div className="card">
          <h2>Before vs After Adoption</h2>
          <div className="kpis">
            {deltas.map((delta) => (
              <div key={delta.label} className="kpi">
                <div>{delta.label}</div>
                <div className="value">{delta.after ?? "-"}</div>
                <div className="note">
                  Before: {delta.before ?? "-"} - Delta {delta.delta ?? "-"}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <h2>Weekly Score Trend</h2>
          <Line
            data={scoreChartData}
            options={{
              responsive: true,
              plugins: { legend: { position: "bottom" } },
              scales: { y: { min: 0, max: 100 } },
            }}
          />
        </div>

        <div className="card">
          <h2>Weekly Operational Signals</h2>
          <Line
            data={opsChartData}
            options={{
              responsive: true,
              plugins: { legend: { position: "bottom" } },
              scales: {
                y: {
                  min: 0,
                  max: 1,
                  ticks: { callback: (value) => `${Math.round(Number(value) * 100)}%` },
                },
                y2: { position: "right", min: 0, grid: { drawOnChartArea: false } },
              },
            }}
          />
        </div>

        <div className="card table-card">
          <h2>Recent PRs</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>PR</th>
                  <th>Author</th>
                  <th>Score</th>
                  <th>CI</th>
                  <th>Size</th>
                  <th>Reviews</th>
                  <th>Changes requested</th>
                  <th>Churn</th>
                  <th>Time to first review</th>
                  <th>Time to merge</th>
                </tr>
              </thead>
              <tbody>
                {prMetrics.map((pr) => (
                  <tr key={pr.number}>
                    <td>
                      <a href={pr.url} target="_blank" rel="noreferrer">
                        #{pr.number} {pr.title}
                      </a>
                    </td>
                    <td>{pr.author}</td>
                    <td>
                      <div className="score-cell">
                        <span className={`badge ${pr.score >= 85 ? "good" : pr.score >= 70 ? "warn" : "bad"}`}>
                          {pr.score.toFixed(1)}
                        </span>
                        <div className="score-tooltip">
                          <div className="tooltip-title">Score breakdown</div>
                          <div className="tooltip-subtitle">
                            Penalty shows how much each signal reduced the score.
                          </div>
                          <div className="tooltip-grid">
                            {pr.scoreBreakdown.map((component) => (
                              <div className="tooltip-row" key={component.key}>
                                <div className="tooltip-label">{component.label}</div>
                                <div className="tooltip-value">{component.display}</div>
                                <div className="tooltip-penalty">-{component.penalty.toFixed(1)}</div>
                                <div className="tooltip-weight">
                                  wt {Math.round(component.weight * 100)}%
                                </div>
                                {component.note ? (
                                  <div className="tooltip-note">{component.note}</div>
                                ) : null}
                              </div>
                            ))}
                          </div>
                          <div className="tooltip-footer">
                            Total score: {pr.score.toFixed(1)}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td>{pr.ciFailed ? "Failed" : "Clean"}</td>
                    <td>{pr.additions + pr.deletions} / {pr.filesChanged} files</td>
                    <td>{pr.reviewCount}</td>
                    <td>{pr.reviewRounds}</td>
                    <td>{formatPercent(pr.churnRatio)}</td>
                    <td>{formatHours(pr.timeToFirstReviewHours)}</td>
                    <td>{formatHours(pr.timeToMergeHours)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!prMetrics.length && (
              <div className="empty">Run analysis to populate the dashboard.</div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
};

export default App;
