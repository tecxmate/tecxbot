export type LinearIssueInput = {
  teamId: string;
  title: string;
  description: string;
  assigneeId?: string;
  projectId?: string;
  labelIds?: string[];
  dueDate?: string;
  priority?: 'high' | 'medium' | 'low';
};

export type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state?: string;
  assignee?: string;
  team?: string;
  updatedAt?: string;
  dueDate?: string;
  priority?: number;
};

export async function createLinearIssue(apiKey: string, input: LinearIssueInput): Promise<LinearIssue> {
  const response = await linearGraphql<{
    issueCreate?: {
      success: boolean;
      issue?: LinearIssueResponse;
    };
  }>(apiKey, `
    mutation CreateIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue {
          id
          identifier
          title
          url
          updatedAt
          dueDate
          priority
          state { name }
          assignee { name }
          team { name }
        }
      }
    }
  `, {
    input: removeUndefined({
      teamId: input.teamId,
      title: input.title,
      description: input.description,
      assigneeId: input.assigneeId,
      projectId: input.projectId,
      labelIds: input.labelIds?.length ? input.labelIds : undefined,
      dueDate: input.dueDate,
      priority: linearPriority(input.priority),
    }),
  });
  const issue = response.issueCreate?.issue;
  if (!response.issueCreate?.success || !issue) throw new Error('Linear issue creation failed without returning an issue');
  return normalizeLinearIssue(issue);
}

export async function listOpenLinearIssues(apiKey: string, teamId?: string): Promise<LinearIssue[]> {
  const response = await linearGraphql<{
    issues?: {
      nodes?: LinearIssueResponse[];
    };
  }>(apiKey, `
    query OpenIssues($filter: IssueFilter, $first: Int!) {
      issues(filter: $filter, first: $first, orderBy: updatedAt) {
        nodes {
          id
          identifier
          title
          url
          updatedAt
          dueDate
          priority
          state { name type }
          assignee { name }
          team { name }
        }
      }
    }
  `, {
    first: 100,
    filter: removeUndefined({
      team: teamId ? { id: { eq: teamId } } : undefined,
      state: { type: { nin: ['completed', 'canceled'] } },
    }),
  });
  return (response.issues?.nodes ?? []).map(normalizeLinearIssue);
}

async function linearGraphql<T>(apiKey: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await response.json() as { data?: T; errors?: Array<{ message?: string }> };
  if (!response.ok || data.errors?.length) {
    const message = data.errors?.map((error) => error.message).filter(Boolean).join('; ') || await response.text();
    throw new Error(`Linear GraphQL failed: ${response.status} ${message}`);
  }
  if (!data.data) throw new Error('Linear GraphQL returned no data');
  return data.data;
}

function linearPriority(priority: LinearIssueInput['priority']) {
  if (priority === 'high') return 2;
  if (priority === 'medium') return 3;
  if (priority === 'low') return 4;
  return undefined;
}

function normalizeLinearIssue(issue: LinearIssueResponse): LinearIssue {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    state: issue.state?.name,
    assignee: issue.assignee?.name,
    team: issue.team?.name,
    updatedAt: issue.updatedAt,
    dueDate: issue.dueDate,
    priority: issue.priority,
  };
}

function removeUndefined<T extends Record<string, unknown>>(input: T) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

type LinearIssueResponse = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  updatedAt?: string;
  dueDate?: string;
  priority?: number;
  state?: { name?: string; type?: string };
  assignee?: { name?: string };
  team?: { name?: string };
};
