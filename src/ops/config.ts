export type OpsRepoConfig = {
  fullName: string;
  aliases: string[];
};

export type OpsConfig = {
  linearApiKey?: string;
  linearTeamId?: string;
  linearProjectId?: string;
  linearLabelIds: string[];
  linearDefaultAssigneeId?: string;
  githubToken?: string;
  githubRepos: OpsRepoConfig[];
  githubLabels: string[];
  defaultGithubAssignees: string[];
  googleTasksAccessToken?: string;
  googleTasksListId: string;
  messengerSummaryRecipientId?: string;
  openAiApiKey?: string;
  anthropicApiKey?: string;
  claudeModel: string;
};

export function getOpsConfig(): OpsConfig {
  return {
    linearApiKey: process.env.LINEAR_API_KEY,
    linearTeamId: process.env.LINEAR_TEAM_ID,
    linearProjectId: process.env.LINEAR_PROJECT_ID,
    linearLabelIds: splitCsv(process.env.LINEAR_LABEL_IDS),
    linearDefaultAssigneeId: process.env.LINEAR_DEFAULT_ASSIGNEE_ID,
    githubToken: process.env.OPS_GITHUB_TOKEN || process.env.GITHUB_TOKEN,
    githubRepos: parseRepos(process.env.OPS_GITHUB_REPOS, process.env.OPS_REPO_ALIASES),
    githubLabels: splitCsv(process.env.OPS_GITHUB_LABELS || 'ops-task,from-messenger'),
    defaultGithubAssignees: splitCsv(process.env.OPS_GITHUB_DEFAULT_ASSIGNEES),
    googleTasksAccessToken: process.env.GOOGLE_TASKS_ACCESS_TOKEN,
    googleTasksListId: process.env.GOOGLE_TASKS_LIST_ID || '@default',
    messengerSummaryRecipientId: process.env.FB_OPS_SUMMARY_RECIPIENT_ID,
    openAiApiKey: process.env.OPENAI_API_KEY,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    claudeModel: process.env.CLAUDE_DAILY_MODEL || process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest',
  };
}

export function splitCsv(value: string | undefined) {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

function parseRepos(rawRepos: string | undefined, rawAliases: string | undefined): OpsRepoConfig[] {
  const repos = splitCsv(rawRepos).filter((repo) => /^[^/\s]+\/[^/\s]+$/.test(repo));
  const aliasMap = new Map<string, string[]>();
  for (const entry of splitCsv(rawAliases)) {
    const [alias, repo] = entry.split('=').map((part) => part.trim());
    if (!alias || !repo) continue;
    const aliases = aliasMap.get(repo) ?? [];
    aliases.push(alias.toLowerCase());
    aliasMap.set(repo, aliases);
  }
  return repos.map((fullName) => {
    const name = fullName.split('/')[1] ?? fullName;
    return {
      fullName,
      aliases: Array.from(new Set([fullName.toLowerCase(), name.toLowerCase(), ...(aliasMap.get(fullName) ?? [])])),
    };
  });
}
