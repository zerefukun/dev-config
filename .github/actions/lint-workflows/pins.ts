import { isList, type Problem, parseEach, record, repoFiles } from "../_lib/gate.ts";
import { containersIn } from "./containers.ts";

/** GitHub accepts both spellings for every one of these, so both are read. */
export const ACTION_FILES = [".github/actions/*/action.yml", ".github/actions/*/action.yaml"];
const OWN = [".github/workflows/*.yml", ".github/workflows/*.yaml", ...ACTION_FILES];

const COMMIT = /@[0-9a-f]{40}$/;

/**
 * Every `uses:` in a parsed workflow or action, wherever it sits — a step's, a
 * job's `uses:` for a reusable workflow, a composite action's own steps. Read
 * off the parsed document rather than grepped: `-   uses:` with extra spacing,
 * a quoted value and a key nested somewhere the pattern did not anticipate are
 * all the same node to a parser and three separate holes in a regex.
 */
export function referencesIn(document: unknown): string[] {
  if (isList(document)) return document.flatMap(referencesIn);
  if (typeof document !== "object" || document === null) return [];

  const node = record(document);
  const uses = node["uses"];
  // No need to skip the `uses` key below: its value is the string just taken,
  // and a string has no references inside it.
  return [
    ...(typeof uses === "string" ? [uses] : []),
    ...Object.values(node).flatMap(referencesIn),
  ];
}

export interface Reference {
  readonly file: string;
  readonly value: string;
}

export function unpinned(references: readonly Reference[]): Problem[] {
  return references.flatMap(({ file, value }) => {
    // A local action is this repo's own tree at this commit; there is no ref.
    // A docker:// image is refused whole by the container rule, pinned or not.
    if (value.startsWith("./") || value.startsWith("docker://")) return [];
    return COMMIT.test(value)
      ? []
      : [
          {
            file,
            message: `${value} is not pinned — use a 40-character commit SHA with the tag as a trailing comment`,
          },
        ];
  });
}

export async function workflowGate(
  root: string,
  extraPaths: readonly string[],
): Promise<Problem[]> {
  const own = await repoFiles(root, OWN);
  // An extra path that matches nothing is a problem in its own right: it is how
  // a renamed file quietly stops being checked.
  const extra = await Promise.all(extraPaths.map(async (path) => await repoFiles(root, [path])));
  const missing = extraPaths.flatMap((path, index) =>
    (extra[index] ?? []).length === 0
      ? [{ file: path, message: "extra-paths matched no file — check the path" }]
      : [],
  );

  const files = [...new Set([...own, ...extra.flat()])].toSorted((a, b) => a.localeCompare(b));
  const documents = await parseEach(root, files, "YAML");

  const references: Reference[] = documents.read.flatMap(({ file, value }) =>
    referencesIn(value).map((used) => ({ file, value: used })),
  );

  const containers = documents.read.flatMap(({ file, value }) =>
    containersIn(value).map((what) => ({
      file,
      message: `${what} needs a container runtime, which no runner in this fleet has — a server the job needs comes from the runner's own binaries (the services action starts Postgres and Redis that way)`,
    })),
  );

  return [...missing, ...documents.problems, ...unpinned(references), ...containers];
}
