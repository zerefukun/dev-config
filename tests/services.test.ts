import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";

import { RedisClient, SQL } from "bun";
import { createConnection, type RowDataPacket } from "mysql2/promise";

import { rows } from "../.github/actions/db-gate/database.ts";
import {
  type Allocate,
  freePort,
  runs,
  selected,
  type ServerName,
  start,
  type Started,
  stop,
} from "../.github/actions/services/services.ts";

/** What every start runs, and what one asked for MySQL runs. */
const PAIR = selected({ mysql: false });
const WITH_MYSQL = selected({ mysql: true });

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
async function startOn(
  path: string,
  root: string,
  mysql = "false",
): Promise<{ status: number; output: string }> {
  const outputs = join(root, "..", "outputs");
  const proc = Bun.spawn([process.execPath, MAIN, "start", root, outputs, mysql], {
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

/**
 * Where the started MySQL listens and keeps its data, and whether its X
 * Protocol plugin is on, as the server reports them. Every MySQL case needs
 * Ubuntu's AppArmor profile for /usr/sbin/mysqld unloaded, which in CI the
 * services action's own start in ci.yml did earlier in the same job, and by
 * hand the command README's "Gating this repo" gives.
 */
async function mysqlPlace(url: string): Promise<{ bound: string; data: string; x: string }> {
  const connection = await createConnection(url);
  try {
    const [found] = await connection.query<RowDataPacket[]>(
      "select @@bind_address as bound, @@datadir as data, (select plugin_status from information_schema.plugins where plugin_name = 'mysqlx') as x",
    );
    const row = found[0];
    return { bound: String(row?.["bound"]), data: String(row?.["data"]), x: String(row?.["x"]) };
  } finally {
    await connection.end();
  }
}

/** The URL a start handed back for `name`, which fails the case when it started none. */
function urlOf(started: readonly Started[], name: ServerName): string {
  const found = started.find(({ server }) => server.name === name);
  if (found === undefined) throw new Error(`the start handed back no ${name}`);
  return found.url;
}

async function pidIn(path: string): Promise<number> {
  return Number.parseInt(await readFile(path, "utf8"), 10);
}

/** An allocator that answers from a script, then from the kernel. */
function scripted(...ports: readonly number[]): Allocate {
  const queue = [...ports];
  return (server) => queue.shift() ?? freePort(server);
}

async function answers(services: readonly Started[]): Promise<void> {
  const sql = new SQL(urlOf(services, "postgres"));
  expect(await rows(sql, "select 1 as one")).toEqual([{ one: 1 }]);
  await sql.close();
  const redis = new RedisClient(urlOf(services, "redis"));
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
// (Postgres's `localhost`, Redis's every interface), which answers off the
// machine; a fixed port, which two checkouts on one machine collide on; and URLs that name
// something other than what was started.
describe("start", () => {
  test(
    "hands back a Postgres and a Redis that answer, on 127.0.0.1 and nowhere else",
    async () => {
      await using run = await scratch();
      const services = await start(run.root, PAIR);
      await answers(services);

      const sql = new SQL(urlOf(services, "postgres"));
      expect(await rows(sql, "show listen_addresses")).toEqual([{ listen_addresses: "127.0.0.1" }]);
      await sql.close();

      // A box with no other address cannot show this half, and fails saying so.
      expect(ELSEWHERE.length).toBeGreaterThan(0);
      for (const address of ELSEWHERE) {
        expect(await reachable(address, portOf(urlOf(services, "postgres")))).toBe(false);
        expect(await reachable(address, portOf(urlOf(services, "redis")))).toBe(false);
      }
    },
    SLOW,
  );

  test(
    "gives two checkouts on one machine two pairs of ports",
    async () => {
      await using first = await scratch();
      await using second = await scratch();
      const [a, b] = await Promise.all([start(first.root, PAIR), start(second.root, PAIR)]);
      for (const name of ["postgres", "redis"] as const) {
        expect(portOf(urlOf(a, name))).not.toBe(portOf(urlOf(b, name)));
      }
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
      const services = await start(
        run.root,
        PAIR,
        scripted(taken.port, freePort("postgres"), taken.port),
      );
      expect(portOf(urlOf(services, "postgres"))).not.toBe(taken.port);
      expect(portOf(urlOf(services, "redis"))).not.toBe(taken.port);
      await answers(services);
    },
    SLOW,
  );

  test(
    "fails loudly when every port it is given is taken",
    async () => {
      await using run = await scratch();
      using taken = held();
      expect(await refusal(start(run.root, PAIR, () => taken.port))).toContain(
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
      await start(run.root, PAIR);
      expect(await refusal(start(run.root, PAIR))).toContain("already exists");
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

  // The wrong implementation starts MySQL on every start, which hands every
  // job that asked for PostgreSQL and Redis alone a third server and output.
  test(
    "starts no MySQL and names no mysql-url unless asked",
    async () => {
      await using run = await scratch();
      const started = await startOn(process.env["PATH"] ?? "", run.root);
      expect(started.status).toBe(0);
      const outputs = await readFile(join(run.parent, "outputs"), "utf8");
      expect(outputs).toContain("database-url=");
      expect(outputs).not.toContain("mysql-url");
      expect(existsSync(join(run.root, "mysql"))).toBe(false);
      expect(existsSync(join(run.root, "mysql.pid"))).toBe(false);
    },
    SLOW,
  );

  // The wrong implementations: MySQL's default listen address, every
  // interface; the X Protocol listener left on, which binds every interface
  // on a port of its own; a fixed 3306; the image's own instance or its
  // system data directory in place of one under the root; a root with no
  // password on a loopback other accounts share; and a URL that names
  // something other than what was started.
  test(
    "asked, hands back a MySQL of the root's own that answers on 127.0.0.1 and nowhere else",
    async () => {
      await using run = await scratch();
      const started = await startOn(process.env["PATH"] ?? "", run.root, "true");
      expect(started.status).toBe(0);
      const outputs = await readFile(join(run.parent, "outputs"), "utf8");
      const url = /^mysql-url=(.*)$/m.exec(outputs)?.[1] ?? "";
      const parsed = new URL(url);
      expect([parsed.username, parsed.hostname]).toEqual(["root", "127.0.0.1"]);
      expect(parsed.password).toMatch(/^[0-9a-f]{48}$/);
      expect(await mysqlPlace(url)).toEqual({
        bound: "127.0.0.1",
        data: `${join(run.root, "mysql")}/`,
        x: "DISABLED",
      });
      // The loopback is every local account's, so root without the password
      // the start made is refused.
      parsed.password = "";
      expect(await refusal(createConnection(parsed.href))).toContain("Access denied");
      expect(ELSEWHERE.length).toBeGreaterThan(0);
      for (const address of ELSEWHERE) {
        expect(await reachable(address, portOf(url))).toBe(false);
      }
    },
    SLOW,
  );

  test(
    "fails a MySQL start by name when every port it is given is taken",
    async () => {
      await using run = await scratch();
      using taken = held();
      const mysqlTaken: Allocate = (server) => (server === "mysql" ? taken.port : freePort(server));
      expect(await refusal(start(run.root, WITH_MYSQL, mysqlTaken))).toContain(
        "mysql found every one of 5 allocated ports taken",
      );
    },
    SLOW,
  );

  test("refuses a MySQL that is not 8.0, before it starts anything", async () => {
    await using run = await scratch();
    const bin = join(run.parent, "mysql-9");
    await mkdir(bin);
    await Bun.write(
      join(bin, "mysqld"),
      "#!/bin/sh\necho '/usr/sbin/mysqld  Ver 9.1.0 for Linux on x86_64'\n",
    );
    await chmod(join(bin, "mysqld"), 0o755);
    const started = await startOn(`${bin}:${process.env["PATH"] ?? ""}`, run.root, "true");
    expect(started.status).toBe(1);
    expect(started.output).toContain("is not MySQL 8.0");
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
      await start(run.root, PAIR);
      const postgres = await pidIn(join(run.root, "postgres", "postmaster.pid"));
      const redis = await pidIn(join(run.root, "redis.pid"));
      expect([runs(postgres, "postgres"), runs(redis, "redis-server")]).toEqual([true, true]);
      await stop(run.root);
      expect([runs(postgres, "postgres"), runs(redis, "redis-server")]).toEqual([false, false]);
      expect(existsSync(run.root)).toBe(false);
    },
    SLOW,
  );

  test(
    "takes a MySQL it was asked for down by its pid, and deletes its data",
    async () => {
      await using run = await scratch();
      await start(run.root, WITH_MYSQL);
      const mysql = await pidIn(join(run.root, "mysql.pid"));
      expect(runs(mysql, "mysqld")).toBe(true);
      await stop(run.root);
      expect(runs(mysql, "mysqld")).toBe(false);
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
      const dying: Allocate = (server) => {
        if (server === "redis") throw new Error("the allocator died");
        return freePort(server);
      };
      expect(await refusal(start(run.root, PAIR, dying))).toContain("the allocator died");
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
      await start(run.root, PAIR);
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
    // The spawn returns before the child has exec'd, and until it has, its
    // /proc entry still names the parent's program rather than sleep.
    for (let attempt = 0; attempt < 200 && !runs(bystander.pid, "sleep"); attempt += 1) {
      // oxlint-disable-next-line anti-slop/no-real-timers -- the wait is for a real process's exec, which no virtual clock advances
      await Bun.sleep(5);
    }
    expect(runs(bystander.pid, "sleep")).toBe(true);
    await Bun.write(join(run.root, "postgres", "postmaster.pid"), `${bystander.pid}\n`);
    await Bun.write(join(run.root, "redis.pid"), `${bystander.pid}\n`);
    await Bun.write(join(run.root, "mysql.pid"), `${bystander.pid}\n`);
    await stop(run.root);
    expect(runs(bystander.pid, "sleep")).toBe(true);
    expect(existsSync(run.root)).toBe(false);
    bystander.kill();
  });
});
