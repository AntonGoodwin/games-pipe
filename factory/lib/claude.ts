// Runs one AI stage as a headless Claude Code process (`claude -p`, same subscription as the desktop app).
// The agent works inside the stage; it never decides the next stage. The orchestrator reads
// `structured_output` (validated by --json-schema) and the usage numbers for metrics.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { ROOT, abs, writeText } from './util.ts';

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  numTurns: number;
  durationMs: number;
}

export interface AgentResult {
  ok: boolean;
  output: Record<string, unknown> | null;
  error: string | null;
  usage: AgentUsage;
}

export interface AgentCall {
  agent: string;
  prompt: string;
  schema: object;
  stageDir: string; // repo-relative
  allowWrite: string[];
  denyWrite: string[];
  readOnly: boolean;
  maxTurns: number;
  model?: string;
  onProgress?: (line: string) => void;
}

const BASE_TOOLS = ['Read', 'Glob', 'Grep', 'TodoWrite'];
const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit'];
const BASH_TOOLS = [
  'Bash(pnpm exec vitest *)',
  'Bash(pnpm vitest *)',
  'Bash(pnpm exec tsc *)',
  'Bash(pnpm typecheck)',
  'Bash(ls *)',
];

function emptyUsage(): AgentUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, numTurns: 0, durationMs: 0 };
}

export async function runAgent(call: AgentCall): Promise<AgentResult> {
  const stageAbs = abs(call.stageDir);
  fs.mkdirSync(stageAbs, { recursive: true });

  // Per-stage settings: a PreToolUse hook enforces the write allowlist technically.
  const policyPath = `${call.stageDir}/policy.json`;
  writeText(policyPath, JSON.stringify({ root: ROOT, stage: call.agent, allow: call.allowWrite, deny: call.denyWrite }, null, 2));
  const settingsPath = `${call.stageDir}/settings.json`;
  writeText(
    settingsPath,
    JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: 'Write|Edit|MultiEdit|NotebookEdit',
              hooks: [{ type: 'command', command: `node "${abs('factory/hooks/guard.ts')}" "${abs(policyPath)}"` }],
            },
          ],
        },
      },
      null,
      2,
    ),
  );
  writeText(`${call.stageDir}/prompt.md`, call.prompt);

  const tools = call.readOnly ? [...BASE_TOOLS] : [...BASE_TOOLS, ...WRITE_TOOLS, ...BASH_TOOLS];
  const args = [
    '-p',
    '--agent', call.agent,
    '--output-format', 'stream-json',
    '--verbose',
    '--settings', abs(settingsPath),
    '--permission-mode', 'dontAsk',
    '--permission-prompts', 'none',
    '--max-turns', String(call.maxTurns),
    '--json-schema', JSON.stringify(call.schema),
    '--disallowedTools', 'Agent', 'Task', 'WebFetch', 'WebSearch',
    '--allowedTools', ...tools,
  ];
  if (call.model) args.push('--model', call.model);

  const transcript = fs.createWriteStream(`${stageAbs}/transcript.jsonl`);
  const started = Date.now();

  return await new Promise<AgentResult>((resolve) => {
    const child = spawn('claude', args, { cwd: ROOT, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    let stderr = '';
    let resultLine: Record<string, unknown> | null = null;

    child.stdout.on('data', (chunk: Buffer) => {
      transcript.write(chunk);
      buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (msg.type === 'result') resultLine = msg;
          else if (msg.type === 'assistant' && call.onProgress) {
            const content = ((msg.message as { content?: unknown[] })?.content ?? []) as Array<Record<string, unknown>>;
            for (const c of content) {
              if (c.type === 'tool_use') {
                const input = (c.input ?? {}) as Record<string, unknown>;
                const hint = (input.file_path ?? input.command ?? input.pattern ?? '') as string;
                call.onProgress(`${c.name as string} ${String(hint).slice(0, 120)}`);
              }
            }
          }
        } catch {
          // non-JSON noise is kept in the transcript only
        }
      }
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.on('close', (code) => {
      transcript.end();
      const usage = emptyUsage();
      usage.durationMs = Date.now() - started;
      const r = resultLine;
      if (!r) {
        resolve({ ok: false, output: null, error: `claude exited with code ${code} and no result. stderr: ${stderr.slice(-2000)}`, usage });
        return;
      }
      const u = (r.usage ?? {}) as Record<string, number>;
      usage.inputTokens = u.input_tokens ?? 0;
      usage.outputTokens = u.output_tokens ?? 0;
      usage.cacheReadTokens = u.cache_read_input_tokens ?? 0;
      usage.cacheWriteTokens = u.cache_creation_input_tokens ?? 0;
      usage.costUsd = (r.total_cost_usd as number) ?? 0;
      usage.numTurns = (r.num_turns as number) ?? 0;
      usage.durationMs = (r.duration_ms as number) ?? usage.durationMs;
      const output = (r.structured_output ?? null) as Record<string, unknown> | null;
      writeText(`${call.stageDir}/result.json`, JSON.stringify({ subtype: r.subtype, is_error: r.is_error, output, usage }, null, 2));
      if (r.is_error || !output) {
        resolve({ ok: false, output, error: `agent finished with "${r.subtype as string}"${output ? '' : ' and no structured output'}`, usage });
        return;
      }
      resolve({ ok: true, output, error: null, usage });
    });
    child.stdin.end(call.prompt);
  });
}
