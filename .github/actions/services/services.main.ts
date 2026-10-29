import { appendFile } from "node:fs/promises";

import { entry } from "../_lib/gate.ts";
import { start, stop } from "./services.ts";

await entry(async () => {
  const [command, root, outputs] = Bun.argv.slice(2);
  if (root === undefined || outputs === undefined) {
    throw new Error("usage: services.main.ts start|stop <root> <outputs file>");
  }
  if (command === "start") {
    const services = await start(root);
    await appendFile(
      outputs,
      `database-url=${services.databaseUrl}\nredis-url=${services.redisUrl}\n`,
    );
  } else if (command === "stop") {
    await stop(root);
  } else {
    throw new Error(`command must be start or stop, not '${command ?? ""}'`);
  }
});
