import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";

import { RedisClient, SQL } from "bun";

import { rows } from "../.github/actions/db-gate/database.ts";
import {
  type Allocate,
  freePort,
  runs,
  type Services,
  start,
  stop,
} from "../.github/actions/services/services.ts";

/** The command the action runs, so the PATH it reads is the one a case hands it. */
const MAIN = join(import.meta.dir, "..", ".github", "actions", "services", "services.main.ts");

/** initdb and two server starts take a few seconds; the margin is a loaded runner. */
const SLOW = 60_000;

interface Scratch extends AsyncDisposable {
  readonly root: string;
  readonly parent: string;
}

/** A root no start has used, stopped and deleted when the case ends, whatever it did there. */
async function scratch(): Promise<Scratch> {
  const parent = await mkdtemp(join(tmpdir(), "services-"));
  const root = join(parent, "services");
  return {
    root,
    parent,
    async [Symbol.asyncDispose]() {
      await stop(root);
      await rm(parent, { recursive: true, force: true });
    },
  };
}

/** What a call that must fail failed with; a call that resolved fails the case. */
async function refusal(pending: Promise<unknown>): Promise<string> {
  const outcome = await pending.then(
    () => undefined,
    (error: unknown) => String(error),
  );
  if (outcome === undefined) throw new Error("expected a refusal, and the call resolved");
  return outcome;
}

/** `services.main.ts start` as the action runs it, on the PATH a case chooses. */
async function startOn(path: string, root: string): Promise<{ status: number; output: string }> {
  const proc = Bun.spawn([process.execPath, MAIN, "start", root, join(root, "..", "outputs")], {
    env: { ...process.env, PATH: path },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { status, output: stdout + stderr };
}

function portOf(url: string): number {
  return Number(new URL(url).port);
}

async function pidIn(path: string): Promise<number> {
  return Number.parseInt(await readFile(path, "utf8"), 10);
}

/** An allocator that answers from a script, then from the kernel. */
function scripted(...ports: readonly number[]): Allocate {
  const queue = [...ports];
  return () => queue.shift() ?? freePort();
}

async function answers(services: Services): Promise<void> {
  const sql = new SQL(services.databaseUrl);
  expect(await rows(sql, "select 1 as one")).toEqual([{ one: 1 }]);
  await sql.close();
  const redis = new RedisClient(services.redisUrl);
  expect(await redis.send("PING", [])).toBe("PONG");
  redis.close();
}

/** This box's IPv4 addresses besides loopback: where a server bound to every interface also answers. */
const ELSEWHERE = Object.values(networkInterfaces())
  .flat()
  .flatMap((address) =>
    address !== undefined && address.family === "IPv4" && !address.internal
      ? [address.address]
      : [],
  );

async function reachable(hostname: string, port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({ hostname, port, socket: { data() {} } });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

/** A port held open for the length of a case, which is what a lost allocation race looks like. */
function held(): Disposable & { readonly port: number } {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  return {
    port: listener.port,
    [Symbol.dispose]() {
      listener.stop(true);
    },
  };
}

// The wrong implementations: a server left on its default listen address
// (Postgres's `localhost`, Redis's every interface), which answers off the box;
// a fixed port, which two overlapping jobs collide on; and URLs that name
// something other than what was started.
describe("start", () => {
  test(
    "hands back a Postgres and a Redis that answer, on 127.0.0.1 and nowhere else",
    async () => {
      await using run = await scratch();
      const services = await start(run.root);
      await answers(services);

      const sql = new SQL(services.databaseUrl);
      expect(await rows(sql, "show listen_addresses")).toEqual([{ listen_addresses: "127.0.0.1" }]);
      await sql.close();

      // A box with no other address cannot show this half, and fails saying so.
      expect(ELSEWHERE.length).toBeGreaterThan(0);
      for (const address of ELSEWHERE) {
        expect(await reachable(address, portOf(services.databaseUrl))).toBe(false);
        expect(await reachable(address, portOf(services.redisUrl))).toBe(false);
      }
    },
    SLOW,
  );

  test(
    "gives two jobs on one box two pairs of ports",
    async () => {
      await using first = await scratch();
      await using second = await scratch();
      const [a, b] = await Promise.all([start(first.root), start(second.root)]);
      expect(portOf(a.databaseUrl)).not.toBe(portOf(b.databaseUrl));
      expect(portOf(a.redisUrl)).not.toBe(portOf(b.redisUrl));
      await answers(a);
      await answers(b);
    },
    SLOW,
  );

  // The race the allocator cannot close: the port is free when asked for and
  // taken before the server binds it. The wrong implementations give up on the
  // first refusal, or ask the server to bind the same port again.
  test(
    "takes a fresh port when the one it was given is taken before the bind",
    async () => {
      await using run = await scratch();
      using taken = held();
      const services = await start(run.root, scripted(taken.port, freePort(), taken.port));
      expect(portOf(services.databaseUrl)).not.toBe(taken.port);
      expect(portOf(services.redisUrl)).not.toBe(taken.port);
      await answers(services);
    },
    SLOW,
  );

  test(
    "fails loudly when every port it is given is taken",
    async () => {
      await using run = await scratch();
      using taken = held();
      expect(await refusal(start(run.root, () => taken.port))).toContain(
        "postgres found every one of 5 allocated ports taken",
      );
    },
    SLOW,
  );

  // A start over a root it already used would leave the first pair running
  // with nothing pointing at them.
  test(
    "refuses a root a previous start left behind",
    async () => {
      await using run = await scratch();
      await start(run.root);
      expect(await refusal(start(run.root))).toContain("already exists");
    },
    SLOW,
  );

  // The binaries come from the job's PATH and nowhere else, so a runner that
  // keeps them off it fails here, at the start, rather than in whichever later
  // step first looks them up a different way.
  test("names every binary missing from the job's PATH, before it starts anything", async () => {
    await using run = await scratch();
    const empty = join(run.parent, "empty");
    await mkdir(empty);
    const started = await startOn(empty, run.root);
    expect(started.status).toBe(1);
    expect(started.output).toContain(
      "::error::the runner has no initdb, pg_ctl, postgres, redis-server on PATH",
    );
    expect(existsSync(run.root)).toBe(false);
  });

  // A runner carrying another major grades every migration against a server
  // production does not run; the wrong implementation takes whatever is first
  // on PATH.
  test("refuses a Postgres that is not 16", async () => {
    await using run = await scratch();
    const bin = join(run.parent, "postgres-17");
    await mkdir(bin);
    for (const name of ["initdb", "pg_ctl", "postgres"]) {
      await Bun.write(join(bin, name), "#!/bin/sh\necho 'postgres (PostgreSQL) 17.2'\n");
      await chmod(join(bin, name), 0o755);
    }
    const started = await startOn(`${bin}:${process.env["PATH"] ?? ""}`, run.root);
    expect(started.status).toBe(1);
    expect(started.output).toContain("is not PostgreSQL 16");
    expect(existsSync(run.root)).toBe(false);
  });
});

// The wrong implementations: a stop that deletes the directory and leaves the
// servers running on it; one that leaves the directory; one that fails when
// there is nothing to stop, which under `always()` buries the failure that
// ended the job early; one that only knows how to take down a whole pair, so a
// start that died between the two leaves its Postgres running; one that
// treats a server that already died as a failure, which leaves its directory
// behind; and one that signals whatever now holds a pid the server once had.
describe("stop", () => {
  test(
    "takes both servers down and deletes everything they wrote",
    async () => {
      await using run = await scratch();
      await start(run.root);
      const postgres = await pidIn(join(run.root, "postgres", "postmaster.pid"));
      const redis = await pidIn(join(run.root, "redis.pid"));
      expect([runs(postgres, "postgres"), runs(redis, "redis-server")]).toEqual([true, true]);
      await stop(run.root);
      expect([runs(postgres, "postgres"), runs(redis, "redis-server")]).toEqual([false, false]);
      expect(existsSync(run.root)).toBe(false);
    },
    SLOW,
  );

  test("is nothing at all when nothing was started", async () => {
    await using run = await scratch();
    await stop(run.root);
    expect(existsSync(run.root)).toBe(false);
  });

  test(
    "takes down the Postgres of a start that died before its Redis",
    async () => {
      await using run = await scratch();
      let asked = 0;
      const dying: Allocate = () => {
        asked++;
        if (asked > 1) throw new Error("the allocator died");
        return freePort();
      };
      expect(await refusal(start(run.root, dying))).toContain("the allocator died");
      const pid = await pidIn(join(run.root, "postgres", "postmaster.pid"));
      expect(runs(pid, "postgres")).toBe(true);
      await stop(run.root);
      expect(runs(pid, "postgres")).toBe(false);
      expect(existsSync(run.root)).toBe(false);
    },
    SLOW,
  );

  test(
    "cleans up after a Postgres that crashed",
    async () => {
      await using run = await scratch();
      await start(run.root);
      const pid = await pidIn(join(run.root, "postgres", "postmaster.pid"));
      process.kill(pid, "SIGKILL");
      await stop(run.root);
      expect(existsSync(run.root)).toBe(false);
    },
    SLOW,
  );

  test("never signals a process that reused a server's pid", async () => {
    await using run = await scratch();
    await mkdir(join(run.root, "postgres"), { recursive: true });
    await using bystander = Bun.spawn(["sleep", "30"]);
    await Bun.write(join(run.root, "postgres", "postmaster.pid"), `${bystander.pid}\n`);
    await Bun.write(join(run.root, "redis.pid"), `${bystander.pid}\n`);
    await stop(run.root);
    expect(runs(bystander.pid, "sleep")).toBe(true);
    expect(existsSync(run.root)).toBe(false);
    bystander.kill();
  });
});
