// File-backed stores: local-jira tasks, decision journals, knowledge base.
import fs from 'node:fs';
import { abs, exists, hhmm, listFiles, parseFrontmatter, readText, slugify, stringifyFrontmatter, writeText } from './util.ts';

// ---------- local-jira tasks ----------

export type TaskType = 'platform' | 'new-game' | 'feedback' | 'decision';
export type TaskStatus = 'new' | 'in-progress' | 'done' | 'stopped';

export interface TaskData {
  id: string;
  type: TaskType;
  pipeline: string;
  scope: string; // "platform" or a game id
  title: string;
  status: TaskStatus;
  phase: string; // next stage to run
  rounds: Record<string, number>;
  runs: string[];
  parent?: string;
  decision?: { id: string; value: string };
  review_pending?: string[];
  needs_human?: string[];
}

export interface Task {
  file: string;
  data: TaskData;
  body: string;
}

export const scopeDir = (scope: string): string => (scope === 'platform' ? 'platform' : `games/${scope}`);

export function listTasks(): Task[] {
  return listFiles('local-jira')
    .filter((f) => f.endsWith('.md') && !f.endsWith('README.md'))
    .map((f) => {
      const d = parseFrontmatter<TaskData>(readText(f));
      return { file: f, data: d.data, body: d.body };
    });
}

export function findTask(id: string): Task {
  const t = listTasks().find((x) => x.data.id === id);
  if (!t) throw new Error(`Задача ${id} не найдена в local-jira/`);
  return t;
}

export function nextTaskId(prefix: string): string {
  const nums = listTasks()
    .map((t) => t.data.id)
    .filter((id) => id.startsWith(`${prefix}-`))
    .map((id) => Number(id.split('-')[1]));
  const n = (nums.length ? Math.max(...nums) : 0) + 1;
  return `${prefix}-${String(n).padStart(3, '0')}`;
}

export function createTask(data: Omit<TaskData, 'id' | 'status' | 'rounds' | 'runs'>, description: string, links: string[]): Task {
  const prefix = data.type === 'platform' ? 'PLAT' : 'GAME';
  const id = nextTaskId(prefix);
  const file = `local-jira/${id}-${slugify(`${data.scope}-${data.type}`)}.md`;
  const full: TaskData = { id, status: 'new', rounds: {}, runs: [], ...data };
  const body = `# ${id}: ${data.title}\n\n## Описание\n\n${description.trim()}\n\n## Ссылки\n\n${links.map((l) => `- ${l}`).join('\n')}\n\n## Журнал\n\n`;
  writeText(file, stringifyFrontmatter({ data: full, body }));
  return { file, data: full, body };
}

export function saveTask(t: Task): void {
  writeText(t.file, stringifyFrontmatter({ data: t.data, body: t.body }));
}

export function journal(t: Task, line: string): void {
  t.body = `${t.body.trimEnd()}\n- ${hhmm()} ${line}\n`;
  saveTask(t);
}

export function taskLink(t: Task): string {
  return `[[${t.file.replace(/\.md$/, '')}|${t.data.id}]]`;
}

// ---------- decision journal ----------

export interface DecisionInput {
  question: string;
  assumption: string;
  rationale: string;
}

const decisionsFile = (scope: string): string => `decisions/${scope}.md`;

function ensureDecisions(scope: string): string {
  const f = decisionsFile(scope);
  if (!exists(f)) writeText(f, `# Журнал решений: ${scope}\n\nДопущения, которые пайплайн принял сам, и решения человека поверх них.\nФайл ведёт оркестратор; человек меняет решения командой \`/game-decide\`.\n`);
  return f;
}

export function decisionIds(scope: string): string[] {
  const f = decisionsFile(scope);
  if (!exists(f)) return [];
  return [...readText(f).matchAll(/^## (D-\d+)/gm)].map((m) => m[1]);
}

/** Appends decisions and returns their assigned ids. */
export function addDecisions(scope: string, items: DecisionInput[], source: { task: Task; stage: string; run: string; status?: string }): string[] {
  if (!items.length) return [];
  const f = ensureDecisions(scope);
  let text = readText(f);
  const ids = decisionIds(scope).map((id) => Number(id.slice(2)));
  let n = ids.length ? Math.max(...ids) : 0;
  const assigned: string[] = [];
  for (const d of items) {
    n++;
    const id = `D-${String(n).padStart(3, '0')}`;
    assigned.push(id);
    text += `\n## ${id} ${d.question}\n\n- Статус: ${source.status ?? 'допущение'}\n- Допущение: ${d.assumption}\n- Обоснование: ${d.rationale}\n- Источник: ${taskLink(source.task)} · этап ${source.stage} · [[runs/${source.run}/report|${source.run}]]\n`;
  }
  writeText(f, text);
  return assigned;
}

export function decisionSection(scope: string, id: string): string | null {
  const f = decisionsFile(scope);
  if (!exists(f)) return null;
  const m = readText(f).match(new RegExp(`^## ${id}[^\\n]*\\n[\\s\\S]*?(?=^## D-|$(?![\\s\\S]))`, 'm'));
  return m ? m[0] : null;
}

export function applyHumanDecision(scope: string, id: string, value: string, task: Task): void {
  const f = ensureDecisions(scope);
  const text = readText(f);
  const section = decisionSection(scope, id);
  if (!section) throw new Error(`Решение ${id} не найдено в ${f}`);
  const updated = section
    .replace(/^- Статус: .*$/m, '- Статус: изменено человеком')
    .trimEnd()
    .concat(`\n- Решение человека (${new Date().toISOString().slice(0, 16)}): ${value} — применяется задачей ${taskLink(task)}\n`);
  writeText(f, text.replace(section, `${updated}\n`));
}

// ---------- knowledge base ----------

export interface KbEntry {
  id: string;
  file: string;
  title: string;
  stages: string[];
  created_by_run: string;
  updated_by_runs: string[];
  body: string;
}

interface KbFront {
  id: string;
  title: string;
  stages: string[];
  created_by_run: string;
  updated_by_runs?: string[];
}

export function loadKb(): KbEntry[] {
  return listFiles('kb')
    .filter((f) => /KB-\d+/.test(f))
    .map((f) => {
      const d = parseFrontmatter<KbFront>(readText(f));
      return { ...d.data, updated_by_runs: d.data.updated_by_runs ?? [], file: f, body: d.body.trim() };
    });
}

export function kbForAgent(agent: string): KbEntry[] {
  return loadKb().filter((e) => e.stages.includes(agent) || e.stages.includes('all'));
}

export interface KbUpsert {
  id?: string;
  title: string;
  stages: string[];
  problem: string;
  cause: string;
  rule: string;
}

export function upsertKb(items: KbUpsert[], run: string): string[] {
  const existing = loadKb();
  let n = existing.length ? Math.max(...existing.map((e) => Number(e.id.slice(3)))) : 0;
  const touched: string[] = [];
  for (const it of items) {
    const prev = it.id ? existing.find((e) => e.id === it.id) : undefined;
    const body = `# ${it.title}\n\n**Проблема.** ${it.problem}\n\n**Причина.** ${it.cause}\n\n**Правило.** ${it.rule}\n`;
    if (prev) {
      const data: KbFront = { id: prev.id, title: it.title, stages: it.stages, created_by_run: prev.created_by_run, updated_by_runs: [...prev.updated_by_runs, run] };
      writeText(prev.file, stringifyFrontmatter({ data, body: `\n${body}` }));
      touched.push(prev.id);
    } else {
      n++;
      const id = `KB-${String(n).padStart(3, '0')}`;
      const data: KbFront = { id, title: it.title, stages: it.stages, created_by_run: run, updated_by_runs: [] };
      writeText(`kb/${id}-${slugify(it.title) || 'lesson'}.md`, stringifyFrontmatter({ data, body: `\n${body}` }));
      touched.push(id);
    }
  }
  return touched;
}

export function removeFile(p: string): void {
  fs.rmSync(abs(p), { force: true, recursive: true });
}
