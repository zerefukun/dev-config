import { report } from "../.github/actions/_lib/gate.ts";
import { packageManager } from "../package.json";
import { bunBelowFloor } from "./bun-floor.ts";

const floor = /^bun@(.+)$/.exec(packageManager)?.[1];
if (floor === undefined) {
  throw new Error(`package.json's packageManager reads ${packageManager}, which names no Bun`);
}

const problem = bunBelowFloor(Bun.version, floor);
report(problem === undefined ? [] : [{ file: "package.json", message: problem }]);
