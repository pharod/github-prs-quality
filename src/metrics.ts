import type { DeltaEntry, PRMetrics, ScoreComponent, WeeklyStat } from "./types";

const clamp = (value: number, minValue: number, maxValue: number) =>
  Math.max(minValue, Math.min(maxValue, value));

const formatHours = (value: number | null): string => {
  if (value === null) return "-";
  if (value < 1) return `${Math.round(value * 60)}m`;
  return `${value.toFixed(1)}h`;
};

const formatPercent = (value: number | null): string => {
  if (value === null) return "-";
  return `${(value * 100).toFixed(1)}%`;
};

type ScoreInput = {
  additions: number;
  deletions: number;
  filesChanged: number;
  reviewRounds: number;
  churnRatio: number | null;
  timeToFirstReviewHours: number | null;
  timeToMergeHours: number | null;
  ciFailed: boolean;
};

export const scorePr = (metrics: ScoreInput): number => {
  const size = metrics.additions + metrics.deletions;
  const churn = metrics.churnRatio ?? 0;

  const sizeRisk = clamp(Math.log1p(size) / Math.log1p(2000), 0, 1);
  const filesRisk = clamp(metrics.filesChanged / 50, 0, 1);
  const reviewRoundsRisk = clamp(metrics.reviewRounds / 3, 0, 1);
  const churnRisk = clamp(churn / 0.5, 0, 1);

  const tfrRisk = metrics.timeToFirstReviewHours === null
    ? 0.5
    : clamp(metrics.timeToFirstReviewHours / 72, 0, 1);

  const ttmRisk = metrics.timeToMergeHours === null
    ? 0.5
    : clamp(metrics.timeToMergeHours / 240, 0, 1);

  const ciRisk = metrics.ciFailed ? 1 : 0;

  const weights = {
    size: 0.2,
    files: 0.1,
    reviewRounds: 0.2,
    churn: 0.15,
    tfr: 0.1,
    ttm: 0.15,
    ci: 0.1,
  };

  const risk =
    sizeRisk * weights.size +
    filesRisk * weights.files +
    reviewRoundsRisk * weights.reviewRounds +
    churnRisk * weights.churn +
    tfrRisk * weights.tfr +
    ttmRisk * weights.ttm +
    ciRisk * weights.ci;

  return clamp(100 * (1 - risk), 0, 100);
};

export const scorePrWithDetails = (metrics: ScoreInput): {
  score: number;
  components: ScoreComponent[];
} => {
  const size = metrics.additions + metrics.deletions;
  const churn = metrics.churnRatio ?? 0;
  const churnMissing = metrics.churnRatio === null;
  const tfrMissing = metrics.timeToFirstReviewHours === null;
  const ttmMissing = metrics.timeToMergeHours === null;

  const sizeRisk = clamp(Math.log1p(size) / Math.log1p(2000), 0, 1);
  const filesRisk = clamp(metrics.filesChanged / 50, 0, 1);
  const reviewRoundsRisk = clamp(metrics.reviewRounds / 3, 0, 1);
  const churnRisk = clamp(churn / 0.5, 0, 1);
  const tfrRisk = tfrMissing ? 0.5 : clamp(metrics.timeToFirstReviewHours! / 72, 0, 1);
  const ttmRisk = ttmMissing ? 0.5 : clamp(metrics.timeToMergeHours! / 240, 0, 1);
  const ciRisk = metrics.ciFailed ? 1 : 0;

  const weights = {
    size: 0.2,
    files: 0.1,
    reviewRounds: 0.2,
    churn: 0.15,
    tfr: 0.1,
    ttm: 0.15,
    ci: 0.1,
  };

  const components: ScoreComponent[] = [
    {
      key: "size",
      label: "PR size",
      display: `${size} lines`,
      weight: weights.size,
      risk: sizeRisk,
      penalty: sizeRisk * weights.size * 100,
    },
    {
      key: "files",
      label: "Files changed",
      display: `${metrics.filesChanged} files`,
      weight: weights.files,
      risk: filesRisk,
      penalty: filesRisk * weights.files * 100,
    },
    {
      key: "reviewRounds",
      label: "Changes requested",
      display: `${metrics.reviewRounds}`,
      weight: weights.reviewRounds,
      risk: reviewRoundsRisk,
      penalty: reviewRoundsRisk * weights.reviewRounds * 100,
    },
    {
      key: "churn",
      label: "Review churn",
      display: churnMissing ? "No commit stats" : formatPercent(metrics.churnRatio),
      weight: weights.churn,
      risk: churnRisk,
      penalty: churnRisk * weights.churn * 100,
      note: churnMissing ? "Defaulted to 0%" : undefined,
    },
    {
      key: "timeToFirstReview",
      label: "Time to first review",
      display: tfrMissing ? "No review timestamp" : formatHours(metrics.timeToFirstReviewHours),
      weight: weights.tfr,
      risk: tfrRisk,
      penalty: tfrRisk * weights.tfr * 100,
      note: tfrMissing ? "Defaulted to 50% risk" : undefined,
    },
    {
      key: "timeToMerge",
      label: "Time to merge",
      display: ttmMissing ? "Not merged" : formatHours(metrics.timeToMergeHours),
      weight: weights.ttm,
      risk: ttmRisk,
      penalty: ttmRisk * weights.ttm * 100,
      note: ttmMissing ? "Defaulted to 50% risk" : undefined,
    },
    {
      key: "ci",
      label: "CI stability",
      display: metrics.ciFailed ? "Failed at least once" : "Clean",
      weight: weights.ci,
      risk: ciRisk,
      penalty: ciRisk * weights.ci * 100,
    },
  ];

  const totalRisk = components.reduce(
    (sum, component) => sum + component.risk * component.weight,
    0
  );
  const score = clamp(100 * (1 - totalRisk), 0, 100);

  return { score, components };
};

export const safeMedian = (values: number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
};

export const percentile = (values: number[], pct: number): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const k = (sorted.length - 1) * (pct / 100);
  const f = Math.floor(k);
  const c = Math.ceil(k);
  if (f === c) return sorted[f];
  return sorted[f] * (c - k) + sorted[c] * (k - f);
};

export const isoWeekKey = (date: Date): string => {
  const utcDate = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNr = (utcDate.getUTCDay() + 6) % 7;
  utcDate.setUTCDate(utcDate.getUTCDate() - dayNr + 3);
  const firstThursday = new Date(Date.UTC(utcDate.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      (utcDate.getTime() - firstThursday.getTime()) / 604800000
    );
  return `${utcDate.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
};

export const buildWeeklyStats = (
  prs: PRMetrics[],
  scoreThreshold: number,
  since: Date
): WeeklyStat[] => {
  const buckets = new Map<string, PRMetrics[]>();
  prs.forEach((pr) => {
    if (!pr.mergedAt || pr.mergedAt < since) return;
    const key = isoWeekKey(pr.mergedAt);
    const current = buckets.get(key) ?? [];
    current.push(pr);
    buckets.set(key, current);
  });

  return Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, items]) => {
      const scores = items.map((pr) => pr.score);
      const churns = items
        .map((pr) => pr.churnRatio)
        .filter((value): value is number => value !== null);
      const sizes = items.map((pr) => pr.additions + pr.deletions);
      const rounds = items.map((pr) => pr.reviewRounds);
      const ciFailRate =
        items.filter((pr) => pr.ciFailed).length / items.length;
      const pctBelow =
        items.filter((pr) => pr.score < scoreThreshold).length / items.length;

      return {
        week,
        medianScore: safeMedian(scores),
        p25Score: percentile(scores, 25),
        p75Score: percentile(scores, 75),
        pctBelowThreshold: pctBelow,
        ciFailRate,
        medianChurn: safeMedian(churns),
        medianSize: safeMedian(sizes),
        medianReviewRounds: safeMedian(rounds),
      };
    });
};

const formatDelta = (
  before: number | null,
  after: number | null,
  formatter: (value: number) => string
): [string | null, string | null, string | null] => {
  if (before === null || after === null) return [null, null, null];
  const delta = after - before;
  return [formatter(before), formatter(after), formatter(delta)];
};

export const buildDeltas = (
  prs: PRMetrics[],
  adoptionDate: Date | null
): DeltaEntry[] => {
  if (!adoptionDate) {
    return [
      { label: "Median Score", before: null, after: null, delta: null },
      { label: "CI Fail Rate", before: null, after: null, delta: null },
      { label: "Median Churn", before: null, after: null, delta: null },
      { label: "Median Size", before: null, after: null, delta: null },
    ];
  }

  const before = prs.filter(
    (pr) => pr.mergedAt && pr.mergedAt < adoptionDate
  );
  const after = prs.filter(
    (pr) => pr.mergedAt && pr.mergedAt >= adoptionDate
  );

  const medianOf = (key: keyof PRMetrics, list: PRMetrics[]) => {
    const values = list
      .map((pr) => pr[key])
      .filter((value): value is number => typeof value === "number");
    return safeMedian(values);
  };

  const rateOf = (key: keyof PRMetrics, list: PRMetrics[]) => {
    if (!list.length) return null;
    return list.filter((pr) => Boolean(pr[key])).length / list.length;
  };

  const score = formatDelta(
    medianOf("score", before),
    medianOf("score", after),
    (value) => value.toFixed(1)
  );
  const ci = formatDelta(rateOf("ciFailed", before), rateOf("ciFailed", after),
    (value) => `${(value * 100).toFixed(1)}%`
  );
  const churn = formatDelta(
    medianOf("churnRatio", before),
    medianOf("churnRatio", after),
    (value) => `${(value * 100).toFixed(1)}%`
  );
  const medianSize = (list: PRMetrics[]) => {
    const sizes = list.map((pr) => pr.additions + pr.deletions);
    return safeMedian(sizes);
  };

  const size = formatDelta(
    medianSize(before),
    medianSize(after),
    (value) => value.toFixed(1)
  );

  return [
    { label: "Median Score", before: score[0], after: score[1], delta: score[2] },
    { label: "CI Fail Rate", before: ci[0], after: ci[1], delta: ci[2] },
    { label: "Median Churn", before: churn[0], after: churn[1], delta: churn[2] },
    { label: "Median Size", before: size[0], after: size[1], delta: size[2] },
  ];
};

export const computeChurnRatio = (
  commits: { additions: number; deletions: number; committedAt: string | null }[],
  firstReviewAt: Date | null
): number | null => {
  if (!commits.length) return null;
  const total = commits.reduce(
    (sum, commit) => sum + commit.additions + commit.deletions,
    0
  );
  if (total === 0) return 0;
  if (!firstReviewAt) return 0;
  const after = commits.reduce((sum, commit) => {
    if (!commit.committedAt) return sum;
    const commitTime = new Date(commit.committedAt);
    if (commitTime > firstReviewAt) {
      return sum + commit.additions + commit.deletions;
    }
    return sum;
  }, 0);
  return after / total;
};
