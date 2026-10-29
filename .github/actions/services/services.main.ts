import { appendFile } from "node:fs/promises";

import { entry, required } from "../_lib/gate.ts";
import { start, stop } from "./services.ts";

await entry(async () => {
  const [command, root, outputs] = Bun.argv.slice(2);
  if (root === undefined || outputs === undefined) {
    throw new Error("usage: services.main.ts start|stop <root> <outputs file>");
  }
  const path = required("PATH", "the server binaries are looked up on it");
  if (command === "start") {
    const services = await start(root, path);
    await appendFile(
      outputs,
      `database-url=${services.databaseUrl}\nredis-url=${services.redisUrl}\n`,
    );
  } else if (command === "stop") {
    await stop(root, path);
  } else {
    throw new Error(`command must be start or stop, not '${command ?? ""}'`);
  }
});
