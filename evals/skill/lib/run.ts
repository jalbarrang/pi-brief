/**
 * Spawn one headless pi run and capture its JSONL transcript.
 *
 * Isolation settings matter more than they look:
 *   --no-extensions  discovered extensions do not get to make an eval pass or fail
 *   --extension <path>  load exactly the subject's extension, by absolute path
 *   --no-mcp         no MCP servers connect
 *   --offline        no startup network calls (less latency, less noise)
 *   --no-approve     do not trust project-local `.pi` in the fixture
 *   --no-context-files  no AGENTS.md/CLAUDE.md, so the operator's own global
 *                    instructions do not steer the case. This is the one real
 *                    fidelity cost: a subject that depends on AGENTS.md has to
 *                    restate the rule in its extension or not measure it.
 *   --no-skills      no discovered skills. An explicit `--extension` still
 *                    loads, so the baseline has nothing and the delta is the
 *                    extension under test.
 *   --session-dir    keep the session file for debugging
 *
 * The fixture's `bin/` goes first on PATH, so any stubbed CLI resolves to the
 * scripted stand-in. That is a safety boundary as much as a determinism one: a
 * real CLI would read and write the operator's actual data root.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

export type PiRun = {
  status: 'ok' | 'crashed' | 'timeout';
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  command: string;
};

export type PiCommandArgs = {
  /** Absolute path to the extension file, or undefined to omit it. */
  extensionPath?: string;
  /** Pin the model for a comparable benchmark. */
  model?: string;
  sessionDir: string;
  prompt: string;
};

export function buildPiCommand(args: PiCommandArgs): string[] {
  return [
    '--mode',
    'json',
    '--offline',
    '--no-extensions',
    '--no-mcp',
    '--no-approve',
    '--no-context-files',
    '--no-skills',
    '--session-dir',
    args.sessionDir,
    ...(args.extensionPath ? ['--extension', args.extensionPath] : []),
    ...(args.model ? ['--model', args.model] : []),
    args.prompt,
  ];
}

const KILL_GRACE_MS = 5_000;

/**
 * macOS TCC guards these three folders. A baseline agent hunting for a tool can
 * run `find / -maxdepth 4`, which enumerates them and makes macOS show the user
 * a "blocked access" prompt. The sandbox denies first, so the child gets EPERM
 * and the user gets no notification.
 *
 * Narrow on purpose: `allow default` keeps `/tmp` and `~/.pi` working, which is
 * everything a run needs.
 */
const PROTECTED_HOME_DIRS = ['Downloads', 'Desktop', 'Documents'] as const;

function sandboxProfile(denyPaths: string[]): string | null {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) return null;
  const denied = [
    ...PROTECTED_HOME_DIRS.map((name) => join(homedir(), name)),
    ...denyPaths,
  ]
    .map((path) => `(subpath "${path}")`)
    .join(' ');
  return `(version 1)(allow default)(deny file-read* file-write* ${denied})`;
}

export type RunEnv = {
  /** Fixture `bin/`, prepended to PATH so a stubbed CLI resolves to the script. */
  stubDir?: string;
  /** `fixtures/<name>`, where the stub reads its responses. */
  stubRoot?: string;
  /**
   * Paths the child may not read or write, on top of the macOS TCC folders.
   *
   * This is the eval's integrity boundary, not a nicety: without it the agent
   * can walk from the extension to the repository, read `evals.json`, and answer
   * the case from its own assertion list. A denied path is also the difference
   * between a baseline and a baseline that quietly found the answer.
   */
  denyPaths?: string[];
};

export function runPi(
  command: string[],
  cwd: string,
  timeoutMs: number,
  extra: RunEnv = {},
): Promise<PiRun> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    // A deny on an ancestor of cwd would break the run itself.
    const denyPaths = (extra.denyPaths ?? []).filter((path) => !cwd.startsWith(path));
    const profile = sandboxProfile(denyPaths);
    const full = profile ? ['/usr/bin/sandbox-exec', '-p', profile, 'pi', ...command] : ['pi', ...command];

    const env: Record<string, string | undefined> = { ...process.env, PI_OFFLINE: '1' };
    if (extra.stubDir) {
      env.PATH = [extra.stubDir, process.env.PATH ?? ''].filter(Boolean).join(delimiter);
    }
    if (extra.stubRoot) env.EVAL_STUB_DIR = extra.stubRoot;

    const child = spawn(full[0], full.slice(1), {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref();
    }, timeoutMs);
    timer.unref();

    child.on('error', (cause) => {
      clearTimeout(timer);
      resolve({
        status: 'crashed',
        exitCode: null,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr: `${stderr}\nspawn failed: ${cause.message}`,
        command: shellQuote(full),
      });
    });

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      const status = timedOut ? 'timeout' : exitCode === 0 ? 'ok' : 'crashed';
      resolve({
        status,
        exitCode,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
        command: shellQuote(full),
      });
    });
  });
}

export function shellQuote(args: string[]): string {
  return args
    .map((arg) => (/^[A-Za-z0-9_./:=@-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`))
    .join(' ');
}
