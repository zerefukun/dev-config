import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MINIMUM_RELEASE_AGE } from "../.github/actions/repo-contract/repo-contract.ts";
import { record } from "../.github/actions/_lib/gate.ts";

const ROOT = join(import.meta.dir, "..");

/** The validator starts a whole Renovate; a few seconds a run, measured. */
const SLOW = 60_000;

/** The lockfile's renovate, by path, so the run never fetches one. */
async function validate(preset: string): Promise<{ status: number; output: string }> {
  // Both flags are load-bearing; README's "Gating this repo" says why.
  const proc = Bun.spawn(
    [
      join(ROOT, "node_modules", ".bin", "renovate-config-validator"),
      "--strict",
      "--no-global",
      preset,
    ],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { status, output: stdout + stderr };
}

test(
  "the preset holds against the Renovate the lockfile pins",
  async () => {
    const { status, output } = await validate("default.json");
    expect(output).toContain("Config validated successfully");
    expect(status).toBe(0);
  },
  SLOW,
);

// Renovate compiles a config's regexes with RE2, and falls back to JavaScript's
// RegExp without a word when the re2 addon is not installed. RegExp accepts a
// lookahead RE2 cannot compile, so a preset Renovate itself refuses would
// validate clean. This case fails, with the preset accepted, on any install
// where re2 did not build.
test(
  "a regex RE2 cannot compile is refused, so the validator runs with RE2",
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), "renovate-preset-"));
    try {
      const preset = join(scratch, "lookahead.json");
      await Bun.write(
        preset,
        JSON.stringify({
          $schema: "https://docs.renovatebot.com/renovate-schema.json",
          packageRules: [{ matchPackageNames: ["/^foo(?=bar)/"], enabled: false }],
        }),
      );
      const { status, output } = await validate(preset);
      expect(output).toContain("Invalid regExp for packageRules[0].matchPackageNames");
      expect(status).toBe(1);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
  SLOW,
);

const PRESET = record(await Bun.file(new URL("../default.json", import.meta.url)).json());

const BUNFIG = record(
  Bun.TOML.parse(await Bun.file(new URL("../bunfig.toml", import.meta.url)).text()),
);

/** The preset's window in seconds, from the `<n> days` Renovate reads. */
function presetWindow(): number {
  const written = String(PRESET["minimumReleaseAge"]);
  const days = /^(\d+) days?$/.exec(written)?.[1];
  if (days === undefined) throw new Error(`default.json's minimumReleaseAge is ${written}`);
  return Number(days) * 86_400;
}

// A Renovate PR holding a version younger than a consumer's own bunfig window
// fails that consumer's `bun install`. The repo contract's floor is the least a
// consumer may declare, so a preset below it fails every consumer that
// declares the floor, this repo first, since it extends the preset too. Whether
// it fails a consumer declaring more is the slowest-bunfig rule in README's
// Version policy, and that consumer's bunfig is outside this suite. The wrong
// implementation is a preset moved below the bunfigs it serves.
test("the preset waits no less than any bunfig it serves", () => {
  expect(presetWindow()).toBeGreaterThanOrEqual(MINIMUM_RELEASE_AGE);
  expect(presetWindow()).toBeGreaterThanOrEqual(
    Number(record(BUNFIG["install"])["minimumReleaseAge"]),
  );
});
