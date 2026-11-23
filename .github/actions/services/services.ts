/**
 * A throwaway PostgreSQL 16 and Redis 7 for one job, and a MySQL 8.0 when the
 * job asks for one, run under a directory the job owns, and gone when the job
 * is.
 *
 * The machine's side of the contract: each selected server's binaries on PATH
 * at the major its row names, which in CI the action's steps before this one
 * provide, an account that is not root (initdb refuses one), and Linux's
 * /proc, which is how a pid is checked to still be the server it was written
 * for.
 */
import { existsSync, readFileSync } from "node:fs";
import { appendFile, chmod, mkdir, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";

/** The servers this action knows. */
export type ServerName = "postgres" | "redis" | "mysql";

/** A port on 127.0.0.1 that nothing held when the server named was given it. */
export type Allocate = (server: ServerName) => number;

/** Everything a start, a stop and the action's outputs need to know about one server. */
export interface Server {
  readonly name: ServerName;
  /** What a refusal calls it, at the major it must be. */
  readonly label: string;
  /** Every binary it runs, each looked up on PATH. */
  readonly binaries: readonly string[];
  /** The binary asked for its version, and what that answer must match. */
  readonly version: { readonly binary: string; readonly pattern: RegExp };
  /** The action's output its URL goes out under. */
  readonly output: string;
  /** Where under the root it writes its pid, which program that pid must be, and what ends it. */
  readonly pidFile: string;
  readonly program: string;
  readonly stopSignal: NodeJS.Signals;
  readonly start: (root: string, allocate: Allocate) => Promise<string>;
}

/** A server a start brought up, and the URL it answers on. */
export interface Started {
  readonly server: Server;
  readonly url: string;
}

/**
 * How many ports a start tries per server. Between the allocation and the
 * server's own bind another process can take the port, which on a machine
 * running anything else, a developer's or a job whose suite starts servers of
 * its own, is a race rather than a hypothetical; the server's refusal is what
 * says it happened, and a fresh port is the answer. Five lost races in a row is
 * a machine with something wrong on it, not bad luck.
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

/** A command's exit, its output, and whether `within` ran out and it was killed. */
async function run(
  command: readonly string[],
  within?: number,
): Promise<{ status: number; output: string; killed: boolean }> {
  const proc = Bun.spawn([...command], {
    stdout: "pipe",
    stderr: "pipe",
    ...(within === undefined ? {} : { timeout: within, killSignal: "SIGKILL" }),
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { status, output: `${stdout}${stderr}`.trim(), killed: proc.signalCode !== null };
}

async function textOf(path: string): Promise<string> {
  return existsSync(path) ? await readFile(path, "utf8") : "";
}

/**
 * Whether `pid` is a live `program` process. Read from /proc rather than probed
 * with signal 0, because a pid the server once had can belong to anything by
 * the time a stop reads it, and a stop must never signal that. Redis rewrites
 * its title into one space-separated argument, so the program is the first
 * word of the first argument.
 */
export function runs(pid: number, program: string): boolean {
  let cmdline: string;
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch (error) {
    // The process exited between the pid being read and its entry being opened.
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
  const first = cmdline.split("\0")[0]?.split(" ")[0] ?? "";
  return basename(first) === program;
}

/**
 * Tries ports until `launch` reports one ready, and answers it. `launch`
 * reports `taken` when the server lost the port to another process before it
 * could bind; anything else it throws.
 */
async function onFreshPort(
  server: ServerName,
  allocate: Allocate,
  launch: (port: number) => Promise<"ready" | "taken">,
): Promise<number> {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const port = allocate(server);
    if ((await launch(port)) === "ready") return port;
  }
  throw new Error(
    `${server} found every one of ${ATTEMPTS} allocated ports taken before it could bind`,
  );
}

/**
 * Reads a daemonized server's log until it says which way its bind went:
 * `ready`, `taken`, or what it said by the time it aborted or READY_MS ran out.
 */
async function settled(
  log: string,
  says: { readonly ready: RegExp; readonly taken: RegExp; readonly aborted: RegExp },
): Promise<"ready" | "taken" | { readonly said: string }> {
  const deadline = Date.now() + READY_MS;
  let said = await textOf(log);
  while (Date.now() < deadline) {
    if (says.ready.test(said)) return "ready";
    if (says.taken.test(said)) return "taken";
    if (says.aborted.test(said)) break;
    await Bun.sleep(50);
    said = await textOf(log);
  }
  return { said };
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
  const port = await onFreshPort("redis", allocate, async (candidate) => {
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
    const outcome = await settled(log, {
      ready: /Ready to accept connections/,
      taken: /Address already in use/,
      aborted: /aborting/,
    });
    if (typeof outcome === "string") return outcome;
    throw new Error(
      `redis-server did not become ready on 127.0.0.1:${candidate}:\n${outcome.said}`,
    );
  });
  return `redis://127.0.0.1:${port}`;
}

/**
 * The options every mysqld run here takes, initialisation included. No
 * option file is read, so nothing the image's own instance is configured with
 * reaches this one. `secure_file_priv` is NULL because its packaged default
 * names a directory under the system instance's. The X Protocol listener is
 * off because it binds every interface on its own port.
 */
function mysqlOptions(root: string, log: string): string[] {
  return [
    "--no-defaults",
    `--datadir=${join(root, "mysql")}`,
    `--log-error=${log}`,
    "--secure-file-priv=NULL",
    "--mysqlx=OFF",
  ];
}

/**
 * Root's password is made here, per start, and leaves only in the URL: the
 * server listens on the loopback every local account shares. The init file
 * sets it before the server takes its first connection, on every launch.
 */
async function startMysql(root: string, allocate: Allocate): Promise<string> {
  const initLog = join(root, "mysql-init.log");
  const initialised = await run(
    ["mysqld", ...mysqlOptions(root, initLog), "--initialize-insecure"],
    READY_MS,
  );
  if (initialised.status !== 0) {
    const said = await textOf(initLog);
    throw new Error(`mysqld --initialize-insecure failed: ${initialised.output}\n${said}`);
  }

  const password = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex");
  const initFile = join(root, "mysql-init.sql");
  await Bun.write(initFile, `ALTER USER 'root'@'localhost' IDENTIFIED BY '${password}';\n`);
  await chmod(initFile, 0o600);

  // Durability is off because nothing here outlives the job. The launch is
  // bounded because a daemonizing mysqld's parent waits for its child to come
  // up, and a child hung there would otherwise hold the step to the job's limit.
  const port = await onFreshPort("mysql", allocate, async (candidate) => {
    const log = join(root, `mysql-${candidate}.log`);
    const launched = await run(
      [
        "mysqld",
        ...mysqlOptions(root, log),
        "--bind-address=127.0.0.1",
        `--port=${candidate}`,
        `--socket=${join(root, "mysql.sock")}`,
        `--pid-file=${join(root, "mysql.pid")}`,
        `--init-file=${initFile}`,
        "--skip-log-bin",
        "--innodb-flush-log-at-trx-commit=0",
        "--daemonize",
      ],
      READY_MS,
    );
    if (launched.killed) {
      throw new Error(
        `mysqld did not daemonize within ${READY_MS / 1000}s on 127.0.0.1:${candidate}:\n${await textOf(log)}`,
      );
    }
    const outcome = await settled(log, {
      ready: /ready for connections/,
      taken: /Address already in use/,
      aborted: /Aborting/,
    });
    if (typeof outcome === "string") return outcome;
    throw new Error(
      `mysqld did not become ready on 127.0.0.1:${candidate}: ${launched.output}\n${outcome.said}`,
    );
  });
  return `mysql://root:${password}@127.0.0.1:${port}/mysql`;
}

const POSTGRES: Server = {
  name: "postgres",
  label: "PostgreSQL 16",
  binaries: ["initdb", "pg_ctl", "postgres"],
  version: { binary: "postgres", pattern: /\(PostgreSQL\) 16\./ },
  output: "database-url",
  pidFile: join("postgres", "postmaster.pid"),
  program: "postgres",
  // Postgres's immediate shutdown.
  stopSignal: "SIGQUIT",
  start: startPostgres,
};

const REDIS: Server = {
  name: "redis",
  label: "Redis 7",
  binaries: ["redis-server"],
  version: { binary: "redis-server", pattern: /\bv=7\./ },
  output: "redis-url",
  pidFile: "redis.pid",
  program: "redis-server",
  stopSignal: "SIGTERM",
  start: startRedis,
};

const MYSQL: Server = {
  name: "mysql",
  label: "MySQL 8.0",
  binaries: ["mysqld"],
  version: { binary: "mysqld", pattern: /\bVer 8\.0\./ },
  output: "mysql-url",
  pidFile: "mysql.pid",
  program: "mysqld",
  stopSignal: "SIGTERM",
  start: startMysql,
};

/** Every server, in start order; a stop takes them down in the reverse. */
const SERVERS: readonly Server[] = [POSTGRES, REDIS, MYSQL];

/** The servers a start runs: PostgreSQL and Redis always, MySQL when asked. */
export function selected(asked: { readonly mysql: boolean }): readonly Server[] {
  return SERVERS.filter((server) => server !== MYSQL || asked.mysql);
}

/**
 * The selected servers' binaries, on PATH, at the majors their rows name. A
 * runner carrying Postgres 17 would grade every repo's migrations against a
 * server its production does not run, and say nothing.
 */
async function located(servers: readonly Server[]): Promise<void> {
  const missing = servers.flatMap((server) =>
    server.binaries.filter((name) => Bun.which(name) === null),
  );
  if (missing.length > 0) {
    const wanted = servers.map((server) => `${server.label}'s ${server.binaries.join(", ")}`);
    throw new Error(
      `the runner has no ${missing.join(", ")} on PATH — this action runs ${wanted.join("; ")} from the job's PATH`,
    );
  }
  for (const server of servers) {
    const answer = await run([server.version.binary, "--version"]);
    if (!server.version.pattern.test(answer.output)) {
      const path = Bun.which(server.version.binary) ?? "";
      throw new Error(`${path} is not ${server.label}: ${answer.output}`);
    }
  }
}

/**
 * Starts `servers` under `root`, in order. `root` must not exist yet: a root
 * that does is a start that ran before and was never stopped, and starting
 * over it would leave the first servers running with nothing pointing at them.
 *
 * A start that fails partway leaves what it started under `root`, for `stop`
 * to take down — the job's `always()` step is the one place that cleans up,
 * whether this failed or a later step did.
 */
export async function start(
  root: string,
  servers: readonly Server[],
  allocate: Allocate = freePort,
): Promise<readonly Started[]> {
  if (existsSync(root)) {
    throw new Error(`${root} already exists — a start that was never stopped; run stop first`);
  }
  await located(servers);
  await mkdir(root, { recursive: true });
  const started: Started[] = [];
  for (const server of servers) {
    started.push({ server, url: await server.start(root, allocate) });
  }
  return started;
}

async function exited(pid: number, program: string, within: number): Promise<boolean> {
  const deadline = Date.now() + within;
  while (runs(pid, program) && Date.now() < deadline) await Bun.sleep(50);
  return !runs(pid, program);
}

/**
 * Signals the server whose pid its pid file names, and kills it if the signal
 * is not enough. A pid file naming no live process of that program is a server
 * already gone — crashed, never started or never asked for — and there is
 * nothing to do.
 */
async function terminate(root: string, server: Server): Promise<void> {
  const pid = Number.parseInt(await textOf(join(root, server.pidFile)), 10);
  if (Number.isNaN(pid) || !runs(pid, server.program)) return;
  process.kill(pid, server.stopSignal);
  if (await exited(pid, server.program, EXIT_MS)) return;
  process.kill(pid, "SIGKILL");
  if (!(await exited(pid, server.program, EXIT_MS))) {
    throw new Error(`${server.program} (pid ${pid}) is still running after SIGKILL`);
  }
}

/**
 * Stops whatever `start` left under `root` and deletes it. Nothing there is
 * the ordinary case of a job that failed before it started anything, and is
 * not an error: this runs under `always()`, and a second failure there would
 * bury the first.
 */
export async function stop(root: string): Promise<void> {
  if (!existsSync(root)) return;
  for (const server of SERVERS.toReversed()) await terminate(root, server);
  await rm(root, { recursive: true, force: true });
}
