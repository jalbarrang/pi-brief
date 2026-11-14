/**
 * Fixture materialization.
 *
 * A fixture is a directory with two parts:
 *   repo/     files committed as the clean baseline
 *   change/   optional files copied over afterwards and left uncommitted (or
 *             staged / committed — see `fixture.json`)
 * and two optional parts that never enter the repo:
 *   bin/       a scripted CLI stand-in, prepended to PATH
 *   responses/ what that stand-in prints, one file per command
 *
 * `bin/` stays out of the repo on purpose. A fixture that committed a fake
 * binary would look like a real checkout to the agent, and the baseline would
 * stop being a baseline. The real CLI must never run here: it would read and
 * write the operator's actual data. `run.ts` prepends the stub to PATH and
 * exports EVAL_STUB_DIR so the stub can find its responses without guessing its
 * own path.
 *
 * Each trial materializes a fresh temporary git repo, so runs never share
 * state. That matters more than it looks: a stale index or leftover file shows
 * up as model noise, and you cannot debug noise.
 */

import { execFile } from 'node:child_process';
import { existsSync, chmodSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, basename, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { FixtureMeta } from './types';

const exec = promisify(execFile);

/** `evals/skill` — the harness lives here. */
export const EVALS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
/** The pi-brief checkout. Two levels up from `evals/skill`. */
export const REPO_ROOT = dirname(dirname(EVALS_DIR));

export const DEFAULT_SUBJECT = 'brief';

/** Per-subject paths. A second subject only needs its own directory. */
export const subjectPaths = (subject: string) => {
  const dir = join(EVALS_DIR, subject);
  return {
    dir,
    evalsFile: join(dir, 'evals.json'),
    fixturesDir: join(dir, 'fixtures'),
    workspaceDir: join(dir, 'workspace'),
  };
};

const GIT_IDENTITY = ['-c', 'user.name=eval', '-c', 'user.email=eval@local'];

async function git(cwd: string, args: string[]): Promise<void> {
  await exec('git', [...GIT_IDENTITY, ...args], { cwd });
}

/** Recursively merge `src` into `dst`. Own implementation so directory-merge
 *  semantics do not depend on `fs.cp` version differences. */
async function copyTree(src: string, dst: string): Promise<void> {
  await mkdir(dst, { recursive: true });
  for (const entry of await readdir(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dst, entry.name);
    if (entry.isDirectory()) await copyTree(from, to);
    else if (entry.isFile()) await writeFile(to, await readFile(from));
  }
}

/** Every file under `root` as POSIX relative paths (git's spelling). */
async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(relative(root, full).split(sep).join('/'));
    }
  };
  await walk(root);
  return out.sort();
}

export type MaterializedFixture = {
  /** The repo root: where `.git` lives. */
  dir: string;
  /** Where the run starts: `dir`, or `dir/<meta.cwd>`. */
  cwd: string;
  /** Files the change/ overlay touches, empty for a plain baseline fixture. */
  changedFiles: string[];
  meta: FixtureMeta;
  /** Directory prepended to PATH, staged outside the checkout. */
  stubDir?: string;
  /** Root the stub reads `responses/` from, exported as EVAL_STUB_DIR. */
  stubRoot?: string;
  /** `fixtures/<name>`: what this run was built from. */
  sourceDir: string;
  /**
   * The extension copy inside the fixture, when the run asked for it.
   *
   * Loading the checkout's own extension by absolute path leaks the repository
   * to the agent: it reads the extension, walks up from there, finds
   * `evals.json`, and reads the answers to its own eval. Copying the extension
   * into the fixture keeps every path it can see inside the fixture.
   */
  extensionPath?: string;
};

export async function materializeFixture(
  subject: string,
  name: string,
  dir: string,
  options: { withExtension?: boolean; extensionSource?: string } = {},
): Promise<MaterializedFixture> {
  const src = join(subjectPaths(subject).fixturesDir, name);
  const meta = JSON.parse(await readFile(join(src, 'fixture.json'), 'utf8')) as FixtureMeta;

  // Deterministic paths mean a rerun lands on the previous trial's repo. Wipe
  // it: a stale `.git` makes the baseline commit fail with "nothing to commit".
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await copyTree(join(src, 'repo'), dir);

  // The extension goes into the baseline commit, so `git status` starts clean
  // and a run that edits it shows up as a change like any other. Only the config
  // that is supposed to have it gets it: a baseline that can find the extension
  // on disk is not a baseline.
  let extensionPath: string | undefined;
  if (options.withExtension) {
    if (!options.extensionSource) {
      throw new Error(`subject "${subject}" has no "extension" path in its evals.json`);
    }
    extensionPath = join(dir, '.eval', 'extensions', basename(options.extensionSource));
    await mkdir(dirname(extensionPath), { recursive: true });
    await writeFile(extensionPath, await readFile(options.extensionSource));
  }

  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-qm', 'base']);

  let changedFiles: string[] = [];
  try {
    changedFiles = await listFiles(join(src, 'change'));
  } catch {
    // No overlay: the fixture is the baseline and nothing else.
  }
  if (changedFiles.length > 0) {
    await copyTree(join(src, 'change'), dir);
    if (meta.staged || meta.commitChange) await git(dir, ['add', '--', ...changedFiles]);
    if (meta.commitChange) await git(dir, ['commit', '-qm', 'change']);
  }

  const sourceStubDir = resolveStubDir(subject, src);
  const staged = await stageStub(src, sourceStubDir, dirname(dir));
  return {
    dir,
    cwd: meta.cwd ? join(dir, meta.cwd) : dir,
    changedFiles,
    meta,
    stubDir: staged.bin,
    stubRoot: staged.root,
    sourceDir: src,
    extensionPath,
  };
}

/**
 * Copy the stub and its responses next to the fixture instead of pointing PATH
 * at the checkout.
 *
 * The child is denied reads inside this repository (that is where `evals.json`
 * lives), so a stub executed from there cannot even be read, let alone run.
 * Staging keeps the boundary intact without making the CLI unfindable.
 *
 * The responses move with it. They are the environment, not the answer key:
 * running the CLI reveals the same text, so exposing them costs nothing.
 * `evals.json` is the file that must stay unreachable.
 */
async function stageStub(
  src: string,
  stubDir: string | undefined,
  parent: string,
): Promise<{ bin?: string; root?: string }> {
  if (!stubDir) return {};
  const root = join(parent, 'stub');
  await rm(root, { recursive: true, force: true });
  const bin = join(root, 'bin');
  await copyTree(stubDir, bin);
  // copyTree writes files fresh, so the executable bit has to be restored.
  for (const entry of await readdir(bin)) chmodSync(join(bin, entry), 0o755);
  try {
    await copyTree(join(src, 'responses'), join(root, 'responses'));
  } catch {
    // A fixture with no responses is a fixture that expects no CLI call.
  }
  return { bin, root };
}

/**
 * A fixture may ship its own `bin/`, or share `fixtures/bin/`. The shared stub
 * is the common case: every fixture for a CLI-backed subject needs the same
 * scripted CLI and only the `responses/` differ.
 */
function resolveStubDir(subject: string, src: string): string | undefined {
  const own = join(src, 'bin');
  if (existsSync(own)) return own;
  const shared = join(subjectPaths(subject).fixturesDir, 'bin');
  return existsSync(shared) ? shared : undefined;
}
