import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReport,
  formatMoney,
  parseReportDate,
  renderCsv,
  type Contract,
  type Payment,
  type Work,
} from "../src/report.ts";

const contract: Contract = {
  id: "D-1",
  amountCents: 30000_00n,
  signedAt: "2026-01-01",
};

function work(
  id: string,
  priceCents: bigint,
  status: Work["status"] = "done",
  completedAt: string | null = "2026-01-02",
): Work {
  return {
    id,
    contractId: "D-1",
    title: id,
    priceCents,
    status,
    completedAt,
    cancelledAt: null,
  };
}

function payment(
  id: string,
  amountCents: bigint,
  workId: string | null,
  paidAt: string,
  status: Payment["status"] = "paid",
  refundedAt: string | null = null,
): Payment {
  return {
    id,
    contractId: "D-1",
    workId,
    amountCents,
    status,
    paidAt,
    refundedAt,
  };
}

test("filters works and payments as of the report date and shows contract overpayment", () => {
  const works = [
    work("W-1", 10_000n),
    work("W-2", 20_000n),
    work("W-3", 40_000n, "done", "2026-02-11"),
    work("W-4", 50_000n, "planned", null),
    work("W-5", 60_000n, "cancelled", null),
  ];
  works[4].cancelledAt = "2026-02-01";
  const payments = [
    payment("P-1", 1_000n, "W-1", "2026-02-01"),
    payment("P-2", 8_000n, null, "2026-02-02"),
    payment("P-3", 4_000n, null, "2026-02-03", "refunded", "2026-02-12"),
    payment("P-4", 50_000n, null, "2026-02-11"),
    payment("P-5", 90_000n, null, "2026-02-01", "queued"),
    payment("P-6", 70_000n, null, "2026-02-01", "refunded", "2026-02-05"),
  ];

  const report = buildReport([contract], works, payments, "2026-02-10");

  assert.deepEqual(
    report.map((row) => [row.work, row.contract, row.paidCents, row.remainingCents]),
    [
      ["W-1", "D-1", 4_724n, 5_276n],
      ["W-2", "D-1", 8_276n, 11_724n],
      ["Итого, по договору D-1:", "", 13_000n, 17_000n],
    ],
  );
});

test("includes a zero-work contract summary and counts its paid advance as overpayment", () => {
  const futureContract = { ...contract, signedAt: "2026-01-01" };
  const report = buildReport(
    [futureContract],
    [work("W-1", 10_000n, "planned", null)],
    [payment("P-1", 2_500n, null, "2026-02-01")],
    "2026-02-10",
  );

  assert.equal(report.length, 1);
  assert.equal(report[0].work, "Итого, по договору D-1:");
  assert.equal(report[0].paidCents, 2_500n);
  assert.equal(report[0].remainingCents, -2_500n);
});

test("allocates proportional cents by largest remainder and breaks ties by source order", () => {
  const works = [work("W-1", 1n), work("W-2", 2n)];
  const report = buildReport(
    [contract],
    works,
    [payment("P-1", 1n, null, "2026-02-01")],
    "2026-02-10",
  );

  assert.deepEqual(report.slice(0, 2).map((row) => row.paidCents), [0n, 1n]);

  const tied = buildReport(
    [contract],
    [work("W-1", 1n), work("W-2", 1n)],
    [payment("P-1", 1n, null, "2026-02-01")],
    "2026-02-10",
  );
  assert.deepEqual(tied.slice(0, 2).map((row) => row.paidCents), [1n, 0n]);
});

test("parses strict report dates and formats negative balances to kopecks", () => {
  assert.equal(parseReportDate("10.11.2026"), "2026-11-10");
  assert.throws(() => parseReportDate("31.02.2026"));
  assert.throws(() => parseReportDate("2026-11-10"));
  assert.equal(formatMoney(-1n), "-0.01");
});

test("writes the requested CSV columns and escapes the subtotal label", () => {
  const csv = renderCsv([
    {
      work: "Итого, по договору D-1:",
      contract: "",
      paidCents: 1_000n,
      remainingCents: -1n,
      kind: "contract",
    },
  ]);
  assert.equal(
    csv,
    'Работа,Договор,Выплачено,Остаток\r\n"Итого, по договору D-1:",,10.00,-0.01\r\n',
  );
});
