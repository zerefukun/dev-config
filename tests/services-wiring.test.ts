import { expect, test } from "bun:test";
import { join } from "node:path";

import { type ConfigObject, isList, record } from "../.github/actions/_lib/gate.ts";

const ROOT = join(import.meta.dir, "..");

/** Where a job starts and stops the services action's servers, and what it hands their URLs to. */
interface Wiring {
  readonly starts: number;
  readonly stops: number;
  readonly startId: unknown;
  readonly stopIf: unknown;
  /** The stop comes after the start and after every step that reads the URLs. */
  readonly stopLast: boolean;
  /** Each environment variable a step sets from the action's outputs, and the output it names. */
  readonly urls: Readonly<Record<string, string>>;
}

const SERVICES = /(^\.|^zerefukun\/dev-config)\/\.github\/actions\/services(@|$)/;

function wiringOf(job: ConfigObject): Wiring {
  const steps = (isList(job["steps"]) ? job["steps"] : []).map((step) => record(step));
  const at = (command: string): number[] =>
    steps.flatMap((step, index) =>
      SERVICES.test(String(step["uses"])) && record(step["with"])["command"] === command
        ? [index]
        : [],
    );
  const starts = at("start");
  const stops = at("stop");
  const reads = steps.flatMap((step, index) =>
    JSON.stringify(step).includes("steps.services.outputs") ? [index] : [],
  );
  const stop = stops[0] ?? -1;
  const urls = Object.fromEntries(
    steps.flatMap((step) =>
      Object.entries(record(step["env"])).flatMap(([name, value]) =>
        typeof value === "string" && value.includes("steps.services.outputs")
          ? [[name, value] as const]
          : [],
      ),
    ),
  );
  return {
    starts: starts.length,
    stops: stops.length,
    startId: steps[starts[0] ?? -1]?.["id"],
    stopIf: steps[stop]?.["if"],
    stopLast: [...starts, ...reads].every((index) => index < stop),
    urls,
  };
}

async function jobIn(file: string, name: string): Promise<ConfigObject> {
  const document = record(Bun.YAML.parse(await Bun.file(join(ROOT, file)).text()));
  return record(record(document["jobs"])[name]);
}

const STARTED = {
  starts: 1,
  stops: 1,
  startId: "services",
  stopIf: "always()",
  stopLast: true,
} as const;

// The wrong implementations: a stop that runs only when the job passed, which
// leaves a failed job's servers on the box; a stop placed before a step that
// still reads the URLs; a start the URLs cannot name, because it has no id;
// and a URL written out by hand — 5432 — instead of read from the start that
// picked the port.
test("the jobs that use the services action are the two the next case grades", async () => {
  const files = await Array.fromAsync(new Bun.Glob(".github/workflows/*.yml").scan(ROOT));
  const using = await Promise.all(
    files.toSorted().map(async (file) => {
      const jobs = record(record(Bun.YAML.parse(await Bun.file(join(ROOT, file)).text()))["jobs"]);
      return Object.entries(jobs).flatMap(([name, body]) => {
        const wiring = wiringOf(record(body));
        return wiring.starts + wiring.stops > 0 ? [`${file}: ${name}`] : [];
      });
    }),
  );
  expect(using.flat()).toEqual([
    ".github/workflows/check.yml: database",
    ".github/workflows/ci.yml: check",
  ]);
});

test("each job that needs the servers starts them, hands on their URLs and stops them under always()", async () => {
  expect(wiringOf(await jobIn(".github/workflows/check.yml", "database"))).toEqual({
    ...STARTED,
    urls: {
      DATABASE_URL: "${{ steps.services.outputs.database-url }}",
      REDIS_URL: "${{ steps.services.outputs.redis-url }}",
    },
  });
  expect(wiringOf(await jobIn(".github/workflows/ci.yml", "check"))).toEqual({
    ...STARTED,
    urls: {
      TEST_DATABASE_URL: "${{ steps.services.outputs.database-url }}",
      TEST_REDIS_URL: "${{ steps.services.outputs.redis-url }}",
    },
  });
});
