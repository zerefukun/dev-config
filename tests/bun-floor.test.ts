import { describe, expect, test } from "bun:test";

import { bunBelowFloor } from "./bun-floor.ts";

// Regression: on Bun 1.4.0 `bun run check` recursed check -> typecheck -> check
// forever. The wrong implementations these kill are a guard that compares the
// versions as strings, refuses the floor itself, or lets an older Bun through.
describe("the Bun floor at the head of check", () => {
  test("refuses a Bun below the floor, naming both versions", () => {
    expect(bunBelowFloor("1.4.0", "1.4.4")).toContain("Bun 1.4.0 is running");
    expect(bunBelowFloor("1.4.0", "1.4.4")).toContain("needs 1.4.4 or later");
    expect(bunBelowFloor("1.4.3", "1.4.4")).toBeDefined();
  });

  test("lets the floor itself through", () => {
    expect(bunBelowFloor("1.4.4", "1.4.4")).toBeUndefined();
  });

  test("lets a later Bun through, compared as versions rather than text", () => {
    expect(bunBelowFloor("1.4.10", "1.4.4")).toBeUndefined();
    expect(bunBelowFloor("2.0.0", "1.4.4")).toBeUndefined();
  });
});
