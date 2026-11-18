import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const projectDirectory = process.cwd();
const sampleDirectory = resolve(projectDirectory, "test_task_data");
const scriptPath = resolve(projectDirectory, "src", "index.ts");
const executablePath = resolve(projectDirectory, "dist", "accounting_data_extractor.exe");
const outputFile = resolve(sampleDirectory, "result_accouting.csv");

async function runCli(
  outputChoice: "1" | "2",
  overwriteChoice?: "д" | "н",
  workingDirectory = sampleDirectory,
  executable?: string,
): Promise<{ code: number | null; output: string; errors: string }> {
  const child = spawn(
    executable ?? process.execPath,
    executable ? [] : ["--experimental-strip-types", scriptPath],
    { cwd: workingDirectory, stdio: ["pipe", "pipe", "pipe"] },
  );
  let output = "";
  let errors = "";
  let dateSent = false;
  let modeSent = false;
  let overwriteSent = false;

  const result = await new Promise<{ code: number | null }>((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (!dateSent && output.includes("Введите дату отчёта")) {
        dateSent = true;
        child.stdin.write("10.11.2026\n");
      }
      if (!modeSent && output.includes("таблица в консоли:")) {
        modeSent = true;
        child.stdin.write(`${outputChoice}\n`);
      }
      if (!overwriteSent && overwriteChoice && output.includes("уже существует")) {
        overwriteSent = true;
        child.stdin.write(`${overwriteChoice}\n`);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errors += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code }));
  });

  return { ...result, output, errors };
}

async function runConsoleCli(executable?: string): Promise<{
  code: number | null;
  output: string;
  errors: string;
  stayedOpen: boolean;
}> {
  const child = spawn(
    executable ?? process.execPath,
    executable ? [] : ["--experimental-strip-types", scriptPath],
    { cwd: sampleDirectory, stdio: ["pipe", "pipe", "pipe"] },
  );
  let output = "";
  let errors = "";
  let dateSent = false;
  let modeSent = false;
  let reportSeen = false;
  let resolveReport!: () => void;
  let rejectReport!: (error: Error) => void;
  const reportPrinted = new Promise<void>((resolve, reject) => {
    resolveReport = resolve;
    rejectReport = reject;
  });
  const closed = new Promise<{ code: number | null }>((resolve) => {
    child.once("close", (code) => resolve({ code }));
  });

  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    if (!dateSent && output.includes("Введите дату отчёта")) {
      dateSent = true;
      child.stdin.write("10.11.2026\n");
    }
    if (!modeSent && output.includes("таблица в консоли:")) {
      modeSent = true;
      child.stdin.write("2\n");
    }
    if (output.includes("Итого, по договору D-2:")) {
      reportSeen = true;
      resolveReport();
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    errors += chunk.toString();
  });
  child.on("error", rejectReport);
  child.once("close", () => {
    if (!reportSeen) {
      rejectReport(new Error(`CLI exited before printing the report: ${output}\n${errors}`));
    }
  });

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      reportPrinted,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Timed out waiting for console report")), 5000);
      }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const stayedOpen = child.exitCode === null;
    if (stayedOpen) {
      child.kill();
    }
    const { code } = await closed;
    return { code, output, errors, stayedOpen };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    if (child.exitCode === null) {
      child.kill();
    }
    await closed;
  }
}

test("keeps the console open after printing the sample report", async () => {
  const result = await runConsoleCli();
  assert.equal(result.stayedOpen, true, result.errors);
  assert.match(result.output, /W-11\s+\|\s+D-1/);
  assert.match(result.output, /Итого, по договору D-1:/);
  assert.match(result.output, /315000\.00\s+\|\s+-15000\.00/);
  assert.match(result.output, /Итого, по договору D-2:/);
  assert.match(result.output, /75000\.00\s+\|\s+-25000\.00/);
});

test("writes CSV and leaves it unchanged when overwrite is declined", async (t) => {
  if (existsSync(outputFile)) {
    t.skip("result_accouting.csv already exists");
    return;
  }

  try {
    const firstRun = await runCli(
      "1",
      undefined,
      sampleDirectory,
      existsSync(executablePath) ? executablePath : undefined,
    );
    assert.equal(firstRun.code, 0, firstRun.errors);
    assert.match(firstRun.output, /Отчёт сохранён:/);
    const original = await readFile(outputFile);

    const secondRun = await runCli(
      "1",
      "н",
      sampleDirectory,
      existsSync(executablePath) ? executablePath : undefined,
    );
    assert.equal(secondRun.code, 0, secondRun.errors);
    assert.match(secondRun.output, /Формирование отчёта отменено/);
    assert.deepEqual(await readFile(outputFile), original);
  } finally {
    if (existsSync(outputFile)) {
      await unlink(outputFile);
    }
  }
});

test("reports missing input filenames before asking for report options", async () => {
  const result = await runCli("2", undefined, projectDirectory);
  assert.equal(result.code, 1);
  assert.match(result.errors, /contracts\.csv/);
  assert.match(result.errors, /works\.csv/);
  assert.match(result.errors, /payments\.csv/);
  assert.doesNotMatch(result.output, /Введите дату отчёта/);

  if (process.platform === "win32" && existsSync(executablePath)) {
    const packaged = await runCli("2", undefined, projectDirectory, executablePath);
    assert.equal(packaged.code, 1);
    assert.match(packaged.errors, /contracts\.csv/);
    assert.match(packaged.errors, /works\.csv/);
    assert.match(packaged.errors, /payments\.csv/);
    assert.doesNotMatch(packaged.output, /Введите дату отчёта/);
  }
});

test("the packaged Windows executable stays open after printing the report", async (t) => {
  if (process.platform !== "win32" || !existsSync(executablePath)) {
    t.skip("Windows executable is not available");
    return;
  }

  const result = await runConsoleCli(executablePath);
  assert.equal(result.stayedOpen, true, result.errors);
  assert.match(result.output, /Итого, по договору D-1:/);
  assert.match(result.output, /315000\.00\s+\|\s+-15000\.00/);
});
