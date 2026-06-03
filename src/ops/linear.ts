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

export type StagedIssue = {
  id: string;
  identifier: string;
  title: string;
  description: string;
  stateType?: string;
  attachments: Array<{ url: string; title?: string }>;
};

// Look up an issue by its identifier (e.g. TECX-26) within a team.
export async function getLinearIssueByIdentifier(apiKey: string, teamId: string, identifier: string): Promise<StagedIssue | null> {
  const num = Number(identifier.split('-').pop());
  if (!Number.isFinite(num)) return null;
  const response = await linearGraphql<{ issues?: { nodes?: Array<{ id: string; identifier: string; title: string; description?: string; state?: { type?: string }; attachments?: { nodes?: Array<{ url: string; title?: string }> } }> } }>(apiKey, `
    query Issue($teamId: ID!, $num: Float!) {
      issues(filter: { team: { id: { eq: $teamId } }, number: { eq: $num } }, first: 1) {
        nodes { id identifier title description state { type } attachments { nodes { url title } } }
      }
    }
  `, { teamId, num });
  const node = response.issues?.nodes?.[0];
  if (!node) return null;
  return { id: node.id, identifier: node.identifier, title: node.title, description: node.description ?? '', stateType: node.state?.type, attachments: node.attachments?.nodes ?? [] };
}

// Move an issue to the team's first workflow state of the given type.
export async function moveLinearIssueToType(apiKey: string, teamId: string, issueId: string, type: 'completed' | 'canceled'): Promise<void> {
  const states = await linearGraphql<{ workflowStates?: { nodes?: Array<{ id: string; type: string; team?: { id: string } }> } }>(apiKey, `
    query States { workflowStates(first: 250) { nodes { id type team { id } } } }
  `, {});
  const stateId = states.workflowStates?.nodes?.find((state) => state.team?.id === teamId && state.type === type)?.id;
  if (!stateId) throw new Error(`No ${type} workflow state found for team`);
  await linearGraphql(apiKey, `
    mutation Move($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }
  `, { id: issueId, stateId });
}

// Send an issue back for revision: append feedback to the description and move it
// to "Todo" so the agent re-drafts it (the tick re-processes Todo tasks).
export async function reviseLinearIssue(apiKey: string, teamId: string, issueId: string, description: string): Promise<void> {
  const states = await linearGraphql<{ workflowStates?: { nodes?: Array<{ id: string; name: string; team?: { id: string } }> } }>(apiKey, `
    query States { workflowStates(first: 250) { nodes { id name team { id } } } }
  `, {});
  const stateId = states.workflowStates?.nodes?.find((state) => state.team?.id === teamId && state.name === 'Todo')?.id;
  if (!stateId) throw new Error('No "Todo" workflow state found for team');
  await linearGraphql(apiKey, `
    mutation Revise($id: String!, $stateId: String!, $description: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId, description: $description }) { success }
    }
  `, { id: issueId, stateId, description });
}

export async function listLinearIssuesByStateName(apiKey: string, teamId: string, stateName: string): Promise<Array<{ identifier: string; title: string }>> {
  const response = await linearGraphql<{ issues?: { nodes?: Array<{ identifier: string; title: string }> } }>(apiKey, `
    query InState($teamId: ID!, $name: String!) {
      issues(filter: { team: { id: { eq: $teamId } }, state: { name: { eq: $name } } }, first: 50) {
        nodes { identifier title }
      }
    }
  `, { teamId, name: stateName });
  return response.issues?.nodes ?? [];
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
