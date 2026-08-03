import { describe, it, expect } from "vitest";
import { compile, compileAndRun, createLibc } from "@compy/libc";
import { Console, Memory, Syscalls } from "@compy/runtime";
import { optimize } from "@compy/ir";
import { codegen, Simulator, AllocStrategy } from "@compy/codegen";
import { lowerSource, runModule } from "../../ir/src/harness";
import { LESSONS } from "./lessons";
import { EXAMPLES } from "./examples";

/**
 * Every lesson example and every example program must compile without errors
 * and behave identically on all three engines: the tree-walking interpreter,
 * the optimised IR interpreter, and the RISC-V simulator. Programs that are
 * deliberately buggy (name contains "bug", or category 'Bugs') may fault, so
 * for those we only require the tree-walker and the machine to agree on stdout.
 */

type Files = Record<string, string>;

interface Outcome {
  stdout: string;
  stderr: string;
  exit: number;
}

const ARGV = ["prog"];

/** Programs that read stdin get a line of input so nothing is uninitialised. */
function stdinFor(files: Files): string {
  return Object.values(files).some((src) => src.includes("scanf")) ? "7\n" : "";
}

function runTreeWalker(
  files: Files,
  stdin: string,
): Outcome & { diagnostics: string[] } {
  const r = compileAndRun({ files, stdin, argv: ARGV });
  const diagnostics = r.diagnostics
    .filter((d) => d.severity === "error")
    .map((d) => d.message);
  return {
    stdout: r.stdout,
    stderr: r.stderr,
    exit: r.result?.exitCode ?? -1,
    diagnostics,
  };
}

function runOptimizedIr(files: Files, stdin: string): Outcome {
  const { module, errors } = lowerSource(files);
  if (errors.length) throw new Error("lowering failed: " + errors.join("; "));
  return runModule(optimize(module).module, files, stdin, ARGV);
}

function runMachine(
  files: Files,
  stdin: string,
  opt: boolean,
  strategy: AllocStrategy,
): Outcome {
  const { module, errors } = lowerSource(files);
  if (errors.length) throw new Error("lowering failed: " + errors.join("; "));
  const ir = opt ? optimize(module).module : module;
  const cg = codegen(ir, { strategy });
  const c = compile(files);
  const con = new Console();
  if (stdin) con.feed(stdin);
  con.closeInput();
  const sys = new Syscalls(c.vfs, con);
  const sim = new Simulator(cg.mmod, ir, {
    console: con,
    vfs: c.vfs,
    syscalls: sys,
    memory: new Memory(),
    natives: createLibc(),
    argv: ARGV,
  });
  const r = sim.run();
  return { stdout: con.stdout(), stderr: con.stderr(), exit: r.exitCode };
}

function isBugDemo(name: string, category: string): boolean {
  return /\bbug\b|\(bug!\)/i.test(name) || category === "Bugs";
}

/** The full cross-engine check for a correct program. */
function expectAllEnginesAgree(files: Files) {
  const stdin = stdinFor(files);
  const tw = runTreeWalker(files, stdin);
  expect(tw.diagnostics, "compile errors").toEqual([]);
  expect(tw.stderr, "tree-walker stderr").toBe("");
  expect(tw.exit, "tree-walker exit code").toBe(0);

  const ir = runOptimizedIr(files, stdin);
  expect(ir.stderr, "optimised IR stderr").toBe("");
  expect(ir.stdout, "optimised IR stdout").toBe(tw.stdout);
  expect(ir.exit, "optimised IR exit code").toBe(tw.exit);

  const mcO2 = runMachine(files, stdin, true, "linear-scan");
  expect(mcO2.stderr, "machine (O2, linear scan) stderr").toBe("");
  expect(mcO2.stdout, "machine (O2, linear scan) stdout").toBe(tw.stdout);
  expect(mcO2.exit, "machine (O2, linear scan) exit code").toBe(tw.exit);

  const mcO0 = runMachine(files, stdin, false, "naive");
  expect(mcO0.stderr, "machine (O0, naive) stderr").toBe("");
  expect(mcO0.stdout, "machine (O0, naive) stdout").toBe(tw.stdout);
  expect(mcO0.exit, "machine (O0, naive) exit code").toBe(tw.exit);
}

/** The relaxed check for a deliberate bug demo: it may fault, but stdout must match. */
function expectBugDemoAgrees(files: Files) {
  const stdin = stdinFor(files);
  const tw = runTreeWalker(files, stdin);
  expect(tw.diagnostics, "compile errors").toEqual([]);
  const mc = runMachine(files, stdin, true, "linear-scan");
  expect(mc.stdout, "machine stdout").toBe(tw.stdout);
}

describe("lessons", () => {
  it("have unique ids and well-formed content", () => {
    const ids = LESSONS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const l of LESSONS) {
      expect(l.id, `${l.title} id`).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(l.body.length, `${l.id} body paragraphs`).toBeGreaterThanOrEqual(
        3,
      );
      expect(l.body.length, `${l.id} body paragraphs`).toBeLessThanOrEqual(6);
      expect(l.tryThis.length, `${l.id} tryThis`).toBeGreaterThanOrEqual(2);
      expect(l.tryThis.length, `${l.id} tryThis`).toBeLessThanOrEqual(4);
      expect(
        l.example.trimEnd().split("\n").length,
        `${l.id} example length`,
      ).toBeLessThan(40);
      for (const p of l.body)
        expect(p, `${l.id} body has no markdown headers`).not.toMatch(/^#/);
    }
  });

  it("cover every phase in order", () => {
    const order = [
      "lex",
      "preprocess",
      "parse",
      "sema",
      "ir",
      "opt",
      "codegen",
      "run",
    ];
    const seen = LESSONS.map((l) => order.indexOf(l.phase));
    expect(seen.every((p) => p >= 0)).toBe(true);
    for (let i = 1; i < seen.length; i++)
      expect(
        seen[i]!,
        `lesson ${LESSONS[i]!.id} is out of phase order`,
      ).toBeGreaterThanOrEqual(seen[i - 1]!);
    expect(new Set(LESSONS.map((l) => l.phase)).size).toBe(order.length);
  });

  describe("examples run identically on all three engines", () => {
    for (const l of LESSONS) {
      it(l.id, () => expectAllEnginesAgree({ "main.c": l.example }));
    }
  });
});

describe("examples", () => {
  it("have unique names", () => {
    const names = EXAMPLES.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every lesson-backed example found its lesson", () => {
    for (const e of EXAMPLES) {
      for (const src of Object.values(e.files))
        expect(src, e.name).not.toContain("missing lesson");
    }
  });

  /**
   * Pre-existing examples that currently fail, with the reason. They run under
   * `it.fails`, so this list goes red (and must be trimmed) as soon as the
   * underlying problem is fixed.
   */
  const KNOWN_BROKEN: Record<string, string> = {};

  describe("run identically on all three engines", () => {
    for (const e of EXAMPLES) {
      const run = () => {
        if (isBugDemo(e.name, e.category)) expectBugDemoAgrees(e.files);
        else expectAllEnginesAgree(e.files);
      };
      const known = KNOWN_BROKEN[e.name];
      if (known)
        it.fails(`${e.category}: ${e.name} (known broken: ${known})`, run);
      else it(`${e.category}: ${e.name}`, run);
    }
  });
});
