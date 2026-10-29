/**
 * A throwaway PostgreSQL 16 and Redis 7 for one job, run from the runner's own
 * binaries under a directory the job owns, and gone when the job is.
 *
 * The runner's side of the contract: `initdb`, `pg_ctl` and `postgres` from
 * PostgreSQL 16 and `redis-server` 7 on the job's PATH, an account that is not
 * root (initdb refuses one), and Linux's /proc, which is how a pid is checked
 * to still be the server it was written for.
 */
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";

/** The two addresses a job's suites and gates are handed. */
export interface Services {
  readonly databaseUrl: string;
  readonly redisUrl: string;
}

/** A port on 127.0.0.1 that nothing held when it was asked for. */
export type Allocate = () => number;

const BINARIES = ["initdb", "pg_ctl", "postgres", "redis-server"] as const;

/**
 * How many ports a start tries per server. Between the allocation and the
 * server's own bind another process can take the port, which on a shared box is
 * a race rather than a hypothetical; the server's refusal is what says it
 * happened, and a fresh port is the answer. Five lost races in a row is a box
 * with something wrong on it, not bad luck.
 */
const ATTEMPTS = 5;

const READY_MS = 60_000;

/** How long a server gets to exit on its own signal before it is killed. */
const EXIT_MS = 10_000;

const PASSWORD = "postgres";

/** The kernel's pick, read back and released: the server binds it a moment later. */
export const freePort: Allocate = () => {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = listener;
  listener.stop(true);
  return port;
};

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
 * The binaries the contract names, on PATH, at the majors it names. A runner
 * carrying Postgres 17 would grade every repo's migrations against a server
 * its production does not run, and say nothing.
 */
async function located(): Promise<void> {
  const missing = BINARIES.filter((name) => Bun.which(name) === null);
  if (missing.length > 0) {
    throw new Error(
      `the runner has no ${missing.join(", ")} on PATH — this action runs PostgreSQL 16's initdb, pg_ctl and postgres and redis-server 7 from the job's PATH`,
    );
  }
  const postgres = await run(["postgres", "--version"]);
  if (!/\(PostgreSQL\) 16\./.test(postgres.output)) {
    throw new Error(`${Bun.which("postgres") ?? ""} is not PostgreSQL 16: ${postgres.output}`);
  }
  const redis = await run(["redis-server", "--version"]);
  if (!/\bv=7\./.test(redis.output)) {
    throw new Error(`${Bun.which("redis-server") ?? ""} is not Redis 7: ${redis.output}`);
  }
}

async function textOf(path: string): Promise<string> {
  return existsSync(path) ? await readFile(path, "utf8") : "";
}

/**
 * Whether `pid` is a live `server` process. Read from /proc rather than probed
 * with signal 0, because a pid the server once had can belong to anything by
 * the time a stop reads it, and a stop must never signal that. Redis rewrites
 * its title into one space-separated argument, so the program is the first
 * word of the first argument.
 */
export function runs(pid: number, server: string): boolean {
  let cmdline: string;
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch (error) {
    // The process exited between the pid being read and its entry being opened.
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
  const program = cmdline.split("\0")[0]?.split(" ")[0] ?? "";
  return basename(program) === server;
}

/**
 * Tries ports until `launch` reports one ready, and answers it. `launch`
 * reports `taken` when the server lost the port to another process before it
 * could bind; anything else it throws.
 */
async function onFreshPort(
  name: string,
  allocate: Allocate,
  launch: (port: number) => Promise<"ready" | "taken">,
): Promise<number> {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const port = allocate();
    if ((await launch(port)) === "ready") return port;
  }
  throw new Error(
    `${name} found every one of ${ATTEMPTS} allocated ports taken before it could bind`,
  );
}

async function startPostgres(root: string, allocate: Allocate): Promise<string> {
  const data = join(root, "postgres");
  const passwordFile = join(root, "password");
  await Bun.write(passwordFile, `${PASSWORD}\n`);

  // C.UTF-8 orders by code point, so ORDER BY over text is the same on every runner.
  const initdb = await run([
    "initdb",
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

  const port = await onFreshPort("postgres", allocate, async (candidate) => {
    const log = join(root, `postgres-${candidate}.log`);
    const started = await run([
      "pg_ctl",
      "start",
      `--pgdata=${data}`,
      `--log=${log}`,
      "--wait",
      `--timeout=${READY_MS / 1000}`,
      `--options=-p ${candidate}`,
    ]);
    if (started.status === 0) return "ready";
    const said = await textOf(log);
    if (/could not bind .*Address already in use/.test(said)) return "taken";
    throw new Error(`postgres did not start on 127.0.0.1:${candidate}: ${started.output}\n${said}`);
  });
  return `postgres://postgres:${PASSWORD}@127.0.0.1:${port}/postgres`;
}

async function startRedis(root: string, allocate: Allocate): Promise<string> {
  const data = join(root, "redis");
  await mkdir(data);
  const port = await onFreshPort("redis-server", allocate, async (candidate) => {
    const log = join(root, `redis-${candidate}.log`);
    const launched = await run([
      "redis-server",
      "--bind",
      "127.0.0.1",
      "--port",
      String(candidate),
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
      if (/Ready to accept connections/.test(said)) return "ready";
      if (/Address already in use/.test(said)) return "taken";
      if (/aborting/.test(said)) break;
      await Bun.sleep(50);
    }
    throw new Error(`redis-server did not become ready on 127.0.0.1:${candidate}:\n${said}`);
  });
  return `redis://127.0.0.1:${port}`;
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
export async function start(root: string, allocate: Allocate = freePort): Promise<Services> {
  if (existsSync(root)) {
    throw new Error(`${root} already exists — a start that was never stopped; run stop first`);
  }
  await located();
  await mkdir(root, { recursive: true });
  const databaseUrl = await startPostgres(root, allocate);
  const redisUrl = await startRedis(root, allocate);
  return { databaseUrl, redisUrl };
}

async function exited(pid: number, server: string, within: number): Promise<boolean> {
  const deadline = Date.now() + within;
  while (runs(pid, server) && Date.now() < deadline) await Bun.sleep(50);
  return !runs(pid, server);
}

/**
 * Signals the server whose pid `pidFile` names, and kills it if the signal is
 * not enough. A pid file naming no live process of that server is a server
 * already gone — crashed, or never started — and there is nothing to do.
 */
async function terminate(pidFile: string, server: string, signal: NodeJS.Signals): Promise<void> {
  const pid = Number.parseInt(await textOf(pidFile), 10);
  if (Number.isNaN(pid) || !runs(pid, server)) return;
  process.kill(pid, signal);
  if (await exited(pid, server, EXIT_MS)) return;
  process.kill(pid, "SIGKILL");
  if (!(await exited(pid, server, EXIT_MS))) {
    throw new Error(`${server} (pid ${pid}) is still running after SIGKILL`);
  }
}

/**
 * Stops whatever `start` left under `root` and deletes it. Nothing there is
 * the ordinary case of a job that failed before it started anything, and is
 * not an error: this runs under `always()`, and a second failure there would
 * bury the first. SIGQUIT is Postgres's immediate shutdown.
 */
export async function stop(root: string): Promise<void> {
  if (!existsSync(root)) return;
  await terminate(join(root, "redis.pid"), "redis-server", "SIGTERM");
  await terminate(join(root, "postgres", "postmaster.pid"), "postgres", "SIGQUIT");
  await rm(root, { recursive: true, force: true });
}
