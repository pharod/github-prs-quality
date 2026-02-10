import { cachedFetch } from "./cache";
import type {
  CommitStats,
  CommitSummary,
  PullRequestDetails,
  PullRequestSummary,
  RepoSummary,
  Review,
} from "./types";

const API_BASE = "/api";

const TTL = {
  repos: 6 * 60 * 60 * 1000,
  prs: 2 * 60 * 60 * 1000,
  reviews: 2 * 60 * 60 * 1000,
  commits: 2 * 60 * 60 * 1000,
  commitDetails: 12 * 60 * 60 * 1000,
  checks: 2 * 60 * 60 * 1000,
};

const parseLinkHeader = (link: string | null): string | null => {
  if (!link) return null;
  const parts = link.split(",");
  for (const part of parts) {
    if (part.includes('rel="next"')) {
      const match = part.match(/<([^>]+)>/);
      if (!match) return null;
      return match[1].replace("https://api.github.com", API_BASE);
    }
  }
  return null;
};

const ghFetch = async <T>(url: string, token: string, ttlMs: number): Promise<T> => {
  return cachedFetch(url, async () => {
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(`GitHub API error ${response.status}: ${message}`);
    }

    return (await response.json()) as T;
  }, ttlMs);
};

const ghFetchRaw = async (url: string, token: string, ttlMs: number) => {
  return cachedFetch(url, async () => {
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(`GitHub API error ${response.status}: ${message}`);
    }

    return {
      data: await response.json(),
      link: response.headers.get("Link"),
    };
  }, ttlMs);
};

export const fetchViewer = async (token: string) => {
  return ghFetch<{ login: string }>(`${API_BASE}/user`, token, TTL.repos);
};

export const fetchRepos = async (token: string): Promise<RepoSummary[]> => {
  const userRepos = await fetchAllPages<any>(
    `${API_BASE}/user/repos?per_page=100&sort=updated`,
    token,
    TTL.repos
  );
  const orgs = await fetchAllPages<any>(
    `${API_BASE}/user/orgs?per_page=100`,
    token,
    TTL.repos
  );

  const orgRepos = await Promise.all(
    orgs.map((org: any) =>
      fetchAllPages<any>(
        `${API_BASE}/orgs/${org.login}/repos?per_page=100&sort=updated`,
        token,
        TTL.repos
      )
    )
  );

  const repos = [...userRepos, ...orgRepos.flat()];
  const repoMap = new Map<string, RepoSummary>();
  repos.forEach((repo: any) => {
    const summary = {
      id: repo.id,
      name: repo.name,
      fullName: repo.full_name,
      owner: repo.owner?.login ?? "",
      isPrivate: Boolean(repo.private),
      updatedAt: repo.updated_at,
    } satisfies RepoSummary;
    repoMap.set(summary.fullName, summary);
  });

  return Array.from(repoMap.values());
};

export const fetchMergedPRs = async (
  token: string,
  repoFullName: string,
  maxPrs: number
): Promise<PullRequestSummary[]> => {
  let url = `${API_BASE}/repos/${repoFullName}/pulls?state=closed&per_page=100&sort=updated&direction=desc`;
  const results: PullRequestSummary[] = [];

  while (url && results.length < maxPrs) {
    const { data, link } = await ghFetchRaw(url, token, TTL.prs);
    const prs = (data as any[]).filter((pr) => pr.merged_at);
    for (const pr of prs) {
      if (results.length >= maxPrs) break;
      results.push({
        number: pr.number,
        title: pr.title,
        htmlUrl: pr.html_url,
        userLogin: pr.user?.login ?? "unknown",
        createdAt: pr.created_at,
        mergedAt: pr.merged_at,
      });
    }
    url = parseLinkHeader(link);
  }

  return results;
};

export const fetchPrDetails = async (
  token: string,
  repoFullName: string,
  prNumber: number
): Promise<PullRequestDetails> => {
  const pr = await ghFetch<any>(
    `${API_BASE}/repos/${repoFullName}/pulls/${prNumber}`,
    token,
    TTL.prs
  );

  return {
    number: pr.number,
    title: pr.title,
    htmlUrl: pr.html_url,
    userLogin: pr.user?.login ?? "unknown",
    createdAt: pr.created_at,
    mergedAt: pr.merged_at,
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    changedFiles: pr.changed_files ?? 0,
  };
};

export const fetchReviews = async (
  token: string,
  repoFullName: string,
  prNumber: number
): Promise<Review[]> => {
  const reviews = await fetchAllPages<any>(
    `${API_BASE}/repos/${repoFullName}/pulls/${prNumber}/reviews?per_page=100`,
    token,
    TTL.reviews
  );

  return reviews.map((review: any) => ({
    state: review.state,
    submittedAt: review.submitted_at ?? null,
    userLogin: review.user?.login ?? "",
  }));
};

export const fetchCommits = async (
  token: string,
  repoFullName: string,
  prNumber: number
): Promise<CommitSummary[]> => {
  const commits = await fetchAllPages<any>(
    `${API_BASE}/repos/${repoFullName}/pulls/${prNumber}/commits?per_page=100`,
    token,
    TTL.commits
  );

  return commits.map((commit: any) => ({
    sha: commit.sha,
  }));
};

export const fetchCommitStats = async (
  token: string,
  repoFullName: string,
  sha: string
): Promise<CommitStats> => {
  const commit = await ghFetch<any>(
    `${API_BASE}/repos/${repoFullName}/commits/${sha}`,
    token,
    TTL.commitDetails
  );
  return {
    additions: commit.stats?.additions ?? 0,
    deletions: commit.stats?.deletions ?? 0,
    committedAt: commit.commit?.committer?.date ?? null,
    authorLogin: commit.author?.login ?? null,
    authorName: commit.commit?.author?.name ?? null,
  };
};

export const fetchCheckRuns = async (
  token: string,
  repoFullName: string,
  sha: string
): Promise<{ conclusion: string | null }[]> => {
  try {
    const runs = await ghFetch<any>(
      `${API_BASE}/repos/${repoFullName}/commits/${sha}/check-runs`,
      token,
      TTL.checks
    );
    return (runs.check_runs ?? []).map((run: any) => ({
      conclusion: run.conclusion ?? null,
    }));
  } catch (error) {
    return [];
  }
};

export const fetchStatuses = async (
  token: string,
  repoFullName: string,
  sha: string
): Promise<{ state: string | null }> => {
  try {
    const status = await ghFetch<any>(
      `${API_BASE}/repos/${repoFullName}/commits/${sha}/status`,
      token,
      TTL.checks
    );
    return { state: status.state ?? null };
  } catch (error) {
    return { state: null };
  }
};

const fetchAllPages = async <T>(
  url: string,
  token: string,
  ttlMs: number
): Promise<T[]> => {
  let nextUrl: string | null = url;
  const results: T[] = [];

  while (nextUrl) {
    const { data, link } = await ghFetchRaw(nextUrl, token, ttlMs);
    results.push(...(data as T[]));
    nextUrl = parseLinkHeader(link);
  }

  return results;
};
