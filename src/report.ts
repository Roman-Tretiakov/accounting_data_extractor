export type Contract = {
  id: string;
  amountCents: bigint;
  signedAt: string;
};

export type Work = {
  id: string;
  contractId: string;
  title: string;
  priceCents: bigint;
  status: "planned" | "done" | "cancelled";
  completedAt: string | null;
  cancelledAt: string | null;
};

export type Payment = {
  id: string;
  contractId: string;
  workId: string | null;
  amountCents: bigint;
  status: "paid" | "queued" | "refunded";
  paidAt: string | null;
  refundedAt: string | null;
};

export type ReportRow = {
  work: string;
  contract: string;
  paidCents: bigint;
  remainingCents: bigint;
  kind: "work" | "contract";
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONEY_PATTERN = /^(\d+)(?:\.(\d{1,2}))?$/;
const HEADERS = ["Работа", "Договор", "Выплачено", "Остаток"];

function assertDate(value: string, label: string): string {
  if (!DATE_PATTERN.test(value)) {
    throw new Error(`${label}: ожидается дата в формате YYYY-MM-DD, получено "${value}"`);
  }

  const [year, month, day] = value.split("-").map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1];

  if (year === 0 || !daysInMonth || day < 1 || day > daysInMonth) {
    throw new Error(`${label}: некорректная дата "${value}"`);
  }
  return value;
}

export function parseReportDate(value: string): string {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value);
  if (!match) {
    throw new Error("Введите дату в формате ДД.ММ.ГГГГ.");
  }
  return assertDate(`${match[3]}-${match[2]}-${match[1]}`, "Дата отчёта");
}

function parseMoney(value: string, label: string): bigint {
  const match = MONEY_PATTERN.exec(value);
  if (!match) {
    throw new Error(`${label}: некорректная сумма "${value}"`);
  }
  return BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
}

function parseCsv(contents: string, filename: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let quoteClosed = false;

  for (let index = 0; index < contents.length; index += 1) {
    const character = contents[index];

    if (inQuotes) {
      if (character === '"') {
        if (contents[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
          quoteClosed = true;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (quoteClosed && character !== "," && character !== "\r" && character !== "\n") {
      throw new Error(`${filename}: неожиданный символ после закрывающей кавычки`);
    }

    if (character === '"') {
      if (field.length !== 0 || quoteClosed) {
        throw new Error(`${filename}: кавычка внутри некавыченного поля`);
      }
      inQuotes = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
      quoteClosed = false;
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && contents[index + 1] === "\n") {
        index += 1;
      }
      row.push(field);
      if (row.some((cell) => cell.length > 0)) {
        rows.push(row);
      }
      row = [];
      field = "";
      quoteClosed = false;
    } else {
      field += character;
    }
  }

  if (inQuotes) {
    throw new Error(`${filename}: незакрытая кавычка в CSV`);
  }
  if (field.length > 0 || row.length > 0 || quoteClosed) {
    row.push(field);
    if (row.some((cell) => cell.length > 0)) {
      rows.push(row);
    }
  }

  if (rows.length === 0) {
    throw new Error(`${filename}: файл пуст`);
  }
  rows[0][0] = rows[0][0].replace(/^\uFEFF/, "");
  return rows;
}

function records(
  contents: string,
  filename: string,
  requiredHeaders: string[],
): Array<Record<string, string>> {
  const rows = parseCsv(contents, filename);
  const headers = rows[0].map((header) => header.trim());
  const headerIndexes = new Map<string, number>();

  headers.forEach((header, index) => {
    if (headerIndexes.has(header)) {
      throw new Error(`${filename}: повторяется заголовок "${header}"`);
    }
    headerIndexes.set(header, index);
  });

  for (const header of requiredHeaders) {
    if (!headerIndexes.has(header)) {
      throw new Error(`${filename}: отсутствует колонка "${header}"`);
    }
  }

  return rows.slice(1).map((cells, rowIndex) => {
    if (cells.length !== headers.length) {
      throw new Error(
        `${filename}, строка ${rowIndex + 2}: ожидалось ${headers.length} колонок, получено ${cells.length}`,
      );
    }
    return Object.fromEntries(headers.map((header, index) => [header, cells[index].trim()]));
  });
}

function optionalDate(value: string, label: string): string | null {
  return value === "" ? null : assertDate(value, label);
}

export function parseContracts(contents: string): Contract[] {
  return records(contents, "contracts.csv", ["contract_id", "amount", "signed_at"]).map(
    (record, index) => ({
      id: record.contract_id,
      amountCents: parseMoney(record.amount, `contracts.csv, строка ${index + 2}, amount`),
      signedAt: assertDate(record.signed_at, `contracts.csv, строка ${index + 2}, signed_at`),
    }),
  );
}

export function parseWorks(contents: string): Work[] {
  return records(contents, "works.csv", [
    "work_id",
    "contract_id",
    "title",
    "price",
    "status",
    "completed_at",
    "cancelled_at",
  ]).map((record, index) => {
    const label = `works.csv, строка ${index + 2}`;
    const status = record.status;
    if (status !== "planned" && status !== "done" && status !== "cancelled") {
      throw new Error(`${label}: неизвестный статус "${status}"`);
    }
    const completedAt = optionalDate(record.completed_at, `${label}, completed_at`);
    const cancelledAt = optionalDate(record.cancelled_at, `${label}, cancelled_at`);
    if (status === "done" && completedAt === null) {
      throw new Error(`${label}: у работы со статусом done не указана completed_at`);
    }
    if (status === "cancelled" && cancelledAt === null) {
      throw new Error(`${label}: у отменённой работы не указана cancelled_at`);
    }
    return {
      id: record.work_id,
      contractId: record.contract_id,
      title: record.title,
      priceCents: parseMoney(record.price, `${label}, price`),
      status,
      completedAt,
      cancelledAt,
    };
  });
}

export function parsePayments(contents: string): Payment[] {
  return records(contents, "payments.csv", [
    "payment_id",
    "contract_id",
    "work_id",
    "amount",
    "status",
    "paid_at",
    "refunded_at",
  ]).map((record, index) => {
    const label = `payments.csv, строка ${index + 2}`;
    const status = record.status;
    if (status !== "paid" && status !== "queued" && status !== "refunded") {
      throw new Error(`${label}: неизвестный статус "${status}"`);
    }
    const paidAt = optionalDate(record.paid_at, `${label}, paid_at`);
    const refundedAt = optionalDate(record.refunded_at, `${label}, refunded_at`);
    if (status !== "queued" && paidAt === null) {
      throw new Error(`${label}: у проведённого платежа не указана paid_at`);
    }
    if (status === "refunded" && refundedAt === null) {
      throw new Error(`${label}: у возвращённого платежа не указана refunded_at`);
    }
    return {
      id: record.payment_id,
      contractId: record.contract_id,
      workId: record.work_id === "" ? null : record.work_id,
      amountCents: parseMoney(record.amount, `${label}, amount`),
      status,
      paidAt,
      refundedAt,
    };
  });
}

function validateReferences(
  contracts: Contract[],
  works: Work[],
  payments: Payment[],
): void {
  const contractIds = new Set<string>();
  for (const contract of contracts) {
    if (contract.id === "" || contractIds.has(contract.id)) {
      throw new Error(`contracts.csv: пустой или повторяющийся contract_id "${contract.id}"`);
    }
    contractIds.add(contract.id);
  }

  const worksById = new Map<string, Work>();
  for (const work of works) {
    if (work.id === "" || worksById.has(work.id)) {
      throw new Error(`works.csv: пустой или повторяющийся work_id "${work.id}"`);
    }
    if (!contractIds.has(work.contractId)) {
      throw new Error(`works.csv: работа ${work.id} ссылается на неизвестный договор ${work.contractId}`);
    }
    worksById.set(work.id, work);
  }

  const paymentIds = new Set<string>();
  for (const payment of payments) {
    if (payment.id === "" || paymentIds.has(payment.id)) {
      throw new Error(`payments.csv: пустой или повторяющийся payment_id "${payment.id}"`);
    }
    if (!contractIds.has(payment.contractId)) {
      throw new Error(
        `payments.csv: платёж ${payment.id} ссылается на неизвестный договор ${payment.contractId}`,
      );
    }
    if (payment.workId !== null) {
      const work = worksById.get(payment.workId);
      if (!work) {
        throw new Error(`payments.csv: платёж ${payment.id} ссылается на неизвестную работу ${payment.workId}`);
      }
      if (work.contractId !== payment.contractId) {
        throw new Error(
          `payments.csv: договор платежа ${payment.id} не совпадает с договором работы ${payment.workId}`,
        );
      }
    }
    paymentIds.add(payment.id);
  }
}

function paidByDate(payment: Payment, asOfDate: string): boolean {
  return (
    payment.status !== "queued" &&
    payment.paidAt !== null &&
    payment.paidAt <= asOfDate &&
    !(payment.status === "refunded" && payment.refundedAt !== null && payment.refundedAt <= asOfDate)
  );
}

function distributeProportionally(
  amountCents: bigint,
  balances: bigint[],
): bigint[] {
  const allocations = balances.map(() => 0n);
  const totalBalance = balances.reduce((sum, balance) => sum + balance, 0n);
  const amountToAllocate = amountCents < totalBalance ? amountCents : totalBalance;

  if (amountToAllocate <= 0n || totalBalance <= 0n) {
    return allocations;
  }

  const remainders: Array<{ index: number; remainder: bigint }> = [];
  let allocated = 0n;

  balances.forEach((balance, index) => {
    const numerator = amountToAllocate * balance;
    allocations[index] = numerator / totalBalance;
    allocated += allocations[index];
    remainders.push({ index, remainder: numerator % totalBalance });
  });

  remainders.sort((left, right) => {
    if (left.remainder === right.remainder) {
      return left.index - right.index;
    }
    return left.remainder > right.remainder ? -1 : 1;
  });

  let centsLeft = amountToAllocate - allocated;
  for (const { index } of remainders) {
    if (centsLeft === 0n) {
      break;
    }
    allocations[index] += 1n;
    centsLeft -= 1n;
  }
  return allocations;
}

export function buildReport(
  contracts: Contract[],
  works: Work[],
  payments: Payment[],
  asOfDate: string,
): ReportRow[] {
  assertDate(asOfDate, "Дата отчёта");
  validateReferences(contracts, works, payments);

  const report: ReportRow[] = [];
  for (const contract of contracts) {
    if (contract.signedAt > asOfDate) {
      continue;
    }

    const contractWorks = works.filter(
      (work) =>
        work.contractId === contract.id &&
        work.status === "done" &&
        work.completedAt !== null &&
        work.completedAt <= asOfDate,
    );
    const contractPayments = payments.filter(
      (payment) => payment.contractId === contract.id && paidByDate(payment, asOfDate),
    );
    const totalPaid = contractPayments.reduce((sum, payment) => sum + payment.amountCents, 0n);

    const directPayments = new Map<string, bigint>();
    let unlinkedPayments = 0n;
    for (const payment of contractPayments) {
      if (payment.workId === null) {
        unlinkedPayments += payment.amountCents;
      } else if (contractWorks.some((work) => work.id === payment.workId)) {
        directPayments.set(
          payment.workId,
          (directPayments.get(payment.workId) ?? 0n) + payment.amountCents,
        );
      }
    }

    const directApplied = contractWorks.map((work) => {
      const direct = directPayments.get(work.id) ?? 0n;
      return direct < work.priceCents ? direct : work.priceCents;
    });
    const balances = contractWorks.map((work, index) => work.priceCents - directApplied[index]);
    const allocatedGeneral = distributeProportionally(unlinkedPayments, balances);

    contractWorks.forEach((work, index) => {
      const paid = directApplied[index] + allocatedGeneral[index];
      report.push({
        work: work.id,
        contract: contract.id,
        paidCents: paid,
        remainingCents: work.priceCents - paid,
        kind: "work",
      });
    });

    const totalWorkPrice = contractWorks.reduce((sum, work) => sum + work.priceCents, 0n);
    report.push({
      work: `Итого, по договору ${contract.id}:`,
      contract: "",
      paidCents: totalPaid,
      remainingCents: totalWorkPrice - totalPaid,
      kind: "contract",
    });
  }
  return report;
}

export function formatMoney(cents: bigint): string {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const rubles = absolute / 100n;
  const kopecks = (absolute % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${rubles}.${kopecks}`;
}

function escapeCsv(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function renderCsv(rows: ReportRow[]): string {
  const lines = [
    HEADERS.join(","),
    ...rows.map((row) =>
      [
        row.work,
        row.contract,
        formatMoney(row.paidCents),
        formatMoney(row.remainingCents),
      ]
        .map(escapeCsv)
        .join(","),
    ),
  ];
  return `${lines.join("\r\n")}\r\n`;
}

export function renderConsoleTable(rows: ReportRow[]): string {
  const cells = rows.map((row) => [
    row.work,
    row.contract,
    formatMoney(row.paidCents),
    formatMoney(row.remainingCents),
  ]);
  const widths = HEADERS.map((header, column) =>
    Math.max(header.length, ...cells.map((row) => row[column].length)),
  );
  const border = `+${widths.map((width) => "-".repeat(width + 2)).join("+")}+`;
  const renderRow = (row: string[]) =>
    `|${row.map((cell, index) => ` ${cell.padEnd(widths[index])} `).join("|")}|`;

  return [
    border,
    renderRow(HEADERS),
    border,
    ...cells.map(renderRow),
    border,
  ].join("\n");
}
