import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";

import { RedisClient, SQL } from "bun";

import { required } from "../.github/actions/_lib/gate.ts";
import { rows } from "../.github/actions/db-gate/database.ts";
import {
  type Allocate,
  freePort,
  type Services,
  start,
  stop,
} from "../.github/actions/services/services.ts";

/**
 * The runner contract, read off this process's PATH: the suite runs the
 * binaries the action would, and fails rather than skips on a machine without
 * them.
 */
const PATH = required("PATH", "the server binaries are looked up on it");

/** initdb and two server starts take a few seconds; the margin is a loaded runner. */
const SLOW = 60_000;

interface Scratch extends AsyncDisposable {
  readonly root: string;
}

/** A root no start has used, stopped and deleted when the case ends, whatever it did there. */
async function scratch(): Promise<Scratch> {
  const parent = await mkdtemp(join(tmpdir(), "services-"));
  const root = join(parent, "services");
  return {
    root,
    async [Symbol.asyncDispose]() {
      await stop(root, PATH);
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

function portOf(url: string): number {
  return Number(new URL(url).port);
}

async function pidIn(path: string): Promise<number> {
  return Number.parseInt(await readFile(path, "utf8"), 10);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
      const services = await start(run.root, PATH);
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
      const [a, b] = await Promise.all([start(first.root, PATH), start(second.root, PATH)]);
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
      const services = await start(run.root, PATH, scripted(taken.port, freePort(), taken.port));
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
      expect(await refusal(start(run.root, PATH, () => taken.port))).toContain(
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
      await start(run.root, PATH);
      expect(await refusal(start(run.root, PATH))).toContain("already exists");
    },
    SLOW,
  );

  test("names every binary the runner is missing, before it starts anything", async () => {
    await using run = await scratch();
    const empty = await mkdtemp(join(tmpdir(), "no-binaries-"));
    try {
      expect(await refusal(start(run.root, empty))).toContain(
        "the runner has no initdb, pg_ctl, postgres, redis-server",
      );
      expect(existsSync(run.root)).toBe(false);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  // A runner carrying another major grades every migration against a server
  // production does not run; the wrong implementation takes whatever is first
  // on PATH.
  test("refuses a Postgres that is not 16", async () => {
    await using run = await scratch();
    const bin = await mkdtemp(join(tmpdir(), "postgres-17-"));
    try {
      for (const name of ["initdb", "pg_ctl", "postgres"]) {
        await Bun.write(join(bin, name), "#!/bin/sh\necho 'postgres (PostgreSQL) 17.2'\n");
        await chmod(join(bin, name), 0o755);
      }
      expect(await refusal(start(run.root, `${bin}:${PATH}`))).toContain("is not PostgreSQL 16");
      expect(existsSync(run.root)).toBe(false);
    } finally {
      await rm(bin, { recursive: true, force: true });
    }
  });
});

// The wrong implementations: a stop that deletes the directory and leaves the
// servers running on it; one that leaves the directory; one that fails when
// there is nothing to stop, which under `always()` buries the failure that
// ended the job early; and one that only knows how to take down a whole pair,
// so a start that died between the two leaves its Postgres running.
describe("stop", () => {
  test(
    "takes both servers down and deletes everything they wrote",
    async () => {
      await using run = await scratch();
      await start(run.root, PATH);
      const running = [
        await pidIn(join(run.root, "postgres", "postmaster.pid")),
        await pidIn(join(run.root, "redis.pid")),
      ];
      expect(running.map(alive)).toEqual([true, true]);
      await stop(run.root, PATH);
      expect(running.map(alive)).toEqual([false, false]);
      expect(existsSync(run.root)).toBe(false);
    },
    SLOW,
  );

  test("is nothing at all when nothing was started", async () => {
    const parent = await mkdtemp(join(tmpdir(), "services-"));
    try {
      // An empty PATH as well: a job that failed before start may not even have the binaries.
      await stop(join(parent, "services"), parent);
      expect(existsSync(join(parent, "services"))).toBe(false);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
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
      expect(await refusal(start(run.root, PATH, dying))).toContain("the allocator died");
      const pid = await pidIn(join(run.root, "postgres", "postmaster.pid"));
      expect(alive(pid)).toBe(true);
      await stop(run.root, PATH);
      expect(alive(pid)).toBe(false);
      expect(existsSync(run.root)).toBe(false);
    },
    SLOW,
  );
});
