export type GitHubIssueInput = {
  repo: string;
  title: string;
  body: string;
  labels: string[];
  assignees: string[];
};

export type GitHubIssue = {
  number: number;
  title: string;
  htmlUrl: string;
  repo: string;
  assignees: string[];
  labels: string[];
  updatedAt?: string;
};

export async function createGitHubIssue(token: string, input: GitHubIssueInput): Promise<GitHubIssue> {
  const response = await fetch(`https://api.github.com/repos/${input.repo}/issues`, {
    method: 'POST',
    headers: githubHeaders(token),
    body: JSON.stringify({
      title: input.title,
      body: input.body,
      labels: input.labels,
      assignees: input.assignees,
    }),
  });
  if (!response.ok) throw new Error(`GitHub issue creation failed for ${input.repo}: ${response.status} ${await response.text()}`);
  const data = await response.json() as GitHubIssueResponse;
  return normalizeIssue(input.repo, data);
}

export async function listOpenGitHubIssues(token: string, repo: string): Promise<GitHubIssue[]> {
  const url = new URL(`https://api.github.com/repos/${repo}/issues`);
  url.searchParams.set('state', 'open');
  url.searchParams.set('per_page', '50');
  url.searchParams.set('sort', 'updated');
  url.searchParams.set('direction', 'desc');
  const response = await fetch(url, { headers: githubHeaders(token) });
  if (!response.ok) throw new Error(`GitHub issue listing failed for ${repo}: ${response.status} ${await response.text()}`);
  const data = await response.json() as GitHubIssueResponse[];
  return data.filter((issue) => !issue.pull_request).map((issue) => normalizeIssue(repo, issue));
}

function githubHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'tecxbot-ops-agent',
  };
}

function normalizeIssue(repo: string, issue: GitHubIssueResponse): GitHubIssue {
  return {
    repo,
    number: issue.number,
    title: issue.title,
    htmlUrl: issue.html_url,
    assignees: issue.assignees?.map((assignee) => assignee.login).filter(Boolean) ?? [],
    labels: issue.labels?.map((label) => typeof label === 'string' ? label : label.name).filter((label): label is string => Boolean(label)) ?? [],
    updatedAt: issue.updated_at,
  };
}

type GitHubIssueResponse = {
  number: number;
  title: string;
  html_url: string;
  updated_at?: string;
  pull_request?: unknown;
  assignees?: Array<{ login: string }>;
  labels?: Array<string | { name?: string }>;
};
