import type { TenantConfig } from '../core/types.js';
import { getOpsConfig, type OpsConfig, type OpsRepoConfig, splitCsv } from './config.js';
import { createGitHubIssue, listOpenGitHubIssues, type GitHubIssue } from './github.js';
import { createGoogleTask, listGoogleTasks, type GoogleTask } from './googleTasks.js';
import { createLinearIssue, listOpenLinearIssues, type LinearIssue } from './linear.js';
import { directoryPromptContext, enrichTaskOwner, loadTeamDirectory, type TeamMember } from './teamDirectory.js';

export type OpsIntakeMessage = {
  platform: 'facebook' | 'line' | 'web';
  conversationId: string;
  senderId?: string;
  text: string;
  timestamp?: number;
};

export type OpsTaskDraft = {
  title: string;
  body?: string;
  owner?: string;
  dueDate?: string;
  priority?: 'high' | 'medium' | 'low';
  repositories: string[];
  githubAssignees: string[];
  linearAssigneeId?: string;
};

export type OpsIntakeResult = {
  handled: boolean;
  reply: string;
  tasks: Array<OpsTaskDraft & {
    linearIssue?: { id?: string; identifier?: string; url?: string; error?: string };
    githubIssues: Array<{ repo: string; url?: string; error?: string }>;
    googleTask?: { id?: string; error?: string };
  }>;
};

export async function handleOpsTaggedMessage(input: OpsIntakeMessage, tenant: TenantConfig): Promise<OpsIntakeResult> {
  const config = getOpsConfig();
  const tagged = isOpsBotTagged(input.text, tenant.botMentionNames);
  if (!tagged && process.env.OPS_ALLOW_UNTAGGED_MESSENGER !== 'true') {
    return { handled: false, reply: '', tasks: [] };
  }

  const cleanText = stripOpsBotMentions(input.text, tenant.botMentionNames).trim();
  if (!cleanText) return { handled: true, reply: opsUsageReply(config), tasks: [] };
  const directory = loadTeamDirectory();
  const draft = (await extractOpsTasks({ text: cleanText, tenant, config, source: input, directory })).map((task) => {
    const enriched = enrichTaskOwner({ text: cleanText, owner: task.owner, githubAssignees: task.githubAssignees, linearAssigneeId: task.linearAssigneeId }, directory);
    return { ...task, owner: enriched.owner, githubAssignees: enriched.githubAssignees, linearAssigneeId: enriched.linearAssigneeId };
  });
  if (draft.length === 0) return { handled: true, reply: 'I did not find a clear task. Tag me with the owner, repo, expected outcome, and due date.', tasks: [] };

  const processed = [];
  for (const task of draft) {
    const repos = resolveTaskRepos(task.repositories, cleanText, config.githubRepos);
    let linearIssue: { id?: string; identifier?: string; url?: string; error?: string } | undefined;
    if (config.linearApiKey && config.linearTeamId) {
      try {
        const issue = await createLinearIssue(config.linearApiKey, {
          teamId: config.linearTeamId,
          title: task.title,
          description: buildLinearDescription(task, input, repos),
          assigneeId: task.linearAssigneeId || config.linearDefaultAssigneeId,
          projectId: config.linearProjectId,
          labelIds: config.linearLabelIds,
          dueDate: task.dueDate,
          priority: task.priority,
        });
        linearIssue = { id: issue.id, identifier: issue.identifier, url: issue.url };
      } catch (error) {
        linearIssue = { error: formatError(error) };
      }
    } else {
      linearIssue = { error: 'LINEAR_API_KEY and LINEAR_TEAM_ID are required for canonical task creation' };
    }

    const githubIssues = [];
    for (const repo of repos) {
      if (!config.githubToken) {
        githubIssues.push({ repo, error: 'OPS_GITHUB_TOKEN is not configured' });
        continue;
      }
      try {
        const issue = await createGitHubIssue(config.githubToken, {
          repo,
          title: task.title,
          body: buildIssueBody(task, input, linearIssue),
          labels: config.githubLabels,
          assignees: task.githubAssignees.length ? task.githubAssignees : config.defaultGithubAssignees,
        });
        githubIssues.push({ repo, url: issue.htmlUrl });
      } catch (error) {
        githubIssues.push({ repo, error: formatError(error) });
      }
    }

    let googleTask: { id?: string; error?: string } | undefined;
    if (config.googleTasksAccessToken) {
      try {
        const created = await createGoogleTask(config.googleTasksAccessToken, config.googleTasksListId, {
          title: task.title,
          dueDate: task.dueDate,
          notes: buildGoogleTaskNotes(task, input, githubIssues, linearIssue),
        });
        googleTask = { id: created.id };
      } catch (error) {
        googleTask = { error: formatError(error) };
      }
    } else {
      googleTask = { error: 'GOOGLE_TASKS_ACCESS_TOKEN is not configured' };
    }

    processed.push({ ...task, repositories: repos, linearIssue, githubIssues, googleTask });
  }

  return { handled: true, reply: formatOpsIntakeReply(processed), tasks: processed };
}

export async function buildDailyOpsReport(): Promise<{ text: string; linearIssues: LinearIssue[]; githubIssues: GitHubIssue[]; googleTasks: GoogleTask[] }> {
  const config = getOpsConfig();
  const linearIssues: LinearIssue[] = [];
  const githubIssues: GitHubIssue[] = [];
  const googleTasks: GoogleTask[] = [];
  if (config.linearApiKey) {
    linearIssues.push(...await listOpenLinearIssues(config.linearApiKey, config.linearTeamId));
  }
  if (config.githubToken) {
    for (const repo of config.githubRepos) {
      githubIssues.push(...await listOpenGitHubIssues(config.githubToken, repo.fullName));
    }
  }
  if (config.googleTasksAccessToken) {
    googleTasks.push(...await listGoogleTasks(config.googleTasksAccessToken, config.googleTasksListId));
  }
  const text = config.anthropicApiKey
    ? await summarizeDailyOpsWithClaude(config, linearIssues, githubIssues, googleTasks)
    : deterministicDailyOpsSummary(linearIssues, githubIssues, googleTasks, config);
  return { text, linearIssues, githubIssues, googleTasks };
}

async function extractOpsTasks(input: { text: string; tenant: TenantConfig; config: OpsConfig; source: OpsIntakeMessage; directory: TeamMember[] }): Promise<OpsTaskDraft[]> {
  if (input.config.openAiApiKey) {
    try {
      return await extractOpsTasksWithOpenAi(input);
    } catch (error) {
      console.warn('[ops-intake] OpenAI task extraction failed, using deterministic fallback:', error);
    }
  }
  return [fallbackTaskDraft(input.text, input.config)].filter((task): task is OpsTaskDraft => Boolean(task));
}

async function extractOpsTasksWithOpenAi(input: { text: string; tenant: TenantConfig; config: OpsConfig; source: OpsIntakeMessage; directory: TeamMember[] }): Promise<OpsTaskDraft[]> {
  const repoNames = input.config.githubRepos.map((repo) => `${repo.fullName} aliases=${repo.aliases.join('|')}`).join('\n') || '(none configured)';
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.config.openAiApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OPENAI_OPS_MODEL || process.env.OPENAI_SUMMARY_MODEL || 'gpt-4o-mini',
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You extract engineering ops tasks from Messenger messages for ${input.tenant.name}.

Return JSON only:
{"tasks":[{"title":"...","body":"...","owner":"...","dueDate":"YYYY-MM-DD","priority":"high|medium|low","repositories":["owner/repo"],"githubAssignees":["github-login"],"linearAssigneeId":"..."}]}

Rules:
- Create tasks only for concrete work requests.
- Preserve technical detail, acceptance criteria, blockers, links, and repo names in body.
- repositories must use only configured repos when a match is clear. If no repo is clear, leave repositories empty and the system will use configured defaults.
- githubAssignees are GitHub logins only when clearly stated with @login or configured by the requester text.
- linearAssigneeId must use the team directory's linearUserId only when the owner match is clear.
- dueDate must be YYYY-MM-DD only when explicit.
- Do not invent owners, assignees, dates, or repos.

Configured repos:
${repoNames}

Team directory:
${directoryPromptContext(input.directory)}`,
        },
        { role: 'user', content: input.text },
      ],
    }),
  });
  if (!response.ok) throw new Error(`OpenAI ops extraction failed: ${response.status} ${await response.text()}`);
  const data = await response.json() as { choices?: Array<{ message?: { content?: string | null } }> };
  const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}') as { tasks?: Partial<OpsTaskDraft>[] };
  return (parsed.tasks ?? [])
    .filter((task): task is Partial<OpsTaskDraft> & { title: string } => typeof task.title === 'string' && task.title.trim().length > 0)
    .slice(0, 5)
    .map((task) => ({
      title: task.title.trim().slice(0, 180),
      body: typeof task.body === 'string' ? task.body.trim() : undefined,
      owner: typeof task.owner === 'string' ? task.owner.trim() : undefined,
      dueDate: typeof task.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(task.dueDate) ? task.dueDate : undefined,
      priority: task.priority === 'high' || task.priority === 'low' ? task.priority : 'medium',
      repositories: Array.isArray(task.repositories) ? task.repositories.filter((repo): repo is string => typeof repo === 'string') : [],
      githubAssignees: Array.isArray(task.githubAssignees) ? task.githubAssignees.filter((login): login is string => typeof login === 'string').map((login) => login.replace(/^@/, '')) : [],
      linearAssigneeId: typeof task.linearAssigneeId === 'string' ? task.linearAssigneeId.trim() : undefined,
    }));
}

function fallbackTaskDraft(text: string, config: OpsConfig): OpsTaskDraft | undefined {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return undefined;
  const assignees = Array.from(cleaned.matchAll(/@([a-z\d](?:[a-z\d-]{0,37}[a-z\d])?)/gi)).map((match) => match[1]);
  const dueMatch = cleaned.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  const repos = config.githubRepos.filter((repo) => repo.aliases.some((alias) => cleaned.toLowerCase().includes(alias))).map((repo) => repo.fullName);
  return {
    title: cleaned.slice(0, 140),
    body: cleaned,
    dueDate: dueMatch?.[1],
    priority: /\b(urgent|asap|high|緊急|重要)\b/i.test(cleaned) ? 'high' : 'medium',
    repositories: repos,
    githubAssignees: assignees,
  };
}

function resolveTaskRepos(taskRepos: string[], sourceText: string, configuredRepos: OpsRepoConfig[]) {
  const configured = new Set(configuredRepos.map((repo) => repo.fullName));
  const explicit = taskRepos.filter((repo) => configured.has(repo));
  if (explicit.length) return explicit;
  const lowered = sourceText.toLowerCase();
  const matched = configuredRepos.filter((repo) => repo.aliases.some((alias) => lowered.includes(alias))).map((repo) => repo.fullName);
  if (matched.length) return matched;
  return configuredRepos.map((repo) => repo.fullName);
}

function buildLinearDescription(task: OpsTaskDraft, input: OpsIntakeMessage, repos: string[]) {
  const lines = [
    '## Task',
    task.body || task.title,
    '',
    '## Ops metadata',
    `- Source: ${input.platform}`,
    `- Conversation: ${input.conversationId}`,
    input.senderId ? `- Requester id: ${input.senderId}` : undefined,
    task.owner ? `- Owner: ${task.owner}` : undefined,
    task.dueDate ? `- Due date: ${task.dueDate}` : undefined,
    `- Priority: ${task.priority ?? 'medium'}`,
    repos.length ? `- Repositories: ${repos.join(', ')}` : undefined,
    '',
    '## Completion rule',
    'Post proof of completion before closing: PR link, commit, screenshot, document link, or clear written result.',
    '',
    '## Original message',
    input.text,
  ];
  return lines.filter((line): line is string => typeof line === 'string').join('\n');
}

function buildIssueBody(task: OpsTaskDraft, input: OpsIntakeMessage, linearIssue: { identifier?: string; url?: string; error?: string } | undefined) {
  const linearLine = linearIssue?.url
    ? `- Linear: ${linearIssue.identifier ?? 'issue'} ${linearIssue.url}`
    : linearIssue?.error ? `- Linear: ${linearIssue.error}` : undefined;
  return [
    linearLine,
    '',
    buildLinearDescription(task, input, []),
  ].filter((line): line is string => typeof line === 'string').join('\n');
}

function buildGoogleTaskNotes(task: OpsTaskDraft, input: OpsIntakeMessage, githubIssues: Array<{ repo: string; url?: string; error?: string }>, linearIssue: { identifier?: string; url?: string; error?: string } | undefined) {
  const links = githubIssues.map((issue) => issue.url ? `${issue.repo}: ${issue.url}` : `${issue.repo}: ${issue.error}`).join('\n');
  return [
    task.body || input.text,
    '',
    linearIssue?.url ? `Linear: ${linearIssue.identifier ?? ''} ${linearIssue.url}`.trim() : undefined,
    linearIssue?.error ? `Linear: ${linearIssue.error}` : undefined,
    task.owner ? `Owner: ${task.owner}` : undefined,
    task.priority ? `Priority: ${task.priority}` : undefined,
    links ? `GitHub:\n${links}` : undefined,
  ].filter((line): line is string => typeof line === 'string').join('\n');
}

async function summarizeDailyOpsWithClaude(config: OpsConfig, linearIssues: LinearIssue[], githubIssues: GitHubIssue[], googleTasks: GoogleTask[]) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': config.anthropicApiKey!,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.claudeModel,
      max_tokens: 1200,
      temperature: 0.1,
      system: 'You are the daily operating reviewer for an agentic company. Be concise, concrete, and evidence-based.',
      messages: [{
        role: 'user',
        content: `Review open Linear issues, GitHub issues, and Google Tasks. Treat Linear as the canonical task system. Explain what is being worked on, what is slowing down, and what needs owner attention today.

Linear issues:
${JSON.stringify(linearIssues, null, 2)}

GitHub issues:
${JSON.stringify(githubIssues, null, 2)}

Google Tasks:
${JSON.stringify(googleTasks, null, 2)}`,
      }],
    }),
  });
  if (!response.ok) throw new Error(`Claude daily report failed: ${response.status} ${await response.text()}`);
  const data = await response.json() as { content?: Array<{ type: string; text?: string }> };
  return data.content?.map((part) => part.text).filter(Boolean).join('\n\n').trim() || deterministicDailyOpsSummary(linearIssues, githubIssues, googleTasks, config);
}

function deterministicDailyOpsSummary(linearIssues: LinearIssue[], githubIssues: GitHubIssue[], googleTasks: GoogleTask[], config: OpsConfig) {
  const byRepo = config.githubRepos.map((repo) => {
    const issues = githubIssues.filter((issue) => issue.repo === repo.fullName);
    return `- ${repo.fullName}: ${issues.length} open issues`;
  });
  const stale = githubIssues.filter((issue) => issue.updatedAt && Date.now() - Date.parse(issue.updatedAt) > 1000 * 60 * 60 * 24 * 7);
  return [
    'Daily ops report',
    '',
    'Work in progress',
    `- Linear open issues: ${linearIssues.length}`,
    byRepo.length ? byRepo.join('\n') : '- No GitHub repos configured or readable.',
    `- Google Tasks open: ${googleTasks.length}`,
    '',
    'Likely slowdowns',
    stale.length ? stale.slice(0, 8).map((issue) => `- ${issue.repo}#${issue.number}: ${issue.title} (last update ${issue.updatedAt})`).join('\n') : '- No stale GitHub issues detected from available data.',
    '',
    'Owner attention',
    linearIssues.filter((issue) => !issue.assignee).slice(0, 8).map((issue) => `- Unassigned Linear: ${issue.identifier} ${issue.title}`).join('\n') ||
    githubIssues.filter((issue) => issue.assignees.length === 0).slice(0, 8).map((issue) => `- Unassigned: ${issue.repo}#${issue.number} ${issue.title}`).join('\n') || '- No unassigned GitHub issues in the fetched set.',
  ].join('\n');
}

function formatOpsIntakeReply(tasks: OpsIntakeResult['tasks']) {
  const lines = ['Created ops work:'];
  for (const task of tasks) {
    lines.push(`- ${task.title}`);
    if (task.linearIssue) lines.push(task.linearIssue.url ? `  Linear: ${task.linearIssue.identifier ?? ''} ${task.linearIssue.url}`.trim() : `  Linear: ${task.linearIssue.error}`);
    for (const issue of task.githubIssues) lines.push(issue.url ? `  GitHub ${issue.repo}: ${issue.url}` : `  GitHub ${issue.repo}: ${issue.error}`);
    if (task.googleTask) lines.push(task.googleTask.id ? `  Google Task: ${task.googleTask.id}` : `  Google Task: ${task.googleTask.error}`);
  }
  return lines.join('\n').slice(0, 1800);
}

function opsUsageReply(config: OpsConfig) {
  const repos = config.githubRepos.map((repo) => repo.fullName).join(', ') || 'no repos configured';
  return `Tag me with a task, owner, repo, and due date.\n\nExample: @tecxbot ask @engineer to fix onboarding error in app by 2026-06-01.\n\nLinear team: ${config.linearTeamId || 'not configured'}\nConfigured repos: ${repos}`;
}

function isOpsBotTagged(text: string, names: string[]) {
  return mentionPattern(names).test(text);
}

function stripOpsBotMentions(text: string, names: string[]) {
  return text.replace(mentionPattern(names), ' ');
}

function mentionPattern(names: string[]) {
  const allNames = [...names, ...splitCsv(process.env.FB_BOT_MENTION_NAMES || 'tecxbot,tecxmate')];
  return new RegExp(`@?(${Array.from(new Set(allNames)).map(escapeRegExp).join('|')})`, 'ig');
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
