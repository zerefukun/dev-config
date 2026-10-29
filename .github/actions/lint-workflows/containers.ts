import { isList, record } from "../_lib/gate.ts";

/**
 * Every place a workflow or action asks for a container runtime, named the way
 * a refusal has to name it: a job's `container`, each of its `services`, a step
 * running a `docker://` image, and an action whose `runs.using` is `docker`.
 * The fleet's runners have no runtime to give any of them — a server a job
 * needs comes from the runner's own binaries, as the services action starts
 * them.
 *
 * Read off the parsed document at exactly these depths: a walk would take an
 * action input that happens to be called `container`. An action referenced by
 * `owner/repo@sha` that is itself a Docker action is beyond what a read of
 * this repository can see.
 */
export function containersIn(document: unknown): string[] {
  const node = record(document);
  const jobs = Object.entries(record(node["jobs"])).flatMap(([name, body]) => {
    const job = record(body);
    return [
      ...(job["container"] === undefined ? [] : [`jobs.${name}.container`]),
      ...Object.keys(record(job["services"])).map((service) => `jobs.${name}.services.${service}`),
      ...dockerSteps(job["steps"], `jobs.${name}`),
    ];
  });
  const runs = record(node["runs"]);
  return [
    ...jobs,
    ...(runs["using"] === "docker" ? ["runs.using: docker"] : []),
    ...dockerSteps(runs["steps"], "runs"),
  ];
}

function dockerSteps(steps: unknown, at: string): string[] {
  return (isList(steps) ? steps : []).flatMap((step, index) => {
    const uses = record(step)["uses"];
    return typeof uses === "string" && uses.startsWith("docker://")
      ? [`${at}.steps[${index}] uses ${uses}`]
      : [];
  });
}
