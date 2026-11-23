import { appendFile } from "node:fs/promises";

import { entry } from "../_lib/gate.ts";
import { freePort, start, stop } from "./services.ts";

await entry(async () => {
  const [command, root, outputs, mysql] = Bun.argv.slice(2);
  if (root === undefined || outputs === undefined) {
    throw new Error(
      "usage: services.main.ts start <root> <outputs file> true|false, or stop <root> <outputs file>",
    );
  }
  if (command === "start") {
    if (mysql !== "true" && mysql !== "false") {
      throw new Error(`mysql must be true or false, not '${mysql ?? ""}'`);
    }
    const services = await start(root, freePort, { mysql: mysql === "true" });
    const lines = [`database-url=${services.databaseUrl}`, `redis-url=${services.redisUrl}`];
    if (services.mysqlUrl !== undefined) lines.push(`mysql-url=${services.mysqlUrl}`);
    await appendFile(outputs, `${lines.join("\n")}\n`);
  } else if (command === "stop") {
    await stop(root);
  } else {
    throw new Error(`command must be start or stop, not '${command ?? ""}'`);
  }
});
