import { required } from "../.github/actions/_lib/gate.ts";

/**
 * The Postgres the database suites create and drop their own databases on,
 * refused rather than defaulted — the same refusal `TEST_REDIS_URL` carries,
 * for what turns out to be the same reason.
 *
 * A default of `localhost:5432` is a host address some stack may be publishing
 * on a machine that runs the fleet's stacks, and what this suite does to
 * whatever answers is `create database` and `drop database`. Free today is not a property to build on, and
 * a suite that guesses is one bind away from dropping databases it does not
 * own.
 *
 * One reader rather than four copies of the same string: four suites drifting
 * apart on which server they mean is how one of them keeps a default nobody
 * remembered to take away.
 */
export const SERVER = required(
  "TEST_DATABASE_URL",
  'the database suites create and drop databases on the server they are given, so they will not guess at one — point them at a throwaway (README\'s "Gating this repo" has the one-liner)',
);
