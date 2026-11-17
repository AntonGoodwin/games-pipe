// PreToolUse hook: blocks file writes outside the stage's allowlist.
// Usage (from generated per-stage settings): node factory/hooks/guard.ts <policy.json>
// policy.json: { "root": "/abs/repo", "allow": ["games/coin/server/**"], "deny": ["games/*/tests/**"] }
// Exit code 2 blocks the tool call and shows stderr to the agent.
import fs from 'node:fs';
import path from 'node:path';
import { globToRegExp } from '../lib/util.ts';

interface Policy {
  root: string;
  allow: string[];
  deny: string[];
  stage: string;
}

const policy = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) as Policy;
const input = JSON.parse(fs.readFileSync(0, 'utf8')) as {
  tool_name: string;
  tool_input: Record<string, unknown>;
  cwd?: string;
};

const target = (input.tool_input.file_path ?? input.tool_input.notebook_path) as string | undefined;
if (!target) process.exit(0);

const absPath = path.resolve(input.cwd ?? policy.root, target);
const relPath = path.relative(policy.root, absPath).split(path.sep).join('/');
const match = (globs: string[]): boolean => globs.some((g) => globToRegExp(g).test(relPath));

const outside = relPath.startsWith('..');
if (outside || match(policy.deny) || !match(policy.allow)) {
  process.stderr.write(
    `BLOCKED by factory guard (stage "${policy.stage}"): writing "${relPath}" is not allowed on this stage. ` +
      `Writable paths: ${policy.allow.join(', ') || 'none'}. ` +
      `If the tests or the platform must change, do not try to edit them: report it in your structured result ` +
      `(developer: outcome "dispute").\n`,
  );
  process.exit(2);
}
process.exit(0);
