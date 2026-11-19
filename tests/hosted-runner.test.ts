import { expect, test } from "bun:test";
import { join } from "node:path";

import { isList, record } from "../.github/actions/_lib/gate.ts";

const ROOT = join(import.meta.dir, "..");

/** Every job with steps in this repo's workflows, as `file: job`, with what it runs on and sets up. */
const JOBS = await (async () => {
  const files = await Array.fromAsync(new Bun.Glob(".github/workflows/*.yml").scan(ROOT));
  const jobs = await Promise.all(
    files.toSorted().map(async (file) => {
      const document = record(Bun.YAML.parse(await Bun.file(join(ROOT, file)).text()));
      return Object.entries(record(document["jobs"])).flatMap(([name, body]) => {
        const job = record(body);
        if (!isList(job["steps"])) return [];
        const steps = job["steps"].map((step) => record(step));
        const using = (action: string) =>
          steps.filter((step) => String(step["uses"]).startsWith(`${action}@`));
        return [
          {
            job: `${file}: ${name}`,
            runsOn: job["runs-on"],
            bun: using("oven-sh/setup-bun").length > 0,
            node: using("actions/setup-node").map((step) => record(step["with"])["node-version"]),
          },
        ];
      });
    }),
  );
  return jobs.flat();
})();

// The wrong implementations: a job left on the retired self-hosted labels, and
// one on `ubuntu-latest`, which GitHub moves to a new Ubuntu on its own
// schedule and with it the Postgres major and Node every gate is graded on.
test("every job with steps runs on ubuntu-24.04", () => {
  expect(JOBS.map(({ job }) => job)).toEqual([
    ".github/workflows/check.yml: static",
    ".github/workflows/check.yml: database",
    ".github/workflows/ci.yml: check",
    ".github/workflows/nightly-issue.yml: file",
  ]);
  expect(JOBS.filter(({ runsOn }) => runsOn !== "ubuntu-24.04")).toEqual([]);
});

// The wrong implementation: a job that sets up Bun and leaves node at the
// image's default 22, which cannot parse the `await using` a Playwright suite
// run under node loads, or at a floating `lts/*`.
test("every job that sets up Bun sets up Node 24 beside it", () => {
  const bun = JOBS.filter((job) => job.bun);
  expect(bun.length).toBeGreaterThan(0);
  expect(bun.filter(({ node }) => node.length !== 1 || node[0] !== 24)).toEqual([]);
});
