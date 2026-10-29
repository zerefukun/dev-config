import { describe, expect, test } from "bun:test";

import { containersIn } from "../.github/actions/lint-workflows/containers.ts";
import { workflowGate } from "../.github/actions/lint-workflows/pins.ts";
import { containing } from "./matchers.ts";
import { materialise } from "./tree.ts";

const COMMIT = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const DIGEST = "sha256:20edbde7749f822887a1a022ad526fde0a47d6b2be9a8364433605cf65099416";

async function refusals(files: Record<string, string>): Promise<string[]> {
  const root = await materialise({ ".gitignore": "node_modules\n", ...files });
  return (await workflowGate(root, [])).map(({ file, message }) => `${file ?? ""}: ${message}`);
}

// The wrong implementations: a rule that reads `services` alone and lets a
// job's `container` through; one that reads only one of the two `container`
// spellings; one that misses a docker:// step or a Docker action, which need
// the same runtime; one that lets a digest-pinned image through, as the rule
// this replaced did; and one that walks the whole document and refuses an
// action input that happens to be called `container`.
describe("reading what a document asks a container runtime for", () => {
  test("every shape, in workflows and actions", () => {
    const workflow = Bun.YAML.parse(
      [
        "jobs:",
        "  a:",
        "    container: node:22",
        "    services:",
        "      postgres:",
        `        image: postgres:16-alpine@${DIGEST}`,
        "      redis: redis:7",
        "  b:",
        "    container:",
        `      image: oven/bun:1@${DIGEST}`,
        "    steps:",
        `      - uses: actions/checkout@${COMMIT}`,
        "      - uses: docker://alpine:3.22",
        "  c:",
        "    steps:",
        `      - uses: some/action@${COMMIT}`,
        "        with:",
        "          container: not-a-container",
      ].join("\n"),
    );
    expect(containersIn(workflow)).toEqual([
      "jobs.a.container",
      "jobs.a.services.postgres",
      "jobs.a.services.redis",
      "jobs.b.container",
      "jobs.b.steps[1] uses docker://alpine:3.22",
    ]);

    const dockerAction = Bun.YAML.parse(
      "name: x\ndescription: y\nruns:\n  using: docker\n  image: Dockerfile\n",
    );
    expect(containersIn(dockerAction)).toEqual(["runs.using: docker"]);

    const composite = Bun.YAML.parse(
      `runs:\n  using: composite\n  steps:\n    - uses: docker://alpine@${DIGEST}\n`,
    );
    expect(containersIn(composite)).toEqual([`runs.steps[0] uses docker://alpine@${DIGEST}`]);
  });

  test("a job with none asks for nothing", () => {
    expect(
      containersIn(
        Bun.YAML.parse(`jobs:\n  a:\n    steps:\n      - uses: actions/checkout@${COMMIT}\n`),
      ),
    ).toEqual([]);
  });
});

describe("the workflow gate", () => {
  test("refuses each of them by the file that declares it, and says what to do instead", async () => {
    expect(
      await refusals({
        ".github/workflows/db.yml": `jobs:\n  check:\n    services:\n      postgres:\n        image: postgres:16-alpine@${DIGEST}\n    steps:\n      - uses: actions/checkout@${COMMIT}\n`,
        ".github/actions/dockery/action.yml":
          "name: x\ndescription: y\nruns:\n  using: docker\n  image: Dockerfile\n",
      }),
    ).toEqual([
      containing(
        ".github/actions/dockery/action.yml: runs.using: docker needs a container runtime, which no runner in this fleet has",
      ),
      containing(
        ".github/workflows/db.yml: jobs.check.services.postgres needs a container runtime, which no runner in this fleet has — a server the job needs comes from the runner's own binaries",
      ),
    ]);
  });

  // This repo's own workflows are the first callers of every rule the gate
  // holds, this one included: none of them may ask for a container.
  test("passes this repo's own workflows and actions", async () => {
    const problems = await workflowGate(new URL("..", import.meta.url).pathname, []);
    expect(problems.map(({ file, message }) => `${file ?? ""}: ${message}`)).toEqual([]);
  });
});
