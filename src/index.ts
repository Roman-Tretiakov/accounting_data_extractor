import { access, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { resolve } from "node:path";
import {
  buildReport,
  parseContracts,
  parsePayments,
  parseReportDate,
  parseWorks,
  renderConsoleTable,
  renderCsv,
} from "./report.ts";

const inputFiles = ["contracts.csv", "works.csv", "payments.csv"];

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function askUntilValid(
  ask: (question: string) => Promise<string>,
  question: string,
  parse: (answer: string) => string | null,
): Promise<string> {
  while (true) {
    const answer = (await ask(question)).trim();
    const result = parse(answer);
    if (result !== null) {
      return result;
    }
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function readInputFiles(directory: string): Promise<[string, string, string]> {
  const missingFiles = (
    await Promise.all(
      inputFiles.map(async (filename) =>
        (await fileExists(resolve(directory, filename))) ? null : filename,
      ),
    )
  ).filter((filename): filename is string => filename !== null);

  if (missingFiles.length > 0) {
    throw new Error(
      `В папке "${directory}" отсутствуют входные файлы: ${missingFiles.join(", ")}`,
    );
  }

  const [contracts, works, payments] = await Promise.all([
    readFile(resolve(directory, "contracts.csv"), "utf8"),
    readFile(resolve(directory, "works.csv"), "utf8"),
    readFile(resolve(directory, "payments.csv"), "utf8"),
  ]);
  return [contracts, works, payments];
}

async function main(): Promise<void> {
  const workingDirectory = process.cwd();
  const outputFile = resolve(workingDirectory, "result_accouting.csv");
  const [contractsText, worksText, paymentsText] = await readInputFiles(workingDirectory);
  const prompt = createInterface({ input: stdin, output: stdout });
  let keepConsoleOpen = false;
  try {
    const dateText = await askUntilValid(
      (question) => prompt.question(question),
      "Введите дату отчёта (ДД.ММ.ГГГГ): ",
      (answer) => {
        try {
          return parseReportDate(answer);
        } catch (error) {
          stdout.write(`${error instanceof Error ? error.message : String(error)}\n`);
          return null;
        }
      },
    );

    const outputChoice = await askUntilValid(
      (question) => prompt.question(question),
      "Куда вывести отчёт? [1] CSV-файл [2] таблица в консоли: ",
      (answer) => {
        if (answer === "1") {
          return "csv";
        }
        if (answer === "2") {
          return "console";
        }
        stdout.write("Введите 1 или 2.\n");
        return null;
      },
    );

    if (outputChoice === "csv" && (await fileExists(outputFile))) {
      const overwrite = await askUntilValid(
        (question) => prompt.question(question),
        "Файл result_accouting.csv уже существует. Заменить его? [д/н]: ",
        (answer) => {
          const normalized = answer.toLocaleLowerCase("ru-RU");
          if (["д", "да", "y", "yes"].includes(normalized)) {
            return "yes";
          }
          if (["н", "нет", "n", "no"].includes(normalized)) {
            return "no";
          }
          stdout.write("Введите «д» или «н».\n");
          return null;
        },
      );
      if (overwrite === "no") {
        stdout.write("Формирование отчёта отменено; существующий файл не изменён.\n");
        return;
      }
    }

    const report = buildReport(
      parseContracts(contractsText),
      parseWorks(worksText),
      parsePayments(paymentsText),
      dateText,
    );

    if (outputChoice === "console") {
      stdout.write(`${renderConsoleTable(report)}\n`);
      keepConsoleOpen = true;
    } else {
      await writeFile(outputFile, renderCsv(report), { encoding: "utf8", flag: "w" });
      stdout.write(`Отчёт сохранён: ${outputFile}\n`);
    }
  } finally {
    if (!keepConsoleOpen) {
      prompt.close();
    }
  }
}

main().catch((error: unknown) => {
  stderrWrite(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

function stderrWrite(message: string): void {
  process.stderr.write(`Ошибка: ${message}\n`);
}
