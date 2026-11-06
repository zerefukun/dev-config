/**
 * What an upstream sync has to leave true of this fork, which upstream's own
 * suites cannot say: the package is zerefukun/dev-config, and check.yml's
 * action pins name one commit that holds every action they call.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { trackedFiles } from "../.github/actions/_lib/gate.ts";
import { git } from "./tree.ts";

const ROOT = join(import.meta.dir, "..");

const SELF = "tests/fork-identity.test.ts";

const UPSTREAM_OWNER = /gokayo43/i;

const NFP_STOREFRONT_PROBE =
  "the captured clone of a private repository under the old owner that the install action's rewrite was probed with";

const UPSTREAM_TRACKER = "an issue link into a tracker that lives under the old owner";

const DEV_CONFIG_DB = "dev-config-db, the MariaDB/MySQL extension, lives under the old owner";

/** Every line that may name the upstream owner, as file and trimmed text, with why it may. */
const ALLOWED: readonly { file: string; line: string; reason: string }[] = [
  {
    file: ".github/actions/repo-contract/ci-workflow.ts",
    line: "* gate and replaces the Postgres job with its own dialect's — `gokayo43/dev-config-db`",
    reason: DEV_CONFIG_DB,
  },
  {
    file: "README.md",
    line: "[dev-config#86](https://github.com/gokayo43/dev-config/issues/86) makes that a",
    reason: UPSTREAM_TRACKER,
  },
  {
    file: "README.md",
    line: '"https://git@github.com/gokayo43/nfp-elysia-storefront-types.git", …])',
    reason: NFP_STOREFRONT_PROBE,
  },
  {
    file: "default.json",
    line: '"matchPackageNames": ["zerefukun/dev-config", "gokayo43/dev-config-db"],',
    reason: DEV_CONFIG_DB,
  },
  {
    file: "docs/exports/characterization-net.md",
    line: "[project-template#30](https://github.com/gokayo43/project-template/issues/30) as",
    reason: UPSTREAM_TRACKER,
  },
  {
    file: "docs/exports/characterization-net.md",
    line: "[project-template#30](https://github.com/gokayo43/project-template/issues/30)",
    reason: UPSTREAM_TRACKER,
  },
  {
    file: "docs/gates/repo-contract.md",
    line: "`gokayo43/dev-config-db` — the MariaDB/MySQL extension — passes down when it",
    reason: DEV_CONFIG_DB,
  },
  {
    file: "docs/gates/repo-contract.md",
    line: "[project-template#30](https://github.com/gokayo43/project-template/issues/30)",
    reason: UPSTREAM_TRACKER,
  },
  {
    file: "tests/private-git-dependency.test.ts",
    line: '"https://git@github.com/gokayo43/nfp-elysia-storefront-types.git",',
    reason: NFP_STOREFRONT_PROBE,
  },
  {
    file: "tests/private-git-dependency.test.ts",
    line: '"https://github.com/gokayo43/nfp-elysia-storefront-types.git",',
    reason: NFP_STOREFRONT_PROBE,
  },
  {
    file: "tests/private-git-dependency.test.ts",
    line: '"ssh://git@github.com/gokayo43/nfp-elysia-storefront-types.git",',
    reason: NFP_STOREFRONT_PROBE,
  },
  {
    file: "tests/repo-contract-live.test.ts",
    line: "// that wrapper passes down. This is the tree gokayo43/dev-config#65 was filed",
    reason: UPSTREAM_TRACKER,
  },
  {
    file: "tests/repo-contract-live.test.ts",
    line: "`  check:\\n    uses: gokayo43/dev-config-db/.github/workflows/check.yml@${PIN}\\n    with:\\n      database: true\\n`,",
    reason: DEV_CONFIG_DB,
  },
];

const CHECK_YML = ".github/workflows/check.yml";

const ACTION_PIN = /zerefukun\/dev-config\/\.github\/actions\/([^@\s]+)@([0-9a-f]{40})/;

describe("this fork after an upstream sync", () => {
  // Kills a sync that leaves the upstream owner in code a consumer resolves: a
  // CI-call pattern, a package name or a pin still naming gokayo43.
  test("names the upstream owner only on the lines allowed to", async () => {
    const allowed = new Set(ALLOWED.map(({ file, line }) => `${file}\n${line}`));
    const found: string[] = [];
    for (const file of await trackedFiles(ROOT, [])) {
      if (file === SELF) continue;
      const lines = (await Bun.file(join(ROOT, file)).text()).split("\n");
      lines.forEach((text, index) => {
        if (UPSTREAM_OWNER.test(text) && !allowed.has(`${file}\n${text.trim()}`)) {
          found.push(`${file}:${index + 1}: ${text.trim()}`);
        }
      });
    }
    expect(found).toEqual([]);
  });

  // Kills a release that moves some of check.yml's action pins and leaves one
  // behind, or pins a commit that does not hold an action it calls.
  test("pins every action check.yml calls to one commit that holds them all", async () => {
    const pins = (await Bun.file(join(ROOT, CHECK_YML)).text()).split("\n").flatMap((line) => {
      const match = ACTION_PIN.exec(line);
      return match === null ? [] : [{ action: match[1] ?? "", sha: match[2] ?? "" }];
    });
    expect(pins.length).toBeGreaterThan(0);

    const shas = [...new Set(pins.map(({ sha }) => sha))];
    expect(shas).toHaveLength(1);

    const missing: string[] = [];
    for (const action of new Set(pins.map((pin) => pin.action))) {
      const listed = await git(ROOT, [
        "ls-tree",
        "--name-only",
        shas[0] ?? "",
        `.github/actions/${action}/`,
      ]);
      if (!listed.split("\n").some((path) => /\/action\.ya?ml$/.test(path))) missing.push(action);
    }
    expect(missing).toEqual([]);
  });
});
