export type RepoSummary = {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  isPrivate: boolean;
  updatedAt: string;
};

export type PullRequestSummary = {
  number: number;
  title: string;
  htmlUrl: string;
  userLogin: string;
  createdAt: string;
  mergedAt: string;
};

export type PullRequestDetails = {
  number: number;
  title: string;
  htmlUrl: string;
  userLogin: string;
  createdAt: string;
  mergedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
};

export type Review = {
  state: string;
  submittedAt: string | null;
  userLogin: string;
};

export type CommitSummary = {
  sha: string;
};

export type CommitStats = {
  additions: number;
  deletions: number;
  committedAt: string | null;
};

export type CheckRun = {
  conclusion: string | null;
};

export type StatusSummary = {
  state: string | null;
};

export type PRMetrics = {
  number: number;
  title: string;
  url: string;
  author: string;
  mergedAt: Date | null;
  additions: number;
  deletions: number;
  filesChanged: number;
  reviewRounds: number;
  churnRatio: number | null;
  timeToFirstReviewHours: number | null;
  timeToMergeHours: number | null;
  ciFailed: boolean;
  score: number;
};

export type WeeklyStat = {
  week: string;
  medianScore: number | null;
  p25Score: number | null;
  p75Score: number | null;
  pctBelowThreshold: number;
  ciFailRate: number;
  medianChurn: number | null;
  medianSize: number | null;
  medianReviewRounds: number | null;
};

export type DeltaEntry = {
  label: string;
  before: string | null;
  after: string | null;
  delta: string | null;
};
