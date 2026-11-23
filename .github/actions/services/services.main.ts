import { appendFile } from "node:fs/promises";

import { entry } from "../_lib/gate.ts";
import { selected, start, stop } from "./services.ts";

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
    const started = await start(root, selected({ mysql: mysql === "true" }));
    await appendFile(
      outputs,
      started.map(({ server, url }) => `${server.output}=${url}\n`).join(""),
    );
  } else if (command === "stop") {
    await stop(root);
  } else {
    throw new Error(`command must be start or stop, not '${command ?? ""}'`);
  }
});
