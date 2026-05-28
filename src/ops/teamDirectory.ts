import { readFileSync } from 'node:fs';

export type TeamMember = {
  taskOwner: string;
  fullName?: string;
  position?: string;
  githubLogin?: string;
  linearUserId?: string;
  aliases: string[];
  channel?: string;
  recipientId?: string;
  active: boolean;
};

export function loadTeamDirectory(filePath = process.env.OPS_TEAM_DIRECTORY_FILE || process.env.TASK_CONTACTS_SOURCE_FILE): TeamMember[] {
  if (!filePath) return [];
  try {
    const rows = parseCsv(readFileSync(filePath, 'utf8'));
    const [header, ...records] = rows;
    if (!header) return [];
    const columns = header.map((name) => name.trim());
    return records.map((record) => rowToMember(columns, record)).filter((member): member is TeamMember => Boolean(member));
  } catch (error) {
    console.warn('[ops-team-directory] Failed to load team directory:', error);
    return [];
  }
}

export function enrichTaskOwner(input: { text: string; owner?: string; githubAssignees: string[]; linearAssigneeId?: string }, directory: TeamMember[]) {
  const member = matchTeamMember(input.text, input.owner, input.githubAssignees, directory);
  if (!member) return input;
  return {
    text: input.text,
    owner: input.owner || member.taskOwner,
    linearAssigneeId: input.linearAssigneeId || member.linearUserId,
    githubAssignees: member.githubLogin && !input.githubAssignees.includes(member.githubLogin)
      ? [...input.githubAssignees, member.githubLogin]
      : input.githubAssignees,
  };
}

export function directoryPromptContext(directory: TeamMember[]) {
  if (!directory.length) return '(no team directory configured)';
  return directory.map((member) => {
    const fields = [
      `task_owner=${member.taskOwner}`,
      member.fullName ? `name=${member.fullName}` : undefined,
      member.position ? `position=${member.position}` : undefined,
      member.githubLogin ? `github=@${member.githubLogin}` : undefined,
      member.linearUserId ? `linearUserId=${member.linearUserId}` : undefined,
      member.aliases.length ? `aliases=${member.aliases.join('|')}` : undefined,
    ];
    return fields.filter(Boolean).join(', ');
  }).join('\n');
}

function matchTeamMember(text: string, owner: string | undefined, githubAssignees: string[], directory: TeamMember[]) {
  const lowered = text.toLowerCase();
  const ownerLowered = owner?.toLowerCase();
  const assignees = new Set(githubAssignees.map((login) => login.toLowerCase().replace(/^@/, '')));
  return directory.find((member) => {
    if (!member.active) return false;
    if (member.githubLogin && assignees.has(member.githubLogin.toLowerCase())) return true;
    if (ownerLowered && [member.taskOwner, member.fullName, ...member.aliases].filter(Boolean).some((value) => value!.toLowerCase() === ownerLowered)) return true;
    return [member.taskOwner, member.fullName, member.position, ...member.aliases]
      .filter((value): value is string => Boolean(value))
      .some((value) => lowered.includes(value.toLowerCase()));
  });
}

function rowToMember(columns: string[], record: string[]): TeamMember | undefined {
  const get = (...names: string[]) => {
    for (const name of names) {
      const index = columns.findIndex((column) => normalizeColumn(column) === normalizeColumn(name));
      if (index >= 0) return record[index]?.trim();
    }
    return undefined;
  };
  const taskOwner = get('task_owner', 'owner', 'slug');
  if (!taskOwner) return undefined;
  const githubLogin = get('github_login', 'github', 'github_assignee')?.replace(/^@/, '');
  const linearUserId = get('linear_user_id', 'linear_assignee_id', 'linear_id');
  const fullName = get('full_name', 'name');
  const position = get('position', 'role', 'title');
  return {
    taskOwner,
    fullName,
    position,
    githubLogin,
    linearUserId,
    aliases: splitAliases(get('aliases', 'alias', 'messenger_name')).concat([fullName, githubLogin].filter((item): item is string => Boolean(item))),
    channel: get('channel'),
    recipientId: get('recipient_id', 'messenger_id', 'line_user_id'),
    active: !/^no|false|0$/i.test(get('active') || 'yes'),
  };
}

function splitAliases(value: string | undefined) {
  return (value ?? '').split(/[|;,]/).map((item) => item.trim()).filter(Boolean);
}

function normalizeColumn(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseCsv(input: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1];
    if (quoted && char === '"' && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && char === ',') {
      row.push(cell);
      cell = '';
    } else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && next === '\n') i += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}
