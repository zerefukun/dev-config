/**
 * Why the running Bun cannot run this repo's `check` chain, or nothing when it
 * can. Below 1.4.4 `bun check --no-script` is not the type checker: the flag is
 * unknown and the words run the repo's own `check` script, which runs
 * `typecheck` again, so the chain recurses without end instead of failing.
 */
export function bunBelowFloor(running: string, floor: string): string | undefined {
  if (Bun.semver.order(running, floor) >= 0) return undefined;
  return `Bun ${running} is running and this repo needs ${floor} or later (package.json's packageManager): on an older Bun, bun check --no-script runs the check script again and the chain never ends`;
}
