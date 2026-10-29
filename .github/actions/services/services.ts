/**
 * A throwaway PostgreSQL 16 and Redis 7 for one job, run from the runner's own
 * binaries under a directory the job owns, and gone when the job is.
 *
 * The runner's side of the contract: `initdb`, `pg_ctl` and `postgres` from
 * PostgreSQL 16 and `redis-server` 7 on the PATH this is handed (the action
 * puts `$PG_BIN` first on it when the runner sets one), and an account that is
 * not root, since initdb refuses one.
 */
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

/** The two addresses a job's suites and gates are handed. */
export interface Services {
  readonly databaseUrl: string;
  readonly redisUrl: string;
}

/** A port on 127.0.0.1 that nothing held when it was asked for. */
export type Allocate = () => number;

interface Binaries {
  readonly initdb: string;
  readonly pgCtl: string;
  readonly postgres: string;
  readonly redisServer: string;
}

/**
 * How many ports a start tries per server. Between the allocation and the
 * server's own bind another process can take the port, which on a shared box is
 * a race rather than a hypothetical; the server's refusal is what says it
 * happened, and a fresh port is the answer. Five lost races in a row is a box
 * with something wrong on it, not bad luck.
 */
const ATTEMPTS = 5;

/** How long either server gets to say it is ready. */
const READY_MS = 60_000;

const PASSWORD = "postgres";

/** The kernel's pick, read back and released: the server binds it a moment later. */
export const freePort: Allocate = () => {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = listener;
  listener.stop(true);
  return port;
};

function which(name: string, path: string): string | undefined {
  return Bun.which(name, { PATH: path }) ?? undefined;
}

function located(path: string): Binaries {
  const initdb = which("initdb", path);
  const pgCtl = which("pg_ctl", path);
  const postgres = which("postgres", path);
  const redisServer = which("redis-server", path);
  if (
    initdb === undefined ||
    pgCtl === undefined ||
    postgres === undefined ||
    redisServer === undefined
  ) {
    const missing = [
      ["initdb", initdb],
      ["pg_ctl", pgCtl],
      ["postgres", postgres],
      ["redis-server", redisServer],
    ].flatMap(([name, found]) => (found === undefined ? [name] : []));
    throw new Error(
      `the runner has no ${missing.join(", ")} — this action runs PostgreSQL 16's initdb, pg_ctl and postgres and redis-server 7 from PATH, with $PG_BIN put first on it when the runner sets one`,
    );
  }
  return { initdb, pgCtl, postgres, redisServer };
}

async function run(command: readonly string[]): Promise<{ status: number; output: string }> {
  const proc = Bun.spawn([...command], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { status, output: `${stdout}${stderr}`.trim() };
}

/**
 * The majors the contract names, held rather than trusted: a runner carrying
 * Postgres 17 would grade every repo's migrations against a server its
 * production does not run, and say nothing.
 */
async function versions(binaries: Binaries): Promise<void> {
  const postgres = await run([binaries.postgres, "--version"]);
  if (!/\(PostgreSQL\) 16\./.test(postgres.output)) {
    throw new Error(`${binaries.postgres} is not PostgreSQL 16: ${postgres.output}`);
  }
  const redis = await run([binaries.redisServer, "--version"]);
  if (!/\bv=7\./.test(redis.output)) {
    throw new Error(`${binaries.redisServer} is not Redis 7: ${redis.output}`);
  }
}

async function textOf(path: string): Promise<string> {
  return existsSync(path) ? await readFile(path, "utf8") : "";
}

/** Signal 0 delivers nothing and says whether the pid names a process; EPERM is one that is not ours. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

async function startPostgres(
  root: string,
  binaries: Binaries,
  allocate: Allocate,
): Promise<string> {
  const data = join(root, "postgres");
  const passwordFile = join(root, "password");
  const log = join(root, "postgres.log");
  await Bun.write(passwordFile, `${PASSWORD}\n`);

  // C.UTF-8 orders text by code point, which is what the alpine image's musl
  // did for every repo graded before this, so a suite's ORDER BY reads the same.
  const initdb = await run([
    binaries.initdb,
    `--pgdata=${data}`,
    "--username=postgres",
    `--pwfile=${passwordFile}`,
    "--auth-host=scram-sha-256",
    "--auth-local=scram-sha-256",
    "--encoding=UTF8",
    "--locale=C.UTF-8",
    "--no-sync",
  ]);
  if (initdb.status !== 0) throw new Error(`initdb failed: ${initdb.output}`);

  // No socket at all: the default directory is the system one, which the
  // runner's account may not write and another instance may hold. Durability
  // is off because nothing here outlives the job.
  await appendFile(
    join(data, "postgresql.conf"),
    [
      "listen_addresses = '127.0.0.1'",
      "unix_socket_directories = ''",
      "fsync = off",
      "synchronous_commit = off",
      "full_page_writes = off",
      "",
    ].join("\n"),
  );

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const port = allocate();
    const before = (await textOf(log)).length;
    const started = await run([
      binaries.pgCtl,
      "start",
      `--pgdata=${data}`,
      `--log=${log}`,
      "--wait",
      `--timeout=${READY_MS / 1000}`,
      `--options=-p ${port}`,
    ]);
    if (started.status === 0) return `postgres://postgres:${PASSWORD}@127.0.0.1:${port}/postgres`;
    const said = (await textOf(log)).slice(before);
    if (!/could not bind .*Address already in use/.test(said)) {
      throw new Error(`postgres did not start on 127.0.0.1:${port}: ${started.output}\n${said}`);
    }
  }
  throw new Error(
    `postgres found every one of ${ATTEMPTS} allocated ports taken before it could bind`,
  );
}

async function startRedis(root: string, binaries: Binaries, allocate: Allocate): Promise<string> {
  const data = join(root, "redis");
  await mkdir(data);
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const port = allocate();
    // A log per attempt: the verdict below reads this attempt's lines alone.
    const log = join(root, `redis-${port}.log`);
    const launched = await run([
      binaries.redisServer,
      "--bind",
      "127.0.0.1",
      "--port",
      String(port),
      "--protected-mode",
      "yes",
      "--save",
      "",
      "--appendonly",
      "no",
      "--dir",
      data,
      "--daemonize",
      "yes",
      "--pidfile",
      join(root, "redis.pid"),
      "--logfile",
      log,
    ]);
    if (launched.status !== 0) throw new Error(`redis-server did not launch: ${launched.output}`);

    // Daemonized, the launch answers before the bind; the log is where the
    // server says which way the bind went.
    const deadline = Date.now() + READY_MS;
    let said = "";
    while (Date.now() < deadline) {
      said = await textOf(log);
      if (/Ready to accept connections/.test(said)) {
        return `redis://127.0.0.1:${port}`;
      }
      if (/Address already in use|aborting/.test(said)) break;
      await Bun.sleep(50);
    }
    if (!/Address already in use/.test(said)) {
      throw new Error(`redis-server did not become ready on 127.0.0.1:${port}:\n${said}`);
    }
  }
  throw new Error(
    `redis-server found every one of ${ATTEMPTS} allocated ports taken before it could bind`,
  );
}

/**
 * Starts both servers under `root`, which must not exist yet: a root that does
 * is a start that ran before and was never stopped, and starting over it would
 * leave the first pair running with nothing pointing at them.
 *
 * A start that fails partway leaves what it started under `root`, for `stop`
 * to take down — the job's `always()` step is the one place that cleans up,
 * whether this failed or a later step did.
 */
export async function start(
  root: string,
  path: string,
  allocate: Allocate = freePort,
): Promise<Services> {
  if (existsSync(root)) {
    throw new Error(`${root} already exists — a start that was never stopped; run stop first`);
  }
  const binaries = located(path);
  await versions(binaries);
  await mkdir(root, { recursive: true });
  const databaseUrl = await startPostgres(root, binaries, allocate);
  const redisUrl = await startRedis(root, binaries, allocate);
  return { databaseUrl, redisUrl };
}

async function stopRedis(root: string): Promise<void> {
  const text = await textOf(join(root, "redis.pid"));
  const pid = Number.parseInt(text, 10);
  if (Number.isNaN(pid) || !alive(pid)) return;
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 10_000;
  while (alive(pid) && Date.now() < deadline) await Bun.sleep(50);
  if (alive(pid)) process.kill(pid, "SIGKILL");
  while (alive(pid)) await Bun.sleep(50);
}

/**
 * Stops whatever `start` left under `root` and deletes it. Nothing there is
 * the ordinary case of a job that failed before it started anything, and is
 * not an error: this runs under `always()`, and a second failure there would
 * bury the first.
 */
export async function stop(root: string, path: string): Promise<void> {
  if (!existsSync(root)) return;
  const data = join(root, "postgres");
  await stopRedis(root);
  if (existsSync(join(data, "postmaster.pid"))) {
    const stopped = await run([
      located(path).pgCtl,
      "stop",
      `--pgdata=${data}`,
      "--mode=immediate",
      "--wait",
    ]);
    // Left in place on a failure: the log under root is what says why.
    if (stopped.status !== 0) throw new Error(`pg_ctl stop failed: ${stopped.output}`);
  }
  await rm(root, { recursive: true, force: true });
}
