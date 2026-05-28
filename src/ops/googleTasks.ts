export type GoogleTaskInput = {
  title: string;
  notes?: string;
  dueDate?: string;
};

export type GoogleTask = {
  id: string;
  title: string;
  status?: string;
  due?: string;
  updated?: string;
  selfLink?: string;
};

export async function createGoogleTask(accessToken: string, taskListId: string, input: GoogleTaskInput): Promise<GoogleTask> {
  const body: Record<string, string> = { title: input.title };
  if (input.notes) body.notes = input.notes;
  if (input.dueDate) body.due = toGoogleDueDate(input.dueDate);
  const response = await fetch(`https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(taskListId)}/tasks`, {
    method: 'POST',
    headers: googleHeaders(accessToken),
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Google Task creation failed: ${response.status} ${await response.text()}`);
  return normalizeTask(await response.json() as GoogleTaskResponse);
}

export async function listGoogleTasks(accessToken: string, taskListId: string): Promise<GoogleTask[]> {
  const url = new URL(`https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(taskListId)}/tasks`);
  url.searchParams.set('showCompleted', 'false');
  url.searchParams.set('maxResults', '100');
  const response = await fetch(url, { headers: googleHeaders(accessToken) });
  if (!response.ok) throw new Error(`Google Task listing failed: ${response.status} ${await response.text()}`);
  const data = await response.json() as { items?: GoogleTaskResponse[] };
  return (data.items ?? []).map(normalizeTask);
}

function googleHeaders(accessToken: string) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };
}

function toGoogleDueDate(value: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00.000Z`;
  return value;
}

function normalizeTask(task: GoogleTaskResponse): GoogleTask {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    due: task.due,
    updated: task.updated,
    selfLink: task.selfLink,
  };
}

type GoogleTaskResponse = {
  id: string;
  title: string;
  status?: string;
  due?: string;
  updated?: string;
  selfLink?: string;
};
