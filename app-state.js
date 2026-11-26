"use strict";

const CURRENCIES = {
  USD: { exponent: 2 },
  AUD: { exponent: 2 },
  GBP: { exponent: 2 },
  EUR: { exponent: 2 },
  JPY: { exponent: 0 },
  BRL: { exponent: 2 }
};

const PLAN_MINOR = {
  essentials: { monthly: 699, annual: 6999 },
  plus: { monthly: 1499, annual: 14999 },
  premium: { monthly: 2199, annual: 21999 }
};

const OPEN_STORED = ["sent", "viewed", "partially_paid"];
const LEDGER_TODAY = "2026-11-26";
const QTY_SCALE = 10000n;
const MAX_QTY_BPS = 10000000000;
const MAX_RATE_MINOR = 1000000000000;

const SAMPLE_TRANSACTIONS = [
  { id: "in-nov8", date: "2026-11-08", amountMinor: 124000, currency: "USD", kind: "in", name: "Card payments", accountId: "chk", totalMinor: 124000, taxMinor: 9920 },
  { id: "in-nov21", date: "2026-11-21", amountMinor: 40000, currency: "USD", kind: "in", name: "Oak Street HOA", accountId: "chk" },
  { id: "out-lumber", date: "2026-11-18", amountMinor: 18640, currency: "USD", kind: "out", name: "Harbor Lumber", accountId: "card", category: "Materials" },
  { id: "out-fuel", date: "2026-11-16", amountMinor: 6412, currency: "USD", kind: "out", name: "Fuel", accountId: "card", category: "Travel" },
  { id: "out-paint", date: "2026-11-14", amountMinor: 16948, currency: "USD", kind: "out", name: "Paint store", accountId: "card", category: "Supplies" },
  { id: "in-jun", date: "2026-06-02", amountMinor: 200000, currency: "USD", kind: "in", name: "Spring jobs", accountId: "chk", totalMinor: 200000, taxMinor: 16000 },
  { id: "in-mar", date: "2026-03-15", amountMinor: 180000, currency: "USD", kind: "in", name: "March jobs", accountId: "chk", totalMinor: 180000, taxMinor: 14400 },
  { id: "in-aug", date: "2026-08-01", amountMinor: 436000, currency: "USD", kind: "in", name: "August jobs", accountId: "chk", totalMinor: 436000, taxMinor: 34880 }
];

const PERSONAL_TRANSACTIONS = [
  { id: "p-rent", date: "2026-11-01", amountMinor: 145000, currency: "USD", kind: "out", name: "Rent", accountId: "pchk", category: "Housing" },
  { id: "p-groceries", date: "2026-11-20", amountMinor: 8640, currency: "USD", kind: "out", name: "Market", accountId: "pcard", category: "Groceries" }
];

const SAMPLE_SUBSCRIPTIONS = [
  { businessId: "field", plan: "plus", cadence: "monthly", currency: "USD", started: "2026-01-01" },
  { businessId: "norte", plan: "essentials", cadence: "monthly", currency: "USD", started: "2026-03-01" },
  { businessId: "klein", plan: "premium", cadence: "annual", currency: "USD", started: "2026-02-01" }
];

function formatMoney(minor, currency) {
  const code = CURRENCIES[currency] ? currency : "USD";
  const exponent = CURRENCIES[code].exponent;
  const major = exponent === 0 ? minor : minor / 10 ** exponent;
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency: code,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent
  }).format(major);
}

function divRoundHalfUp(n, d) {
  const N = typeof n === "bigint" ? n : BigInt(n);
  const D = typeof d === "bigint" ? d : BigInt(d);
  if (N < 0n || D <= 0n) throw new Error("non_negative");
  const q = N / D;
  const r = N % D;
  const out = r * 2n >= D ? q + 1n : q;
  if (out > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("amount_out_of_range");
  return Number(out);
}

function allocateLargestRemainder(total, weights) {
  const T = BigInt(total);
  const W = weights.map((weight) => BigInt(weight));
  const sumW = W.reduce((sum, weight) => sum + weight, 0n);
  if (sumW === 0n || T === 0n) return weights.map(() => 0);
  const bases = W.map((weight) => (T * weight) / sumW);
  let left = T - bases.reduce((sum, base) => sum + base, 0n);
  const order = W.map((weight, idx) => ({ idx, rem: (T * weight) % sumW }))
    .sort((a, b) => (a.rem === b.rem ? a.idx - b.idx : (a.rem > b.rem ? -1 : 1)));
  const extra = Number(left);
  for (let i = 0; i < extra; i++) bases[order[i].idx] += 1n;
  return bases.map((base) => Number(base));
}

function movement(doc) {
  if (Array.isArray(doc.payments)) {
    let paid = 0;
    let refunded = 0;
    let transferred = 0;
    doc.payments.forEach((payment) => {
      const status = payment.status || "succeeded";
      if (status === "pending" || status === "processing") return;
      if (payment.kind === "refund") refunded += payment.amountMinor;
      else if (payment.kind === "transferred") transferred += payment.amountMinor;
      else if (status === "succeeded" || status === "refunded") paid += payment.amountMinor;
    });
    return { paid, refunded, transferred };
  }
  return {
    paid: doc.paidMinor || 0,
    refunded: doc.refundedMinor || 0,
    transferred: doc.transferredMinor || 0
  };
}

function taxParts(base, rates, inclusive) {
  if (!rates.length || base <= 0) {
    return { total: 0, parts: rates.map((rate) => ({ name: rate.name || "", bps: rate.bps, minor: 0 })) };
  }
  if (!inclusive) {
    const parts = rates.map((rate) => ({
      name: rate.name || "",
      bps: rate.bps,
      minor: divRoundHalfUp(BigInt(base) * BigInt(rate.bps), 10000n)
    }));
    return { total: parts.reduce((sum, part) => sum + part.minor, 0), parts };
  }
  const combined = rates.reduce((sum, rate) => sum + rate.bps, 0);
  const total = divRoundHalfUp(BigInt(base) * BigInt(combined), BigInt(10000 + combined));
  const split = allocateLargestRemainder(total, rates.map((rate) => rate.bps));
  return {
    total,
    parts: rates.map((rate, index) => ({ name: rate.name || "", bps: rate.bps, minor: split[index] }))
  };
}

function calculateDocument(doc) {
  if (!doc || !Array.isArray(doc.lines) || doc.lines.length === 0) {
    const balanceMinor = doc && doc.balanceMinor ? doc.balanceMinor : 0;
    const totalMinor = doc && doc.totalMinor != null ? doc.totalMinor : balanceMinor;
    const moved = doc ? movement(doc) : { paid: 0, refunded: 0, transferred: 0 };
    return {
      ok: true,
      stored: true,
      subtotalMinor: totalMinor,
      discountMinor: 0,
      taxMinor: doc && doc.taxMinor ? doc.taxMinor : 0,
      shippingMinor: 0,
      shippingTaxMinor: 0,
      totalMinor,
      paidMinor: moved.paid,
      refundedMinor: moved.refunded,
      transferredMinor: moved.transferred,
      balanceMinor,
      lines: []
    };
  }

  const discountBps = doc.discountBps || 0;
  const discountMinorInput = doc.discountMinor || 0;
  if (discountBps > 0 && discountMinorInput > 0) return { ok: false, error: "discount_conflict" };

  const priced = [];
  for (let i = 0; i < doc.lines.length; i++) {
    const line = doc.lines[i];
    if (line.header || line.rateMinor == null) continue;
    const qty = line.qtyBps;
    const rate = line.rateMinor;
    if (typeof qty !== "number" || typeof rate !== "number" || !Number.isSafeInteger(qty) || !Number.isSafeInteger(rate)) {
      return { ok: false, error: "bad_line" };
    }
    if (qty < 0 || rate < 0 || qty > MAX_QTY_BPS || rate > MAX_RATE_MINOR) return { ok: false, error: "amount_out_of_range" };
    const taxes = Array.isArray(line.taxes)
      ? line.taxes
      : (doc.taxBps ? [{ name: doc.taxName || "Tax", bps: doc.taxBps }] : []);
    if (taxes.length > 2 || taxes.some((tax) => !tax || tax.bps < 0 || !Number.isSafeInteger(tax.bps))) {
      return { ok: false, error: "bad_line" };
    }
    let extendedMinor;
    try {
      extendedMinor = divRoundHalfUp(BigInt(qty) * BigInt(rate), QTY_SCALE);
    } catch (error) {
      return { ok: false, error: "amount_out_of_range" };
    }
    priced.push({
      line,
      position: line.position != null ? line.position : i,
      extendedMinor,
      taxes
    });
  }

  const subtotalMinor = priced.reduce((sum, row) => sum + row.extendedMinor, 0);
  let discountMinor = 0;
  if (subtotalMinor > 0 && discountBps > 0) {
    discountMinor = Math.min(subtotalMinor, divRoundHalfUp(BigInt(subtotalMinor) * BigInt(discountBps), 10000n));
  } else if (subtotalMinor > 0 && discountMinorInput > 0) {
    discountMinor = Math.min(subtotalMinor, discountMinorInput);
  }

  const allocated = discountMinor > 0
    ? allocateLargestRemainder(discountMinor, priced.map((row) => row.extendedMinor))
    : priced.map(() => 0);
  const beforeTax = doc.discountBeforeTax !== false;
  const inclusive = doc.taxInclusive === true;
  let lineTaxMinor = 0;
  const lineResults = priced.map((row, index) => {
    const rawBase = beforeTax ? row.extendedMinor - allocated[index] : row.extendedMinor;
    const base = rawBase > 0 ? rawBase : 0;
    const parts = taxParts(base, row.taxes, inclusive);
    lineTaxMinor += parts.total;
    return {
      name: row.line.name || "",
      qtyBps: row.line.qtyBps,
      rateMinor: row.line.rateMinor,
      extendedMinor: row.extendedMinor,
      discountMinor: allocated[index],
      taxMinor: parts.total,
      taxes: parts.parts
    };
  });

  const shippingMinor = doc.shippingMinor || 0;
  if (shippingMinor < 0 || !Number.isSafeInteger(shippingMinor)) return { ok: false, error: "amount_out_of_range" };
  const shippingTaxes = Array.isArray(doc.shippingTaxes) ? doc.shippingTaxes : [];
  if (doc.shippingTaxable && shippingMinor > 0 && shippingTaxes.length === 0) {
    return { ok: false, error: "shipping_tax_required" };
  }
  let shippingTaxMinor = 0;
  if (doc.shippingTaxable && shippingMinor > 0) {
    if (shippingTaxes.some((tax) => !tax || tax.bps < 0)) return { ok: false, error: "bad_line" };
    shippingTaxes.forEach((tax) => {
      shippingTaxMinor += divRoundHalfUp(BigInt(shippingMinor) * BigInt(tax.bps), 10000n);
    });
  }

  const taxMinor = lineTaxMinor + shippingTaxMinor;
  const totalMinor = inclusive
    ? subtotalMinor - discountMinor + shippingMinor + shippingTaxMinor
    : subtotalMinor - discountMinor + lineTaxMinor + shippingMinor + shippingTaxMinor;
  const moved = movement(doc);
  const rawBalance = totalMinor - moved.paid + moved.refunded - moved.transferred;
  const balanceMinor = Math.min(totalMinor, Math.max(0, rawBalance));
  return {
    ok: true,
    stored: false,
    subtotalMinor,
    discountMinor,
    taxMinor,
    shippingMinor,
    shippingTaxMinor,
    totalMinor,
    paidMinor: moved.paid,
    refundedMinor: moved.refunded,
    transferredMinor: moved.transferred,
    balanceMinor,
    lines: lineResults
  };
}

function balanceOf(doc) {
  if (!doc) return 0;
  if (doc.lines && doc.lines.length) {
    const calc = calculateDocument(doc);
    if (calc.ok) return calc.balanceMinor;
  }
  return doc.balanceMinor || 0;
}

function isOpenInvoice(doc) {
  return doc.type === "invoice"
    && OPEN_STORED.indexOf(doc.stored) !== -1
    && !doc.closed
    && balanceOf(doc) > 0;
}

function outstandingByCurrency(docs) {
  const totals = {};
  docs.forEach((doc) => {
    if (!isOpenInvoice(doc)) return;
    totals[doc.currency] = (totals[doc.currency] || 0) + balanceOf(doc);
  });
  return totals;
}

function formatOutstanding(docs) {
  const totals = outstandingByCurrency(docs);
  const codes = Object.keys(totals);
  if (codes.length === 0) return formatMoney(0, "USD");
  return codes.map((code) => formatMoney(totals[code], code)).join(" · ");
}

function expenseTotal(expenses) {
  return expenses.reduce((sum, expense) => sum + expense.amountMinor, 0);
}

function filterDocuments(docs, type, query) {
  const needle = String(query || "").trim().toLowerCase();
  return docs.filter((doc) => {
    if (type && type !== "all" && doc.type !== type) return false;
    if (!needle) return true;
    const haystack = [doc.name, doc.number, doc.subtitle, doc.display].join(" ").toLowerCase();
    return haystack.indexOf(needle) !== -1;
  });
}

function statusAfterPayment(doc, balanceMinor, today) {
  if (balanceMinor === 0) return { stored: "paid", display: "Paid", chip: "paid" };
  const overdue = doc.due && today && String(doc.due) < String(today);
  if (overdue) return { stored: "partially_paid", display: "Overdue", chip: "overdue" };
  return { stored: "partially_paid", display: "Partial", chip: "partial" };
}

function applyDepositMatch(docs, invoiceId, amountMinor, today) {
  return docs.map((doc) => {
    if (doc.id !== invoiceId || doc.type !== "invoice") return doc;
    const current = balanceOf(doc);
    if (!(amountMinor > 0) || amountMinor > current) return doc;
    let next = doc;
    if (doc.lines && doc.lines.length) {
      next = Array.isArray(doc.payments)
        ? Object.assign({}, doc, { payments: doc.payments.concat([{ kind: "payment", amountMinor, status: "succeeded" }]) })
        : Object.assign({}, doc, { paidMinor: (doc.paidMinor || 0) + amountMinor });
      const calc = calculateDocument(next);
      if (!calc.ok) return doc;
      next = Object.assign({}, next, {
        balanceMinor: calc.balanceMinor,
        totalMinor: calc.totalMinor,
        taxMinor: calc.taxMinor
      });
    } else {
      next = Object.assign({}, doc, { balanceMinor: current - amountMinor });
    }
    return Object.assign({}, next, statusAfterPayment(doc, next.balanceMinor, today));
  });
}

function payInvoice(docs, invoiceId) {
  return docs.map((doc) => {
    if (doc.id !== invoiceId || doc.type !== "invoice") return doc;
    if (doc.lines && doc.lines.length) {
      const calc = calculateDocument(Object.assign({}, doc, { paidMinor: 0, payments: null }));
      const totalMinor = calc.ok ? calc.totalMinor : balanceOf(doc);
      return Object.assign({}, doc, {
        payments: null,
        paidMinor: totalMinor,
        balanceMinor: 0,
        totalMinor,
        taxMinor: calc.ok ? calc.taxMinor : (doc.taxMinor || 0),
        stored: "paid",
        display: "Paid",
        chip: "paid"
      });
    }
    return Object.assign({}, doc, {
      balanceMinor: 0,
      stored: "paid",
      display: "Paid",
      chip: "paid"
    });
  });
}

function planAmount(plan, cadence) {
  const prices = PLAN_MINOR[plan];
  if (!prices) return null;
  return cadence === "annual" ? prices.annual : prices.monthly;
}

function visibleBusinesses(actor, businesses) {
  if (!actor) return [];
  if (actor.role === "creator" || actor.role === "platform_admin") return businesses.slice();
  return businesses.filter((business) => business.ownerId === actor.id);
}

function grantPlatformAdmin(actor, users, targetId) {
  if (!actor || actor.role !== "creator") {
    return { ok: false, error: "creator_only" };
  }
  const target = users.find((user) => user.id === targetId);
  if (!target) return { ok: false, error: "missing" };
  if (target.role === "creator" || target.id === actor.id) {
    return { ok: false, error: "creator_locked" };
  }
  const next = users.map((user) => {
    if (user.id !== targetId) return user;
    return Object.assign({}, user, { role: "platform_admin" });
  });
  return { ok: true, users: next, audit: actor.name + " granted " + target.name + " platform admin" };
}

const FEATURES = [
  "dashboard-cards",
  "invoices",
  "estimates",
  "receipts",
  "document-search",
  "expenses",
  "receipt-photo",
  "invoice-scan",
  "file-upload",
  "auto-calculate",
  "late-fee",
  "recurring-invoice",
  "deposit-request",
  "duplicate-warning",
  "weekly-owed-note",
  "reports",
  "export-books",
  "tax-packet",
  "platform-revenue",
  "linked-bank",
  "linked-card",
  "assistant-confirm",
  "get-paid",
  "plans",
  "clients",
  "country-currency",
  "customer-language",
  "local-tax-name",
  "country-payment-methods",
  "offline-draft-sync",
  "pull-to-refresh",
  "two-factor",
  "authenticator-qr",
  "recovery-email",
  "recovery-qr",
  "account-type",
  "business-profile",
  "business-checking",
  "business-credit",
  "creator-console",
  "grant-admin"
];

const ACCOUNT_KINDS = ["personal", "business"];

const PLATFORM_FEATURES = ["platform-revenue", "creator-console", "grant-admin"];

const PERSONAL_FEATURES = [
  "dashboard-cards",
  "expenses",
  "receipt-photo",
  "invoice-scan",
  "file-upload",
  "auto-calculate",
  "reports",
  "export-books",
  "linked-bank",
  "linked-card",
  "assistant-confirm",
  "country-currency",
  "offline-draft-sync",
  "pull-to-refresh",
  "two-factor",
  "authenticator-qr",
  "recovery-email",
  "recovery-qr",
  "account-type"
];

const SHELLS = ["ios", "android", "windows", "pc"];

function featuresFor(shell) {
  if (SHELLS.indexOf(shell) === -1) return [];
  return FEATURES.slice();
}

function shellsShareFeatures(shells) {
  if (!shells.length) return false;
  const baseline = featuresFor(shells[0]).join("|");
  if (!baseline) return false;
  return shells.every((shell) => featuresFor(shell).join("|") === baseline);
}

function featuresForAccount(kind) {
  if (kind === "personal") return PERSONAL_FEATURES.slice();
  if (kind === "business") return FEATURES.filter((name) => PLATFORM_FEATURES.indexOf(name) === -1);
  return [];
}

function linkFinancialAccount(links, request, accountKind) {
  const current = Array.isArray(links) ? links : [];
  if (ACCOUNT_KINDS.indexOf(accountKind) === -1) return { links: current.slice(), added: false, reason: "bad_account" };
  if (!request || !request.name || (request.kind !== "Checking" && request.kind !== "Credit")) {
    return { links: current.slice(), added: false, reason: "bad_account" };
  }
  const holder = request.holder || "";
  if (holder !== accountKind) return { links: current.slice(), added: false, reason: "wrong_holder" };
  if (current.some((link) => link.name === request.name && link.holder === holder)) {
    return { links: current.slice(), added: false, reason: "duplicate" };
  }
  const next = current.concat([{
    id: request.id || ("link-" + (current.length + 1)),
    name: request.name,
    kind: request.kind,
    holder,
    mask: request.mask || "0007",
    balanceMinor: request.balanceMinor || 0,
    currency: request.currency || "USD"
  }]);
  return { links: next, added: true };
}

const TAX_NAMES = {
  US: { en: "Sales tax" },
  CA: { en: "Sales tax" },
  GB: { en: "VAT" },
  DE: { en: "VAT", de: "MwSt." },
  FR: { en: "VAT", fr: "TVA" },
  AU: { en: "GST" },
  NZ: { en: "GST" },
  SG: { en: "GST" },
  ES: { en: "IVA", es: "IVA" },
  MX: { en: "IVA", es: "IVA" },
  BR: { en: "IVA", pt: "IVA" },
  JP: { en: "Consumption tax", ja: "消費税" }
};

const CUSTOMER_COPY = {
  en: { languageName: "English", invoice: "Invoice", due: "Due", balance: "Balance due", pay: "Pay balance", total: "Total", paid: "Paid", dueNow: "Due now", dueLater: "Due later", weeklyTitle: "Who owes you this week", weeklyIntro: "These invoices are still open.", weeklyEmpty: "Nothing is open." },
  es: { languageName: "Español", invoice: "Factura", due: "Vence", balance: "Saldo pendiente", pay: "Pagar saldo", total: "Total", paid: "Pagado", dueNow: "Para pagar ahora", dueLater: "Para después", weeklyTitle: "Quién te debe esta semana", weeklyIntro: "Estas facturas siguen abiertas.", weeklyEmpty: "No hay facturas abiertas." },
  de: { languageName: "Deutsch", invoice: "Rechnung", due: "Fällig", balance: "Offener Betrag", pay: "Betrag zahlen", total: "Summe", paid: "Bezahlt", dueNow: "Jetzt fällig", dueLater: "Später fällig", weeklyTitle: "Wer Ihnen diese Woche schuldet", weeklyIntro: "Diese Rechnungen sind noch offen.", weeklyEmpty: "Keine offenen Rechnungen." },
  pt: { languageName: "Português", invoice: "Fatura", due: "Vence", balance: "Saldo em aberto", pay: "Pagar saldo", total: "Total", paid: "Pago", dueNow: "A pagar agora", dueLater: "A pagar depois", weeklyTitle: "Quem lhe deve esta semana", weeklyIntro: "Estas faturas ainda estão em aberto.", weeklyEmpty: "Não há faturas em aberto." },
  ja: { languageName: "日本語", invoice: "請求書", due: "期日", balance: "未払い残高", pay: "支払う", total: "合計", paid: "支払済", dueNow: "今回のお支払", dueLater: "残額", weeklyTitle: "今週の未払い", weeklyIntro: "これらの請求はまだ未払いです。", weeklyEmpty: "未払いの請求はありません。" }
};

const PAYMENT_METHODS = {
  US: ["card", "apple_pay", "google_pay", "ach"],
  CA: ["card", "apple_pay", "google_pay"],
  GB: ["card", "apple_pay", "google_pay"],
  DE: ["card", "apple_pay", "google_pay", "sepa"],
  FR: ["card", "apple_pay", "google_pay", "sepa"],
  AU: ["card", "apple_pay", "google_pay", "becs"],
  NZ: ["card", "apple_pay", "google_pay"],
  JP: ["card", "apple_pay", "google_pay"],
  BR: ["card", "pix"],
  MX: ["card", "apple_pay", "google_pay"],
  ES: ["card", "apple_pay", "google_pay"]
};

const DEMO_AUTH_CODE = "482913";
const RECOVERY_TOKEN = "RCVR-4K7M-9Q2P";
const LATE_FEE_BPS = 150;
const ISSUED_STORED = ["sent", "viewed", "partially_paid", "paid"];

function taxName(country, language) {
  const row = TAX_NAMES[country] || TAX_NAMES.US;
  return row[language] || row.en;
}

function customerInvoiceView(language, customerCountry) {
  const copy = CUSTOMER_COPY[language] || CUSTOMER_COPY.en;
  return {
    ownerLanguage: "en",
    languageName: copy.languageName,
    title: copy.invoice,
    due: copy.due,
    balance: copy.balance,
    pay: copy.pay,
    total: copy.total,
    paid: copy.paid,
    dueNow: copy.dueNow,
    dueLater: copy.dueLater,
    weeklyTitle: copy.weeklyTitle,
    weeklyIntro: copy.weeklyIntro,
    weeklyEmpty: copy.weeklyEmpty,
    taxName: taxName(customerCountry, language)
  };
}

function paymentMethods(country) {
  return (PAYMENT_METHODS[country] || ["card"]).slice();
}

function saveDraft(online, queue, draft) {
  if (online) return { queue: queue.slice(), savedId: draft.id, pending: false };
  return {
    queue: queue.concat([Object.assign({ pending: true }, draft)]),
    savedId: null,
    pending: true
  };
}

function syncDrafts(online, queue) {
  if (!online) return { queue: queue.slice(), synced: [] };
  return { queue: [], synced: queue.map((draft) => draft.id) };
}

function pullRefresh(distance, threshold) {
  return distance >= threshold;
}

function confirmTwoFactor(code) {
  if (code !== DEMO_AUTH_CODE) return { ok: false, enabled: false, error: "bad_code" };
  return { ok: true, enabled: true };
}

function recoverAccount(method, value, account) {
  if (method === "email") {
    const same = String(value || "").trim().toLowerCase() === String(account.email || "").toLowerCase();
    return same ? { ok: true } : { ok: false, error: "email_mismatch" };
  }
  if (method === "qr") {
    return value === account.recoveryToken ? { ok: true } : { ok: false, error: "bad_qr" };
  }
  return { ok: false, error: "unknown" };
}

function replyFor(key) {
  const replies = {
    owed: { label: "" },
    remind: { label: "Send reminder" },
    match: { label: "Match deposit" },
    sort: { label: "File receipt" },
    late: { label: "Add late fee" },
    recur: { label: "Create monthly draft" },
    deposit: { label: "Put 25% due now" },
    weekly: { label: "Send weekly note" }
  };
  return replies[key] || null;
}

function daysBetween(start, end) {
  const from = String(start || "").split("-").map(Number);
  const to = String(end || "").split("-").map(Number);
  if (from.length !== 3 || to.length !== 3 || from.some(isNaN) || to.some(isNaN)) return 0;
  const a = Date.UTC(from[0], from[1] - 1, from[2]);
  const b = Date.UTC(to[0], to[1] - 1, to[2]);
  return Math.round((b - a) / 86400000);
}

function addMonths(iso, count) {
  const parts = String(iso).split("-").map(Number);
  const utc = new Date(Date.UTC(parts[0], parts[1] - 1 + count, 1));
  const last = new Date(Date.UTC(utc.getUTCFullYear(), utc.getUTCMonth() + 1, 0)).getUTCDate();
  const day = Math.min(parts[2], last);
  const month = String(utc.getUTCMonth() + 1).padStart(2, "0");
  return utc.getUTCFullYear() + "-" + month + "-" + String(day).padStart(2, "0");
}

function lateFeeQuote(doc, today, rateBps) {
  const rate = rateBps == null ? LATE_FEE_BPS : rateBps;
  if (!doc || doc.type !== "invoice") return { ok: false, error: "not_invoice", feeMinor: 0, days: 0 };
  if (!doc.lines || !doc.lines.length) return { ok: false, error: "no_lines", feeMinor: 0, days: 0 };
  if (doc.lines.some((line) => line.kind === "late_fee")) return { ok: false, error: "already_applied", feeMinor: 0, days: 0 };
  if (OPEN_STORED.indexOf(doc.stored) === -1 || doc.closed) return { ok: false, error: "not_open", feeMinor: 0, days: 0 };
  if (!Number.isInteger(rate) || rate < 0) return { ok: false, error: "bad_rate", feeMinor: 0, days: 0 };
  const days = doc.due ? daysBetween(doc.due, today || LEDGER_TODAY) : 0;
  if (days <= 0) return { ok: true, feeMinor: 0, days: 0, rateBps: rate };
  const balanceMinor = balanceOf(doc);
  const feeMinor = balanceMinor > 0
    ? divRoundHalfUp(BigInt(balanceMinor) * BigInt(rate) * BigInt(days), 10000n * 30n)
    : 0;
  return { ok: true, feeMinor, days, rateBps: rate, balanceMinor };
}

function applyLateFee(docs, invoiceId, today, rateBps) {
  let applied = false;
  let feeMinor = 0;
  const next = docs.map((doc) => {
    if (doc.id !== invoiceId) return doc;
    const quote = lateFeeQuote(doc, today, rateBps);
    if (!quote.ok || quote.feeMinor <= 0) return doc;
    const lines = doc.lines.concat([{
      name: "Late fee",
      kind: "late_fee",
      qtyBps: 10000,
      rateMinor: quote.feeMinor,
      taxes: []
    }]);
    const draft = Object.assign({}, doc, { lines });
    const calc = calculateDocument(draft);
    if (!calc.ok) return doc;
    applied = true;
    feeMinor = quote.feeMinor;
    return Object.assign(draft, {
      balanceMinor: calc.balanceMinor,
      totalMinor: calc.totalMinor,
      taxMinor: calc.taxMinor
    });
  });
  return { docs: next, applied, feeMinor };
}

function depositRequest(doc, percent) {
  if (!doc || doc.type === "estimate") return { ok: false, error: "estimates_cannot_take_a_deposit" };
  if (doc.type !== "invoice") return { ok: false, error: "not_invoice" };
  if (doc.installmentCount) return { ok: false, error: "deposit_or_installments" };
  if (!Number.isInteger(percent) || percent < 10 || percent > 50) return { ok: false, error: "deposit_percent" };
  const calc = calculateDocument(doc);
  if (!calc.ok) return { ok: false, error: calc.error };
  if (doc.closed || doc.stored === "paid" || (doc.stored !== "draft" && calc.balanceMinor <= 0)) {
    return { ok: false, error: "nothing_due" };
  }
  const dueNowMinor = divRoundHalfUp(BigInt(calc.totalMinor) * BigInt(percent), 100n);
  return {
    ok: true,
    percent,
    totalMinor: calc.totalMinor,
    dueNowMinor,
    dueLaterMinor: calc.totalMinor - dueNowMinor
  };
}

function applyDepositRequest(docs, invoiceId, percent) {
  let applied = false;
  const next = docs.map((doc) => {
    if (doc.id !== invoiceId) return doc;
    const split = depositRequest(doc, percent);
    if (!split.ok) return doc;
    applied = true;
    return Object.assign({}, doc, {
      depositPercent: percent,
      dueNowMinor: split.dueNowMinor,
      dueLaterMinor: split.dueLaterMinor
    });
  });
  return { docs: next, applied };
}

function recurInvoice(doc, today, existingDocs) {
  if (!doc || doc.type !== "invoice") return { ok: false, error: "not_invoice" };
  const sourceLines = (doc.lines || []).filter((line) => line.kind !== "late_fee" && !line.header && line.rateMinor != null);
  if (!sourceLines.length) return { ok: false, error: "no_lines" };
  const lines = sourceLines.map((line) => Object.assign({}, line, {
    taxes: line.taxes ? line.taxes.map((tax) => Object.assign({}, tax)) : undefined
  }));
  const start = doc.due || today || LEDGER_TODAY;
  const floor = today || LEDGER_TODAY;
  let step = 1;
  let due = addMonths(start, step);
  while (due <= floor && step < 600) {
    step += 1;
    due = addMonths(start, step);
  }
  const id = "recur-" + doc.id + "-" + due;
  const already = Array.isArray(existingDocs) ? existingDocs.find((item) => item.id === id) : null;
  if (already) return { ok: false, error: "already_drafted", doc: already };
  const draft = {
    id,
    type: "invoice",
    name: doc.name,
    subtitle: doc.subtitle || "Monthly",
    number: "",
    stored: "draft",
    display: "Draft",
    chip: "draft",
    currency: doc.currency || "USD",
    closed: false,
    due,
    paidMinor: 0,
    payments: null,
    depositPercent: null,
    lines,
    go: "editor-draft"
  };
  const calc = calculateDocument(draft);
  if (!calc.ok) return { ok: false, error: calc.error };
  draft.totalMinor = calc.totalMinor;
  draft.balanceMinor = calc.balanceMinor;
  draft.taxMinor = calc.taxMinor;
  return { ok: true, doc: draft };
}

function issuedTotal(doc) {
  if (doc.lines && doc.lines.length) {
    const calc = calculateDocument(Object.assign({}, doc, { paidMinor: 0, payments: null, lateFeeMinor: 0 }));
    if (calc.ok) return calc.totalMinor;
  }
  return doc.totalMinor != null ? doc.totalMinor : (doc.balanceMinor || 0);
}

function duplicateWarning(docs, candidate, today) {
  if (!candidate || !candidate.name) return { warning: false, matches: [] };
  const total = issuedTotal(candidate);
  const bounds = periodBounds("week", today || LEDGER_TODAY);
  const name = String(candidate.name).trim().toLowerCase();
  const currency = candidate.currency || "USD";
  const matches = docs.filter((doc) => {
    if (doc.id === candidate.id) return false;
    if (doc.type !== "invoice") return false;
    if (ISSUED_STORED.indexOf(doc.stored) === -1) return false;
    if (!doc.sentOn || doc.sentOn < bounds.start || doc.sentOn > bounds.end) return false;
    if (String(doc.name || "").trim().toLowerCase() !== name) return false;
    if ((doc.currency || "USD") !== currency) return false;
    return issuedTotal(doc) === total;
  });
  return {
    warning: matches.length > 0,
    matches: matches.map((doc) => ({ id: doc.id, number: doc.number, name: doc.name }))
  };
}

function weeklyOwedNote(docs, language, today) {
  const view = customerInvoiceView(language, "US");
  const open = docs.filter(isOpenInvoice);
  const lines = open.map((doc) => [doc.name, doc.number].filter(Boolean).join(" · ") + " · " + formatMoney(balanceOf(doc), doc.currency));
  const bounds = periodBounds("week", today || LEDGER_TODAY);
  return {
    language: CUSTOMER_COPY[language] ? language : "en",
    ownerLanguage: "en",
    sent: false,
    title: view.weeklyTitle,
    body: open.length ? view.weeklyIntro + "\n" + lines.join("\n") : view.weeklyEmpty,
    start: bounds.start,
    end: bounds.end
  };
}

function confirmWeeklyNote(note) {
  if (!note || !note.body) return { ok: false, error: "empty" };
  return Object.assign({}, note, { ok: true, sent: true });
}

function shiftDate(iso, days) {
  const parts = String(iso).split("-").map(Number);
  const utc = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  utc.setUTCDate(utc.getUTCDate() + days);
  const month = String(utc.getUTCMonth() + 1).padStart(2, "0");
  const day = String(utc.getUTCDate()).padStart(2, "0");
  return utc.getUTCFullYear() + "-" + month + "-" + day;
}

function periodBounds(period, today) {
  const end = today || LEDGER_TODAY;
  if (period === "week") return { start: shiftDate(end, -6), end };
  if (period === "month") return { start: end.slice(0, 7) + "-01", end };
  if (period === "year") return { start: end.slice(0, 4) + "-01-01", end };
  if (period === "last_month") {
    const parts = end.split("-").map(Number);
    const cursor = new Date(Date.UTC(parts[0], parts[1] - 1, 1));
    cursor.setUTCDate(0);
    const month = String(cursor.getUTCMonth() + 1).padStart(2, "0");
    const day = String(cursor.getUTCDate()).padStart(2, "0");
    return { start: cursor.getUTCFullYear() + "-" + month + "-01", end: cursor.getUTCFullYear() + "-" + month + "-" + day };
  }
  return null;
}

function allocatedTax(tx) {
  if (!tx || !(tx.totalMinor > 0) || !tx.taxMinor) return 0;
  if (tx.kind !== "in" && tx.kind !== "refund") return 0;
  const portion = divRoundHalfUp(BigInt(tx.amountMinor) * BigInt(tx.taxMinor), BigInt(tx.totalMinor));
  return tx.kind === "refund" ? -portion : portion;
}

function expenseCategories(transactions, bounds, currency) {
  const totals = {};
  transactions.forEach((tx) => {
    if (tx.kind !== "out" || tx.currency !== currency) return;
    if (tx.date < bounds.start || tx.date > bounds.end) return;
    const category = tx.category || "Uncategorized";
    totals[category] = (totals[category] || 0) + tx.amountMinor;
  });
  return Object.keys(totals).sort().map((category) => ({ category, amountMinor: totals[category] }));
}

function taxPacket(transactions, period, today, currency, country) {
  const slice = periodTotals(transactions, period, today, currency);
  if (!slice) return null;
  return {
    ok: true,
    filesReturn: false,
    currency,
    taxName: taxName(country || "US", "en"),
    start: slice.start,
    end: slice.end,
    incomeMinor: slice.inMinor,
    expenseMinor: slice.outMinor,
    taxCollectedMinor: slice.taxMinor,
    categories: expenseCategories(transactions, slice, currency)
  };
}

function csvCell(value) {
  const text = String(value == null ? "" : value);
  const safe = /^[=+\-@\t\r]/.test(text) ? "'" + text : text;
  if (/[",\r\n]/.test(safe)) return "\"" + safe.replace(/"/g, "\"\"") + "\"";
  return safe;
}

function exportBooks(docs, transactions, period, today, currency, country) {
  const packet = taxPacket(transactions, period, today, currency, country);
  if (!packet) return { ok: false, error: "bad_period" };
  const lines = ["date,kind,name,category,currency,amount_minor,tax_minor"];
  const ledger = transactions.filter((tx) =>
    tx.currency === currency
    && tx.date >= packet.start
    && tx.date <= packet.end
    && (tx.kind === "in" || tx.kind === "out" || tx.kind === "refund")
  ).sort((a, b) => (a.date === b.date ? (a.id < b.id ? -1 : 1) : (a.date < b.date ? -1 : 1)));
  ledger.forEach((tx) => {
    lines.push([
      tx.date,
      tx.kind,
      csvCell(tx.name),
      csvCell(tx.category || ""),
      currency,
      tx.amountMinor,
      tx.kind === "out" ? 0 : allocatedTax(tx)
    ].join(","));
  });
  (docs || []).filter((doc) =>
    doc
    && doc.type === "invoice"
    && doc.currency === currency
    && doc.sentOn
    && doc.sentOn >= packet.start
    && doc.sentOn <= packet.end
  ).sort((a, b) => (a.sentOn < b.sentOn ? -1 : 1)).forEach((doc) => {
    const calc = calculateDocument(doc);
    lines.push([
      doc.sentOn,
      "invoice",
      csvCell(doc.name),
      csvCell(doc.number || ""),
      currency,
      issuedTotal(doc),
      calc.ok ? calc.taxMinor : 0
    ].join(","));
  });
  lines.push(["", "summary", "income", "", currency, packet.incomeMinor, packet.taxCollectedMinor].join(","));
  lines.push(["", "summary", "expenses", "", currency, packet.expenseMinor, 0].join(","));
  lines.push(["", "summary", "tax_collected", packet.taxName, currency, packet.taxCollectedMinor, packet.taxCollectedMinor].join(","));
  return {
    ok: true,
    filesReturn: false,
    filename: "simple-accountz-books-" + packet.start + "-to-" + packet.end + ".csv",
    csv: lines.join("\n"),
    start: packet.start,
    end: packet.end,
    packet
  };
}

function subscriptionCharges(subscriptions, today) {
  const end = today || LEDGER_TODAY;
  const charges = [];
  (subscriptions || []).forEach((sub) => {
    const amountMinor = planAmount(sub.plan, sub.cadence);
    if (amountMinor == null || !sub.started || sub.started > end) return;
    const step = sub.cadence === "annual" ? 12 : 1;
    let date = sub.started;
    let guard = 0;
    while (date <= end && guard < 240) {
      charges.push({
        businessId: sub.businessId,
        plan: sub.plan,
        cadence: sub.cadence,
        currency: sub.currency || "USD",
        date,
        amountMinor
      });
      date = addMonths(date, step);
      guard += 1;
    }
  });
  return charges;
}

function platformRevenue(subscriptions, period, today) {
  const bounds = periodBounds(period, today);
  if (!bounds) return null;
  const charges = subscriptionCharges(subscriptions, bounds.end).filter((charge) =>
    charge.date >= bounds.start && charge.date <= bounds.end
  );
  const currencies = {};
  charges.forEach((charge) => {
    if (!currencies[charge.currency]) currencies[charge.currency] = { totalMinor: 0, byPlan: {}, businessIds: {} };
    const bucket = currencies[charge.currency];
    bucket.totalMinor += charge.amountMinor;
    bucket.byPlan[charge.plan] = (bucket.byPlan[charge.plan] || 0) + charge.amountMinor;
    bucket.businessIds[charge.businessId] = (bucket.businessIds[charge.businessId] || 0) + charge.amountMinor;
  });
  return { start: bounds.start, end: bounds.end, charges, currencies };
}

function periodTotals(transactions, period, today, currency) {
  const bounds = periodBounds(period, today);
  if (!bounds) return null;
  let inMinor = 0;
  let outMinor = 0;
  let taxMinor = 0;
  transactions.forEach((tx) => {
    if (tx.currency !== currency) return;
    if (tx.date < bounds.start || tx.date > bounds.end) return;
    if (tx.kind === "in") inMinor += tx.amountMinor;
    if (tx.kind === "out") outMinor += tx.amountMinor;
    if (tx.kind === "refund") inMinor -= tx.amountMinor;
    if ((tx.kind === "in" || tx.kind === "refund") && tx.totalMinor > 0 && tx.taxMinor) {
      const portion = divRoundHalfUp(BigInt(tx.amountMinor) * BigInt(tx.taxMinor), BigInt(tx.totalMinor));
      taxMinor += tx.kind === "refund" ? -portion : portion;
    }
  });
  return {
    inMinor,
    outMinor,
    profitMinor: inMinor - outMinor,
    taxMinor,
    start: bounds.start,
    end: bounds.end
  };
}

const RECEIPT_PHOTO_MAX = 1500000;

function stageReceiptPhoto(photo) {
  if (photo === "sample") return { ok: true, source: "sample", photo: "sample", files: false };
  const text = String(photo || "");
  if (!/^data:image\/(jpeg|jpg|png|webp);base64,[a-z0-9+/=\s]+$/i.test(text)) {
    return { ok: false, error: "not_image", files: false };
  }
  if (text.length > RECEIPT_PHOTO_MAX) return { ok: false, error: "too_large", files: false };
  return { ok: true, source: "photo", photo: text, files: false };
}

function stageInvoiceScan(photo) {
  const staged = stageReceiptPhoto(photo);
  if (!staged.ok) return staged;
  return Object.assign({}, staged, { kind: "invoice", files: false });
}

function invoiceFromScan(scan, fields) {
  if (!scan || !scan.ok) return { ok: false, error: "no_scan", sent: false };
  const name = String(fields && fields.name || "").trim();
  const amountMinor = fields && fields.amountMinor;
  if (!name) return { ok: false, error: "client", sent: false };
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) return { ok: false, error: "bad_amount", sent: false };
  const date = fields.date || LEDGER_TODAY;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return {
    ok: true,
    sent: false,
    doc: {
      id: "scan-" + date + "-" + slug + "-" + amountMinor,
      type: "invoice",
      name: name,
      number: "",
      subtitle: "Scanned",
      stored: "draft",
      display: "Draft",
      chip: "draft",
      currency: fields.currency || "USD",
      balanceMinor: amountMinor,
      totalMinor: amountMinor,
      paidMinor: 0,
      due: date,
      closed: false,
      scan: scan.photo,
      go: "invoice-review"
    }
  };
}

function cleanFileName(name) {
  const raw = String(name || "").trim();
  if (!raw || raw.length > 120 || /[\\/]/.test(raw) || raw.charAt(0) === ".") return "";
  if (!/^[\w .\-()]+$/.test(raw)) return "";
  return raw;
}

function stageUpload(file) {
  const types = {
    pdf: "application/pdf",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    csv: "text/csv",
    txt: "text/plain"
  };
  if (!file) return { ok: false, error: "empty", files: false };
  const name = cleanFileName(file.name);
  if (!name) return { ok: false, error: "bad_name", files: false };
  const ext = name.split(".").pop().toLowerCase();
  const expected = types[ext];
  if (!expected) return { ok: false, error: "bad_type", files: false };
  const data = String(file.data || "");
  const jpegOk = expected === "image/jpeg" && data.indexOf("data:image/jpg;base64,") === 0;
  if (data.indexOf("data:" + expected + ";base64,") !== 0 && !jpegOk) {
    return { ok: false, error: "bad_type", files: false };
  }
  if (data.length > RECEIPT_PHOTO_MAX) return { ok: false, error: "too_large", files: false };
  return { ok: true, name: name, type: expected, data: data, size: data.length, files: false };
}

function addUpload(files, staged) {
  const current = Array.isArray(files) ? files : [];
  if (!staged || !staged.ok) return { files: current.slice(), added: false, reason: "not_ready" };
  if (current.some((item) => item.name === staged.name && item.type === staged.type)) {
    return { files: current.slice(), added: false, reason: "duplicate" };
  }
  return {
    files: current.concat([{
      id: "file-" + (current.length + 1),
      name: staged.name,
      type: staged.type,
      size: staged.size,
      data: staged.data
    }]),
    added: true
  };
}

function expensesFromLedger(transactions, currency) {
  return transactions.filter((tx) => tx.kind === "out" && (!currency || tx.currency === currency));
}

function addExpense(transactions, expense, businessCurrency) {
  if (!expense || !(expense.amountMinor > 0)) return { transactions, added: false, reason: "bad_amount" };
  if (businessCurrency && expense.currency !== businessCurrency) {
    return { transactions, added: false, reason: "currency_mismatch" };
  }
  const duplicate = transactions.some((tx) =>
    tx.kind === "out"
    && tx.date === expense.date
    && tx.name === expense.name
    && tx.amountMinor === expense.amountMinor
    && tx.currency === expense.currency
  );
  if (duplicate) return { transactions, added: false, reason: "duplicate" };
  const next = transactions.concat([Object.assign({
    id: "out-" + (transactions.length + 1),
    kind: "out"
  }, expense)]);
  return { transactions: next, added: true };
}

function linkDeposit(transactions, txnId, invoiceId, tax) {
  return transactions.map((tx) => {
    const copy = Object.assign({}, tx);
    if (tx.id !== txnId) return copy;
    copy.invoiceId = invoiceId;
    if (tax) {
      copy.taxMinor = tax.taxMinor || 0;
      copy.totalMinor = tax.totalMinor || 0;
    }
    return copy;
  });
}

function suggestDepositMatch(docs, transactions, deposit) {
  if (!deposit || deposit.invoiceId || deposit.kind !== "in") return null;
  const candidates = docs.filter((doc) =>
    isOpenInvoice(doc)
    && doc.currency === deposit.currency
    && doc.name === deposit.name
    && balanceOf(doc) >= deposit.amountMinor
  );
  if (candidates.length !== 1) return null;
  const doc = candidates[0];
  return {
    invoiceId: doc.id,
    amountMinor: deposit.amountMinor,
    balanceAfterMinor: balanceOf(doc) - deposit.amountMinor
  };
}

function recordCustomerPayment(docs, transactions, invoiceId, today) {
  const invoice = docs.find((doc) => doc.id === invoiceId);
  if (!invoice) return { docs, transactions, recordedMinor: 0 };
  const due = balanceOf(invoice);
  if (!(due > 0)) return { docs, transactions, recordedMinor: 0 };
  let cover = 0;
  const linked = transactions.map((tx) => {
    const copy = Object.assign({}, tx);
    if (copy.kind !== "in" || copy.invoiceId || copy.name !== invoice.name || copy.currency !== invoice.currency) return copy;
    if (cover + copy.amountMinor > due) return copy;
    cover += copy.amountMinor;
    copy.invoiceId = invoice.id;
    return copy;
  });
  const recordedMinor = due - cover;
  let next = linked;
  if (recordedMinor > 0) {
    const calc = calculateDocument(invoice);
    next = linked.concat([{
      id: "pay-" + invoiceId + "-" + (today || LEDGER_TODAY),
      date: today || LEDGER_TODAY,
      amountMinor: recordedMinor,
      currency: invoice.currency,
      kind: "in",
      name: invoice.name,
      accountId: "chk",
      invoiceId: invoice.id,
      taxMinor: calc.ok ? calc.taxMinor : 0,
      totalMinor: calc.ok ? calc.totalMinor : due
    }]);
  }
  return { docs: payInvoice(docs, invoiceId), transactions: next, recordedMinor };
}

function parseDecimalToScale(text, scale) {
  const raw = String(text == null ? "" : text).trim().replace(/[$,\s]/g, "");
  if (raw === "") return { ok: true, value: 0 };
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(raw)) return { ok: false, error: "bad_amount" };
  const bits = raw.split(".");
  if (bits[0] === "") bits[0] = "0";
  const frac = bits[1] || "";
  const keep = frac.slice(0, scale);
  const extra = frac.slice(scale);
  const padded = keep.padEnd(scale, "0");
  let value = Number(bits[0]) * (10 ** scale) + (padded ? Number(padded) : 0);
  if (extra.length && extra[0] >= "5") value += 1;
  if (!Number.isSafeInteger(value)) return { ok: false, error: "amount_out_of_range" };
  return { ok: true, value };
}

function formatQty(qtyBps) {
  const qty = qtyBps > 0 ? qtyBps : 0;
  const whole = Math.floor(qty / 10000);
  const frac = String(qty % 10000).padStart(4, "0").replace(/0+$/, "");
  return frac ? whole + "." + frac : String(whole);
}

// ---- Live web app: real invoices, real dates, books saved on the device ----

const BOOKS_KEY = "simpleaccountz.books.v1";

function todayIso(date) {
  const d = date || new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function nextInvoiceNumber(docs) {
  let top = 1000;
  (docs || []).forEach((doc) => {
    const match = /^INV-(\d+)$/.exec(String(doc.number || ""));
    if (match) top = Math.max(top, Number(match[1]));
  });
  return "INV-" + (top + 1);
}

function statusFor(doc, today) {
  if (doc.type !== "invoice") return { display: doc.display, chip: doc.chip };
  if (doc.stored === "draft") return { display: "Draft", chip: "draft" };
  if (doc.stored === "paid" || balanceOf(doc) <= 0) return { display: "Paid", chip: "paid" };
  if (doc.due && today && doc.due < today) return { display: "Overdue", chip: "overdue" };
  if (doc.stored === "partially_paid") return { display: "Partial", chip: "partial" };
  return { display: "Sent", chip: "sent" };
}

function createInvoice(docs, fields, today) {
  const f = fields || {};
  const name = String(f.name || "").trim();
  if (!name) return { ok: false, error: "client" };
  const qtyBps = f.qtyBps;
  const rateMinor = f.rateMinor;
  if (!Number.isSafeInteger(qtyBps) || qtyBps <= 0 || !Number.isSafeInteger(rateMinor) || rateMinor <= 0) {
    return { ok: false, error: "line" };
  }
  const taxBps = Number.isSafeInteger(f.taxBps) && f.taxBps > 0 ? f.taxBps : 0;
  const day = today || todayIso();
  const number = nextInvoiceNumber(docs);
  const doc = {
    id: "inv-" + number.slice(4),
    type: "invoice",
    name,
    email: String(f.email || "").trim(),
    number,
    subtitle: String(f.description || "").trim() || "Services",
    stored: "draft",
    currency: f.currency || "USD",
    closed: false,
    created: day,
    due: /^\d{4}-\d{2}-\d{2}$/.test(String(f.due || "")) ? f.due : shiftDate(day, 14),
    paidMinor: 0,
    lines: [{
      name: String(f.description || "").trim() || "Services",
      qtyBps,
      rateMinor,
      taxes: taxBps ? [{ name: f.taxName || "Tax", bps: taxBps }] : []
    }],
    go: "doc-view"
  };
  const calc = calculateDocument(doc);
  if (!calc.ok) return { ok: false, error: calc.error };
  Object.assign(doc, { totalMinor: calc.totalMinor, balanceMinor: calc.balanceMinor, taxMinor: calc.taxMinor }, statusFor(doc, day));
  return { ok: true, doc, docs: (docs || []).concat([doc]) };
}

function markSent(docs, invoiceId, today) {
  let sent = false;
  const next = (docs || []).map((doc) => {
    if (doc.id !== invoiceId || doc.type !== "invoice") return doc;
    if (!doc.name || !(balanceOf(doc) > 0) || doc.closed) return doc;
    if (doc.stored !== "draft") { sent = true; return doc; }
    sent = true;
    const updated = Object.assign({}, doc, { stored: "sent", sentOn: today || todayIso() });
    return Object.assign(updated, statusFor(updated, today));
  });
  return { docs: next, sent };
}

function refreshStatuses(docs, today) {
  return (docs || []).map((doc) => {
    if (doc.type !== "invoice" || doc.go !== "doc-view") return doc;
    const status = statusFor(doc, today);
    return status.display === doc.display && status.chip === doc.chip ? doc : Object.assign({}, doc, status);
  });
}

function invoiceText(doc, businessName) {
  if (!doc) return "";
  const calc = calculateDocument(doc);
  const total = calc.ok ? calc.totalMinor : (doc.totalMinor || 0);
  const lines = [
    (businessName || "Simple Accountz") + " · Invoice " + (doc.number || ""),
    "Bill to: " + doc.name
  ];
  (doc.lines || []).forEach((line) => {
    const amount = divRoundHalfUp(BigInt(line.qtyBps) * BigInt(line.rateMinor), QTY_SCALE);
    lines.push(line.name + " · " + formatQty(line.qtyBps) + " × " + formatMoney(line.rateMinor, doc.currency) + " = " + formatMoney(amount, doc.currency));
  });
  if (calc.ok && calc.taxMinor) lines.push("Tax: " + formatMoney(calc.taxMinor, doc.currency));
  lines.push("Total: " + formatMoney(total, doc.currency));
  lines.push("Balance due: " + formatMoney(balanceOf(doc), doc.currency) + (doc.due ? " by " + prettyDate(doc.due) : ""));
  return lines.join("\n");
}

function reminderText(doc, businessName) {
  if (!doc) return "";
  return "Hello " + doc.name + ",\n\nA friendly reminder that invoice " + (doc.number || "") + " for "
    + formatMoney(balanceOf(doc), doc.currency) + (doc.due ? " was due " + prettyDate(doc.due) : " is open")
    + ".\n\nThank you,\n" + (businessName || "");
}

function mailtoLink(email, subject, body) {
  const to = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(String(email || "")) ? email : "";
  return "mailto:" + encodeURIComponent(to).replace(/%40/g, "@")
    + "?subject=" + encodeURIComponent(subject || "") + "&body=" + encodeURIComponent(body || "");
}

function emptyBooks() {
  return {
    version: 1,
    businessName: "",
    accountKind: "business",
    docs: [],
    business: [],
    personal: [],
    uploads: [],
    autoMode: true,
    autoHandled: [],
    autoSkip: []
  };
}

function serializeBooks(state) {
  const base = emptyBooks();
  const s = state || {};
  return JSON.stringify({
    version: 1,
    businessName: String(s.businessName || ""),
    accountKind: ACCOUNT_KINDS.indexOf(s.accountKind) !== -1 ? s.accountKind : base.accountKind,
    docs: Array.isArray(s.docs) ? s.docs : [],
    business: Array.isArray(s.business) ? s.business : [],
    personal: Array.isArray(s.personal) ? s.personal : [],
    uploads: Array.isArray(s.uploads) ? s.uploads : [],
    autoMode: s.autoMode !== false,
    autoHandled: Array.isArray(s.autoHandled) ? s.autoHandled : [],
    autoSkip: Array.isArray(s.autoSkip) ? s.autoSkip : []
  });
}

function restoreBooks(text) {
  const base = emptyBooks();
  if (!text) return base;
  let raw;
  try { raw = JSON.parse(text); } catch (error) { return base; }
  if (!raw || typeof raw !== "object" || raw.version !== 1) return base;
  const arr = (value) => (Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : []);
  return {
    version: 1,
    businessName: typeof raw.businessName === "string" ? raw.businessName.slice(0, 80) : "",
    accountKind: ACCOUNT_KINDS.indexOf(raw.accountKind) !== -1 ? raw.accountKind : "business",
    docs: arr(raw.docs).filter((doc) => typeof doc.id === "string" && typeof doc.type === "string"),
    business: arr(raw.business).filter((tx) => typeof tx.id === "string" && Number.isSafeInteger(tx.amountMinor)),
    personal: arr(raw.personal).filter((tx) => typeof tx.id === "string" && Number.isSafeInteger(tx.amountMinor)),
    uploads: arr(raw.uploads),
    autoMode: raw.autoMode !== false,
    autoHandled: Array.isArray(raw.autoHandled) ? raw.autoHandled.filter((item) => typeof item === "string") : [],
    autoSkip: Array.isArray(raw.autoSkip) ? raw.autoSkip.filter((item) => typeof item === "string") : []
  };
}

// A new expense goes on the card linked to the account you are in, so a
// personal receipt shows under the personal card, not the business card.
function expenseAccountId(links, accountKind) {
  const own = (Array.isArray(links) ? links : []).filter((link) => link.holder === accountKind);
  const card = own.find((link) => link.kind === "Credit") || own[0];
  if (card) return card.id;
  return accountKind === "personal" ? "pcard" : "card";
}

// Each account keeps its own books. Save the open ledger back before switching,
// so matched deposits and new expenses survive a trip to the other account.
function switchAccountBooks(books, fromKind, toKind, current) {
  const store = Object.assign({}, books);
  if (ACCOUNT_KINDS.indexOf(fromKind) !== -1 && Array.isArray(current)) store[fromKind] = current;
  if (ACCOUNT_KINDS.indexOf(toKind) === -1) return { books: store, transactions: current, kind: fromKind };
  return { books: store, transactions: store[toKind] || [], kind: toKind };
}

const AUTO_CATEGORY_RULES = [
  [/lumber|hardware|home depot|lowe'?s|tile|concrete/i, "Materials"],
  [/fuel|gas station|shell|chevron|exxon|parking|toll|uber|lyft/i, "Travel"],
  [/paint|supplies|supply|office|staples/i, "Supplies"],
  [/market|grocer|whole foods|trader joe/i, "Groceries"],
  [/rent|mortgage|landlord/i, "Housing"],
  [/insurance/i, "Insurance"],
  [/phone|internet|electric|water|utility/i, "Utilities"]
];

function prettyDate(iso) {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const parts = String(iso || "").split("-").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return String(iso || "");
  return months[parts[1] - 1] + " " + parts[2];
}

function guessCategory(name) {
  const text = String(name || "");
  for (let i = 0; i < AUTO_CATEGORY_RULES.length; i++) {
    if (AUTO_CATEGORY_RULES[i][0].test(text)) return AUTO_CATEGORY_RULES[i][1];
  }
  return "";
}

// The assistant's automatic pass. It does the bookkeeping that stays inside the
// books (match a deposit, file an expense, start next month's draft) and
// returns those as `done`. Anything a customer would see (a reminder, a late
// fee on their invoice, the weekly note) is prepared and returned as `waiting`
// for one lime tap. Running it twice does nothing new the second time.
function autopilot(docs, transactions, today, options) {
  const opts = options || {};
  const day = today || LEDGER_TODAY;
  const empty = { docs, transactions, done: [], waiting: [] };
  if (opts.enabled === false) return empty;
  const skip = Array.isArray(opts.skip) ? opts.skip : [];
  let nextDocs = docs.slice();
  let nextTx = transactions.slice();
  const done = [];
  const waiting = [];

  if (opts.kind !== "personal") {
    transactions.forEach((tx) => {
      if (skip.indexOf("match:" + tx.id) !== -1) return;
      const live = nextTx.find((row) => row.id === tx.id);
      const suggestion = suggestDepositMatch(nextDocs, nextTx, live);
      if (!suggestion) return;
      const before = nextDocs.find((doc) => doc.id === suggestion.invoiceId);
      const calc = calculateDocument(before);
      nextDocs = applyDepositMatch(nextDocs, suggestion.invoiceId, suggestion.amountMinor, day);
      nextTx = linkDeposit(nextTx, live.id, suggestion.invoiceId, calc.ok ? calc : null);
      done.push({
        key: "match",
        txId: live.id,
        invoiceId: suggestion.invoiceId,
        text: "Matched the " + formatMoney(suggestion.amountMinor, live.currency) + " deposit from " + live.name
          + " to " + (before.number || before.name) + ". Balance left: " + formatMoney(suggestion.balanceAfterMinor, live.currency) + "."
      });
    });
  }

  nextTx = nextTx.map((tx) => {
    const unfiled = !tx.category || tx.category === "Uncategorized";
    if (tx.kind !== "out" || !unfiled || skip.indexOf("sort:" + tx.id) !== -1) return tx;
    const category = guessCategory(tx.name);
    if (!category) return tx;
    done.push({
      key: "sort",
      txId: tx.id,
      text: "Filed " + tx.name + " (" + formatMoney(tx.amountMinor, tx.currency) + ") under " + category + "."
    });
    return Object.assign({}, tx, { category, autoFiled: true });
  });

  if (opts.kind !== "personal") {
    nextDocs.slice().forEach((doc) => {
      if (!doc.repeatMonthly || doc.type !== "invoice") return;
      const recur = recurInvoice(doc, day, nextDocs);
      if (!recur.ok || skip.indexOf("recur:" + recur.doc.id) !== -1) return;
      nextDocs = nextDocs.concat([Object.assign({}, recur.doc, { autoMade: true })]);
      done.push({
        key: "recur",
        invoiceId: recur.doc.id,
        sourceId: doc.id,
        text: "Started next month's draft for " + doc.name + ", due " + prettyDate(recur.doc.due) + ", "
          + formatMoney(recur.doc.totalMinor, recur.doc.currency) + ". It is not sent."
      });
    });

    nextDocs.forEach((doc) => {
      if (!isOpenInvoice(doc) || !doc.due || doc.due >= day) return;
      const owed = formatMoney(balanceOf(doc), doc.currency);
      waiting.push({
        key: "remind",
        invoiceId: doc.id,
        text: "Reminder for " + doc.name + " is written: " + (doc.number || "Invoice") + " for " + owed + " was due " + prettyDate(doc.due) + "."
      });
      const quote = lateFeeQuote(doc, day);
      if (quote.ok && quote.feeMinor > 0) {
        waiting.push({
          key: "late",
          invoiceId: doc.id,
          feeMinor: quote.feeMinor,
          text: "Late fee for " + doc.name + " is figured: " + formatMoney(quote.feeMinor, doc.currency) + " for " + quote.days + " days."
        });
      }
    });

    if (!opts.weeklySent && nextDocs.some(isOpenInvoice)) {
      waiting.push({ key: "weekly", text: "This week's note on who owes you is written." });
    }
  }

  const handled = Array.isArray(opts.handled) ? opts.handled : [];
  const open = waiting.filter((item) => handled.indexOf(item.key + ":" + (item.invoiceId || "")) === -1);
  return { docs: nextDocs, transactions: nextTx, done, waiting: open };
}

const SA = {
  CURRENCIES,
  switchAccountBooks,
  expenseAccountId,
  BOOKS_KEY,
  todayIso,
  shiftDate,
  nextInvoiceNumber,
  statusFor,
  createInvoice,
  markSent,
  refreshStatuses,
  invoiceText,
  reminderText,
  mailtoLink,
  emptyBooks,
  serializeBooks,
  restoreBooks,
  guessCategory,
  autopilot,
  csvCell,
  PLAN_MINOR,
  LEDGER_TODAY,
  SAMPLE_TRANSACTIONS,
  PERSONAL_TRANSACTIONS,
  SAMPLE_SUBSCRIPTIONS,
  ACCOUNT_KINDS,
  RECEIPT_PHOTO_MAX,
  formatMoney,
  divRoundHalfUp,
  allocateLargestRemainder,
  calculateDocument,
  balanceOf,
  isOpenInvoice,
  outstandingByCurrency,
  formatOutstanding,
  expenseTotal,
  filterDocuments,
  applyDepositMatch,
  payInvoice,
  planAmount,
  visibleBusinesses,
  grantPlatformAdmin,
  replyFor,
  FEATURES,
  SHELLS,
  featuresFor,
  shellsShareFeatures,
  featuresForAccount,
  linkFinancialAccount,
  taxName,
  customerInvoiceView,
  paymentMethods,
  saveDraft,
  syncDrafts,
  pullRefresh,
  confirmTwoFactor,
  recoverAccount,
  periodTotals,
  expensesFromLedger,
  stageReceiptPhoto,
  stageInvoiceScan,
  invoiceFromScan,
  stageUpload,
  addUpload,
  addExpense,
  linkDeposit,
  suggestDepositMatch,
  recordCustomerPayment,
  parseDecimalToScale,
  formatQty,
  LATE_FEE_BPS,
  daysBetween,
  addMonths,
  lateFeeQuote,
  applyLateFee,
  depositRequest,
  applyDepositRequest,
  recurInvoice,
  duplicateWarning,
  weeklyOwedNote,
  confirmWeeklyNote,
  taxPacket,
  exportBooks,
  platformRevenue,
  subscriptionCharges,
  DEMO_AUTH_CODE,
  RECOVERY_TOKEN
};

if (typeof module !== "undefined" && module.exports) module.exports = SA;
if (typeof window !== "undefined") window.SA = SA;
