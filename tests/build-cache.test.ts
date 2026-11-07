/**
 * The build action: its script, run for real against a fixture checkout, for
 * what it hands actions/cache and what it refuses; and its steps, read off the
 * shipped action.yml, for the order the cache and the build run in. The cache
 * itself is GitHub's, behind actions/cache, and is not stood in for here.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { type ConfigObject, isList, record } from "../.github/actions/_lib/gate.ts";
import { scratch } from "./tree.ts";

const ACTION = join(import.meta.dir, "..", ".github", "actions", "build");

const CACHED = ".next/cache";

const LOCK = "lockfile one\n";

interface Run {
  readonly exitCode: number;
  readonly output: string;
  /** The step outputs the script wrote, by name. */
  readonly outputs: ReadonlyMap<string, string>;
}

/** Reads a GITHUB_OUTPUT file: `name=value` lines and `name<<end` blocks. */
function outputsIn(text: string): Map<string, string> {
  const outputs = new Map<string, string>();
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const block = /^([^=<]+)<<(.+)$/.exec(line);
    if (block) {
      const end = lines.indexOf(block[2] ?? "", index + 1);
      outputs.set(block[1] ?? "", lines.slice(index + 1, end).join("\n"));
      index = end;
    } else if (line.includes("=")) {
      outputs.set(line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1));
    }
  }
  return outputs;
}

async function paths(cache: string, lockfile: string | null = LOCK): Promise<Run> {
  const root = await scratch();
  if (lockfile !== null) await Bun.write(join(root, "bun.lock"), lockfile);
  const output = join(root, "github-output");
  await Bun.write(output, "");
  const proc = Bun.spawn(["bash", join(ACTION, "cache-paths.sh")], {
    cwd: root,
    env: { ...process.env, BUILD_CACHE: cache, GITHUB_OUTPUT: output },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    exitCode,
    output: stdout + stderr,
    outputs: outputsIn(await Bun.file(output).text()),
  };
}

/** The prefix the contract names: the first 16 hex digits of bun.lock's sha256. */
function prefixOf(lockfile: string): string {
  return `build-cache-${new Bun.CryptoHasher("sha256").update(lockfile).digest("hex").slice(0, 16)}-`;
}

describe("what the script hands actions/cache", () => {
  // Wrong implementations: a key derived from anything but the lockfile, such
  // as the workspace's path or the source, which throws away every hit; and a
  // restore key that is not a prefix of the key a save takes, which never
  // finds one.
  test("the key starts with the lockfile's prefix, and the restore key is the prefix", async () => {
    const run = await paths(CACHED);

    expect(run.exitCode).toBe(0);
    expect(run.outputs.get("restore-key")).toBe(prefixOf(LOCK));
    expect(run.outputs.get("key")).toStartWith(prefixOf(LOCK));
  });

  // Wrong implementations: a key fixed by the lockfile alone, and a suffix
  // every save of a run shares, such as the run's id. GitHub never overwrites
  // an entry, so the first save under such a key would be the cache forever,
  // and every save after it, the database job's beside the static job's
  // included, would warn that the key is taken.
  test("two saves under one lockfile take two keys", async () => {
    const [first, second] = await Promise.all([paths(CACHED), paths(CACHED)]);

    expect(first.outputs.get("key")).not.toBe(second.outputs.get("key"));
  });

  // Wrong implementation: a line taken as the path it spells, whitespace,
  // `./` and trailing slash all, which a YAML block keeps and nobody sees.
  test("each path is handed once per line, in its normal spelling", async () => {
    const run = await paths(`\n  ./${CACHED}/  \n\n.turbo//cache\n`);

    expect(run.outputs.get("paths")).toBe(`${CACHED}\n.turbo/cache`);
  });
});

describe("what runs without a cache", () => {
  // Wrong implementations: a cache asked for, or a lockfile demanded, for a
  // caller that named nothing to cache, which is every caller before this
  // input; and the one blank line an empty input arrives as, read as a path.
  test.each([
    ["with a lockfile", LOCK],
    ["without a lockfile", null],
  ])("an empty input %s writes no paths", async (_, lockfile) => {
    const run = await paths("", lockfile);

    expect(run.exitCode).toBe(0);
    expect([...run.outputs.keys()]).toEqual([]);
  });
});

describe("what the caller's own input refuses", () => {
  // Wrong implementation: a path checked by nothing, so the cache archives a
  // directory outside the repository, the whole checkout, or one tree twice.
  test.each([
    ["a path climbing out", "../outside", LOCK],
    ["a path climbing out midway", ".next/../../outside", LOCK],
    ["an absolute path", "/etc", LOCK],
    ["the repository root", ".", LOCK],
    ["the repository root with a slash", "./", LOCK],
    ["the repository root spelled twice", "././", LOCK],
    ["the repository root with an empty segment", ".//", LOCK],
    ["a path named twice", `${CACHED}\n${CACHED}`, LOCK],
    ["a path named twice in two spellings", `./${CACHED}\n${CACHED}/`, LOCK],
    ["a path inside one named before it", `.next\n${CACHED}`, LOCK],
    ["a path inside one named after it", `${CACHED}\n.next`, LOCK],
    ["no lockfile to key on", CACHED, null],
  ])("%s is refused before the build runs", async (_, cache, lockfile) => {
    const run = await paths(cache, lockfile);

    expect(run.exitCode).toBe(1);
    expect(run.output).toContain("::error::");
    expect([...run.outputs.keys()]).toEqual([]);
  });
});

const STEPS = await (async () => {
  const document = record(Bun.YAML.parse(await Bun.file(join(ACTION, "action.yml")).text()));
  const listed = record(document["runs"])["steps"];
  return (isList(listed) ? listed : []).map((step) => record(step));
})();

function stepAt(match: (step: ConfigObject) => boolean): number {
  return STEPS.findIndex(match);
}

const RESTORE = stepAt((step) => String(step["uses"]).startsWith("actions/cache/restore@"));
const BUILD = stepAt((step) => step["run"] === "bun run build");
const SAVE = stepAt((step) => String(step["uses"]).startsWith("actions/cache/save@"));

const WHEN_PATHS = "steps.cache.outputs.paths != ''";

describe("the order the action runs in", () => {
  // Wrong implementations: a restore after the build, which builds cold every
  // run; a save before it, which files nothing; and a save under always(),
  // which files a broken build's output for the next run to restore.
  test("restore, then the build, then a save that a failed build never reaches", () => {
    expect([RESTORE, BUILD, SAVE].every((index) => index >= 0)).toBe(true);
    expect(RESTORE).toBeLessThan(BUILD);
    expect(BUILD).toBeLessThan(SAVE);
    expect(STEPS[SAVE]?.["if"]).toBe(WHEN_PATHS);
  });

  // Wrong implementations: the cache asked for with no paths, which
  // actions/cache refuses as a missing input and fails every caller that named
  // none; and a save under a key other than the one the restore was asked
  // with, which no later restore's prefix finds.
  test("the cache is asked for only when the script wrote paths, with what it wrote", () => {
    expect(STEPS[RESTORE]?.["if"]).toBe(WHEN_PATHS);
    expect(record(STEPS[RESTORE]?.["with"])).toEqual({
      path: "${{ steps.cache.outputs.paths }}",
      key: "${{ steps.cache.outputs.key }}",
      "restore-keys": "${{ steps.cache.outputs.restore-key }}",
    });
    expect(record(STEPS[SAVE]?.["with"])).toEqual({
      path: "${{ steps.cache.outputs.paths }}",
      key: "${{ steps.cache.outputs.key }}",
    });
  });
});
