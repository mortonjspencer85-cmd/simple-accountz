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
    currencyDisplay: "narrowSymbol",
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
  const row = TAX_NAMES[country];
  if (!row) return defaultTaxName(country);
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
  const lines = ["date,kind,name,category,currency,amount,tax"];
  const amount = (minor) => decimalAmount(minor, currency);
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
      amount(tx.amountMinor),
      amount(tx.kind === "out" ? 0 : allocatedTax(tx))
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
      amount(issuedTotal(doc)),
      amount(calc.ok ? calc.taxMinor : 0)
    ].join(","));
  });
  lines.push(["", "summary", "income", "", currency, amount(packet.incomeMinor), amount(packet.taxCollectedMinor)].join(","));
  lines.push(["", "summary", "expenses", "", currency, amount(packet.expenseMinor), amount(0)].join(","));
  lines.push(["", "summary", "tax_collected", csvCell(packet.taxName), currency, amount(packet.taxCollectedMinor), amount(packet.taxCollectedMinor)].join(","));
  return {
    ok: true,
    filesReturn: false,
    filename: "simple-accountz-books-" + packet.start + "-to-" + packet.end + ".csv",
    // The byte order mark makes Excel read accents and currency signs correctly.
    csv: "﻿" + lines.join("\r\n") + "\r\n",
    start: packet.start,
    end: packet.end,
    packet
  };
}

// ---- Spreadsheets ----
// A real .xlsx, written here so it needs no library and works offline. Excel,
// Google Sheets, Apple Numbers, and LibreOffice all open it; amounts are real
// numbers, so SUM and pivot tables work. Text cells are inline strings, which
// a spreadsheet never runs as a formula.

// Plain "1850.00" from 185000 minor units, exact (no floating point).
function decimalAmount(minor, currency) {
  const code = CURRENCIES[currency] ? currency : "USD";
  const exponent = CURRENCIES[code].exponent;
  const negative = minor < 0;
  const digits = String(Math.abs(Math.round(minor))).padStart(exponent + 1, "0");
  const whole = digits.slice(0, digits.length - exponent);
  return (negative ? "-" : "") + (exponent ? whole + "." + digits.slice(digits.length - exponent) : whole);
}

let CRC_TABLE = null;
function crc32(binary) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[i] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < binary.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ binary.charCodeAt(i)) & 255];
  return (crc ^ -1) >>> 0;
}

// Text to one-byte-per-character UTF-8, the form the zip and base64 helpers use.
function utf8Binary(text) {
  const bytes = new TextEncoder().encode(String(text));
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return out;
}

function le(value, bytes) {
  let out = "";
  let n = value >>> 0;
  for (let i = 0; i < bytes; i++) {
    out += String.fromCharCode(n & 255);
    n = n >>> 8;
  }
  return out;
}

// Zip with stored (uncompressed) entries: smaller code, and every reader accepts it.
function zipArchive(entries) {
  let files = "";
  let central = "";
  let count = 0;
  entries.forEach((entry) => {
    const name = utf8Binary(entry.name);
    const body = entry.binary ? entry.data : utf8Binary(entry.data);
    const crc = crc32(body);
    const head = "\x14\x00\x00\x00\x00\x00\x00\x00\x00\x00" + le(crc, 4) + le(body.length, 4) + le(body.length, 4) + le(name.length, 2) + le(0, 2);
    central += "PK\x01\x02\x14\x00" + head + le(0, 2) + le(0, 2) + le(0, 2) + le(0, 4) + le(files.length, 4) + name;
    files += "PK\x03\x04" + head + name + body;
    count += 1;
  });
  return files + central + "PK\x05\x06" + le(0, 2) + le(0, 2) + le(count, 2) + le(count, 2) + le(central.length, 4) + le(files.length, 4) + le(0, 2);
}

function xmlEscape(text) {
  return String(text == null ? "" : text)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function columnName(index) {
  let name = "";
  let n = index;
  while (n >= 0) {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  }
  return name;
}

// A cell is a plain string, or { n: "1850.00" } for a number, with s = style.
function sheetXml(rows) {
  let body = "";
  rows.forEach((row, r) => {
    let cells = "";
    (row || []).forEach((cell, c) => {
      if (cell == null || cell === "") return;
      const ref = columnName(c) + (r + 1);
      const style = cell && cell.s ? ' s="' + cell.s + '"' : "";
      if (cell && cell.n != null) cells += '<c r="' + ref + '"' + style + '><v>' + xmlEscape(cell.n) + "</v></c>";
      else cells += '<c r="' + ref + '"' + style + ' t="inlineStr"><is><t xml:space="preserve">' + xmlEscape(cell.t != null ? cell.t : cell) + "</t></is></c>";
    });
    if (cells) body += '<row r="' + (r + 1) + '">' + cells + "</row>";
  });
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
    + body + "</sheetData></worksheet>";
}

function safeSheetName(name, fallback) {
  const clean = String(name || "").replace(/[\\\/\*\?\[\]:]/g, " ").trim().slice(0, 31);
  return clean || fallback;
}

// sheets: [{ name, rows }]. Styles: 1 bold, 2 money, 3 bold money, 4 title.
function buildWorkbook(sheets) {
  const used = [];
  const named = sheets.map((sheet, i) => {
    let name = safeSheetName(sheet.name, "Sheet" + (i + 1));
    while (used.indexOf(name.toLowerCase()) !== -1) name = safeSheetName(name.slice(0, 28) + "-" + (i + 1), "Sheet" + (i + 1));
    used.push(name.toLowerCase());
    return { name, rows: sheet.rows || [] };
  });
  const entries = [
    { name: "[Content_Types].xml", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + named.map((_, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join("")
      + "</Types>" },
    { name: "_rels/.rels", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
      + "</Relationships>" },
    { name: "xl/workbook.xml", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
      + named.map((sheet, i) => '<sheet name="' + xmlEscape(sheet.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join("")
      + "</sheets></workbook>" },
    { name: "xl/_rels/workbook.xml.rels", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + named.map((_, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join("")
      + '<Relationship Id="rId' + (named.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
      + "</Relationships>" },
    { name: "xl/styles.xml", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + '<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>'
      + '<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font>'
      + '<font><b/><sz val="11"/><name val="Calibri"/></font>'
      + '<font><b/><sz val="14"/><name val="Calibri"/></font></fonts>'
      + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
      + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
      + '<cellXfs count="5">'
      + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
      + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
      + '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
      + '<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>'
      + '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
      + "</cellXfs></styleSheet>" }
  ];
  named.forEach((sheet, i) => entries.push({ name: "xl/worksheets/sheet" + (i + 1) + ".xml", data: sheetXml(sheet.rows) }));
  return zipArchive(entries);
}

// The workbook an accountant or a tax preparer can use: a summary plus one
// sheet each for payments in, expenses, and invoices.
// ---- Drive tracking (GPS) ----
// Only the running distance is kept: no route and no coordinates leave the
// device. Fixes that are blurry, jitter in place, or jump faster than a car
// can go are ignored, so a parked phone does not rack up miles.
const MILE_COUNTRIES = ["US", "GB", "LR", "MM"];

function distanceUnit(country) {
  return MILE_COUNTRIES.indexOf(country) !== -1 ? "mi" : "km";
}

function distanceMeters(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function newDrive(at) {
  return { startedAt: at, meters: 0, last: null, fixes: 0 };
}

function driveStep(drive, fix) {
  if (!drive || !drive.startedAt || !fix) return drive;
  const lat = Number(fix.lat);
  const lon = Number(fix.lon);
  const accuracy = Number(fix.accuracy);
  const at = Number(fix.at);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return drive;
  if (!Number.isFinite(accuracy) || accuracy > 50 || !Number.isFinite(at)) return drive;
  const point = { lat, lon, accuracy, at };
  if (!drive.last) return Object.assign({}, drive, { last: point, fixes: (drive.fixes || 0) + 1 });
  const step = distanceMeters(drive.last, point);
  const seconds = (at - drive.last.at) / 1000;
  if (seconds <= 0) return drive;
  if (step < Math.max(12, accuracy, drive.last.accuracy)) return drive;
  if (step / seconds > 70) return drive;
  return Object.assign({}, drive, { meters: (drive.meters || 0) + step, last: point, fixes: (drive.fixes || 0) + 1 });
}

// Distance in hundredths of the unit, the same scale mileageExpense takes.
function driveDistance(drive, unit) {
  const meters = Math.max(0, Number(drive && drive.meters) || 0);
  return Math.round(meters / (unit === "km" ? 1000 : 1609.344) * 100);
}

// ---- OpenDocument spreadsheet (LibreOffice, OpenOffice, Calligra) ----
function odsCell(cell) {
  if (cell == null || cell === "") return "<table:table-cell/>";
  const style = cell.s === 2 ? ' table:style-name="m"' : (cell.s === 3 ? ' table:style-name="mb"' : (cell.s === 1 || cell.s === 4 ? ' table:style-name="b"' : ""));
  if (cell.n != null) {
    return '<table:table-cell' + style + ' office:value-type="float" office:value="' + xmlEscape(cell.n) + '"><text:p>' + xmlEscape(cell.n) + "</text:p></table:table-cell>";
  }
  return '<table:table-cell' + style + ' office:value-type="string"><text:p>' + xmlEscape(cell.t != null ? cell.t : cell) + "</text:p></table:table-cell>";
}

function buildOds(sheets) {
  const tables = sheets.map((sheet, i) => {
    const rows = (sheet.rows || []).map((row) => "<table:table-row>" + ((row && row.length) ? row.map(odsCell).join("") : "<table:table-cell/>") + "</table:table-row>").join("");
    return '<table:table table:name="' + xmlEscape(safeSheetName(sheet.name, "Sheet" + (i + 1))) + '">' + rows + "</table:table>";
  }).join("");
  const content = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"'
    + ' xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"'
    + ' xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0" office:version="1.2">'
    + '<office:automatic-styles>'
    + '<number:number-style style:name="N2"><number:number number:decimal-places="2" number:min-integer-digits="1" number:grouping="true"/></number:number-style>'
    + '<style:style style:name="b" style:family="table-cell"><style:text-properties fo:font-weight="bold"/></style:style>'
    + '<style:style style:name="m" style:family="table-cell" style:data-style-name="N2"/>'
    + '<style:style style:name="mb" style:family="table-cell" style:data-style-name="N2"><style:text-properties fo:font-weight="bold"/></style:style>'
    + '</office:automatic-styles><office:body><office:spreadsheet>' + tables + "</office:spreadsheet></office:body></office:document-content>";
  const manifest = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">'
    + '<manifest:file-entry manifest:full-path="/" manifest:version="1.2" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/>'
    + '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>'
    + "</manifest:manifest>";
  // The mimetype entry must come first and be stored uncompressed; zipArchive stores everything.
  return zipArchive([
    { name: "mimetype", data: "application/vnd.oasis.opendocument.spreadsheet" },
    { name: "META-INF/manifest.xml", data: manifest },
    { name: "content.xml", data: content }
  ]);
}

function exportWorkbook(docs, transactions, period, today, currency, country, businessName, format) {
  const packet = taxPacket(transactions, period, today, currency, country);
  if (!packet) return { ok: false, error: "bad_period" };
  const money = (minor) => ({ n: decimalAmount(minor, currency), s: 2 });
  const head = (labels) => labels.map((label) => ({ t: label, s: 1 }));
  const inPeriod = (tx) => tx.currency === currency && tx.date >= packet.start && tx.date <= packet.end;
  const byDate = (a, b) => (a.date === b.date ? (a.id < b.id ? -1 : 1) : (a.date < b.date ? -1 : 1));

  const summary = [
    [{ t: (businessName || "Simple Accountz") + " · books", s: 4 }],
    ["Period", packet.start + " to " + packet.end],
    ["Currency", currency],
    [],
    head(["", "Amount"]),
    [{ t: "Money in", s: 1 }, money(packet.incomeMinor)],
    [{ t: "Money out", s: 1 }, money(packet.expenseMinor)],
    [{ t: "Profit", s: 1 }, Object.assign(money(packet.incomeMinor - packet.expenseMinor), { s: 3 })],
    [{ t: packet.taxName + " collected", s: 1 }, money(packet.taxCollectedMinor)],
    [],
    [{ t: "Expenses by category", s: 1 }]
  ];
  packet.categories.forEach((row) => summary.push([row.category, money(row.amountMinor)]));
  summary.push([], ["Simple Accountz keeps records. It does not file tax returns."]);

  const paymentsIn = transactions.filter((tx) => inPeriod(tx) && (tx.kind === "in" || tx.kind === "refund")).sort(byDate);
  const payments = [head(["Date", "Name", "Kind", "Currency", "Amount", packet.taxName + " in it"])];
  paymentsIn.forEach((tx) => payments.push([
    tx.date, tx.name || "", tx.kind === "refund" ? "Refund" : "Payment", currency,
    money(tx.kind === "refund" ? -tx.amountMinor : tx.amountMinor), money(allocatedTax(tx))
  ]));
  payments.push([{ t: "Total", s: 1 }, "", "", "", Object.assign(money(packet.incomeMinor), { s: 3 }), Object.assign(money(packet.taxCollectedMinor), { s: 3 })]);

  const spent = transactions.filter((tx) => inPeriod(tx) && tx.kind === "out").sort(byDate);
  const expenses = [head(["Date", "Merchant", "Category", "Currency", "Amount"])];
  spent.forEach((tx) => expenses.push([tx.date, tx.name || "", tx.category || "Uncategorized", currency, money(tx.amountMinor)]));
  expenses.push([{ t: "Total", s: 1 }, "", "", "", Object.assign(money(packet.expenseMinor), { s: 3 })]);

  const sent = (docs || []).filter((doc) => doc && doc.type === "invoice" && doc.currency === currency
    && doc.sentOn && doc.sentOn >= packet.start && doc.sentOn <= packet.end)
    .sort((a, b) => (a.sentOn < b.sentOn ? -1 : 1));
  const invoices = [head(["Number", "Client", "Sent", "Due", "Status", "Currency", "Total", packet.taxName, "Paid", "Balance"])];
  sent.forEach((doc) => {
    const calc = calculateDocument(doc);
    const total = issuedTotal(doc);
    const balance = balanceOf(doc);
    invoices.push([
      doc.number || "", doc.name || "", doc.sentOn, doc.due || "", doc.display || "", currency,
      money(total), money(calc.ok ? calc.taxMinor : 0), money(total - balance), money(balance)
    ]);
  });

  const drives = spent.filter((tx) => tx.mileage && tx.mileage.milesHundredths > 0);
  const mileage = [head(["Date", "Trip", "Distance", "Unit", "Rate", "Amount"])];
  let mileageMinor = 0;
  drives.forEach((tx) => {
    mileageMinor += tx.amountMinor;
    mileage.push([tx.date, tx.name || "", { n: String(tx.mileage.milesHundredths / 100) }, tx.mileage.unit === "km" ? "km" : "mi",
      money(tx.mileage.rateMinor), money(tx.amountMinor)]);
  });
  mileage.push([{ t: "Total", s: 1 }, "", "", "", "", Object.assign(money(mileageMinor), { s: 3 })]);

  const clients = [head(["Client", "Email", "Phone", "Open invoices", "Overdue", "Owed"])];
  clientSummaries(docs, today).forEach((row) => clients.push([
    row.name, row.email || "", row.phone || "", { n: String(row.openCount) }, { n: String(row.overdueCount) }, money(row.owed[currency] || 0)
  ]));

  const sheets = [
    { name: "Summary", rows: summary },
    { name: "Payments in", rows: payments },
    { name: "Expenses", rows: expenses },
    { name: "Invoices", rows: invoices },
    { name: "Mileage", rows: mileage },
    { name: "Clients", rows: clients }
  ];
  const ods = format === "ods";
  return {
    ok: true,
    filename: "simple-accountz-books-" + packet.start + "-to-" + packet.end + (ods ? ".ods" : ".xlsx"),
    mime: ods ? "application/vnd.oasis.opendocument.spreadsheet" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    data: ods ? buildOds(sheets) : buildWorkbook(sheets),
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

// Ids must not collide when two devices add records offline and later merge.
function uniqueId(prefix) {
  let rand = "";
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    rand = Array.from(bytes).map((b) => b.toString(36)).join("");
  } else {
    rand = Math.random().toString(36).slice(2, 10);
  }
  return prefix + "-" + Date.now().toString(36) + rand;
}

function addUpload(files, staged) {
  const current = Array.isArray(files) ? files : [];
  if (!staged || !staged.ok) return { files: current.slice(), added: false, reason: "not_ready" };
  if (current.some((item) => item.name === staged.name && item.type === staged.type)) {
    return { files: current.slice(), added: false, reason: "duplicate" };
  }
  return {
    files: current.concat([{
      id: uniqueId("file"),
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
    id: uniqueId("out"),
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
    id: uniqueId("inv-" + number.slice(4)),
    type: "invoice",
    name,
    email: String(f.email || "").trim(),
    phone: cleanPhone(f.phone),
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

function reminderText(doc, businessName, today) {
  if (!doc) return "";
  const day = today || todayIso();
  const when = doc.due ? (doc.due < day ? " was due " : " is due ") + prettyDate(doc.due) : " is open";
  return "Hello " + doc.name + ",\n\nA friendly reminder that invoice " + (doc.number || "") + " for "
    + formatMoney(balanceOf(doc), doc.currency) + when
    + ".\n\nThank you,\n" + (businessName || "");
}

function mailtoLink(email, subject, body) {
  const to = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(String(email || "")) ? email : "";
  return "mailto:" + encodeURIComponent(to).replace(/%40/g, "@")
    + "?subject=" + encodeURIComponent(subject || "") + "&body=" + encodeURIComponent(body || "");
}

// ---- Text messages ----
// Keeps a leading + and the digits. 7 to 15 digits is a real phone number anywhere.
function cleanPhone(value) {
  const raw = String(value || "").trim();
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return "";
  return (raw.charAt(0) === "+" ? "+" : "") + digits;
}

// For display: (555) 010-2299 for US numbers, otherwise as stored.
function formatPhone(value) {
  const phone = cleanPhone(value);
  const us = /^(?:\+?1)?(\d{3})(\d{3})(\d{4})$/.exec(phone);
  return us ? "(" + us[1] + ") " + us[2] + "-" + us[3] : phone;
}

// "sms:NUMBER?&body=" opens Messages with the text filled in on iPhone, Android, and Mac.
function smsLink(phone, body) {
  return "sms:" + cleanPhone(phone) + "?&body=" + encodeURIComponent(body || "");
}

function invoiceSms(doc, businessName, today) {
  if (!doc) return "";
  const day = today || todayIso();
  const owed = formatMoney(balanceOf(doc), doc.currency);
  const when = doc.due ? (doc.due < day ? ", was due " : ", due ") + prettyDate(doc.due) : "";
  return (businessName || "Simple Accountz") + ": invoice " + (doc.number || "") + " for " + owed + when + ". Thank you!";
}

// ---- Invoice layout shared by the PDF and the print page ----
function invoiceView(doc, businessName, taxLabel) {
  const calc = calculateDocument(doc);
  const currency = doc.currency || "USD";
  const lines = calc.ok ? calc.lines.map((line) => ({
    name: line.name || "Item",
    qty: formatQty(line.qtyBps),
    rate: formatMoney(line.rateMinor, currency),
    amount: formatMoney(line.extendedMinor, currency)
  })) : [];
  const paid = calc.ok ? Math.max(0, calc.paidMinor - calc.refundedMinor) : 0;
  return {
    business: businessName || "Simple Accountz",
    number: doc.number || "",
    status: doc.display || "",
    client: doc.name || "",
    email: doc.email || "",
    phone: formatPhone(doc.phone),
    issued: doc.sentOn || doc.created || "",
    due: doc.due || "",
    lines,
    subtotal: formatMoney(calc.ok ? calc.subtotalMinor : 0, currency),
    taxLabel: taxLabel || "Tax",
    tax: formatMoney(calc.ok ? calc.taxMinor : 0, currency),
    total: formatMoney(calc.ok ? calc.totalMinor : (doc.totalMinor || 0), currency),
    paid: paid ? formatMoney(paid, currency) : "",
    balance: formatMoney(balanceOf(doc), currency)
  };
}

// ---- PDF (written by hand: no library, works offline) ----
// Standard Helvetica with WinAnsi encoding. Characters it cannot show become "?".
const WIN_ANSI = { "€": 128, "‚": 130, "„": 132, "…": 133, "‘": 145, "’": 146, "“": 147, "”": 148, "•": 149, "–": 150, "—": 151, "™": 153 };

// Currency signs the built-in PDF fonts cannot draw are written as the code.
const PDF_CURRENCY_SIGNS = { "₦": "NGN ", "₹": "INR ", "₱": "PHP ", "₩": "KRW ", "₫": "VND ", "₺": "TRY ", "₴": "UAH ", "₸": "KZT ", "₽": "RUB ", "₪": "ILS ", "₵": "GHS ", "₲": "PYG ", "₡": "CRC ", "₭": "LAK ", "₮": "MNT ", "₼": "AZN ", "₾": "GEL ", "৳": "BDT ", "฿": "THB ", "៛": "KHR " };

function pdfString(value) {
  let out = "";
  const text = String(value == null ? "" : value).replace(/[₦₹₱₩₫₺₴₸₽₪₵₲₡₭₮₼₾৳฿៛]/g, (sign) => PDF_CURRENCY_SIGNS[sign]);
  for (const ch of text) {
    const code = ch.codePointAt(0);
    let byte = 63;
    if (code >= 32 && code <= 126) byte = code;
    else if (code >= 160 && code <= 255) byte = code;
    else if (WIN_ANSI[ch]) byte = WIN_ANSI[ch];
    else if (code === 9 || code === 10 || code === 13) byte = 32;
    const c = String.fromCharCode(byte);
    out += (c === "(" || c === ")" || c === "\\") ? "\\" + c : c;
  }
  return out;
}

// Helvetica glyph widths (per 1000), close enough to right-align amounts.
function pdfTextWidth(text, size, bold) {
  let units = 0;
  for (const ch of String(text)) {
    if (/[0-9$€£¥#]/.test(ch)) units += 556;
    else if (/[.,:;' ]/.test(ch)) units += 278;
    else if (ch === "-") units += 333;
    else if (/[A-Z]/.test(ch)) units += bold ? 722 : 667;
    else if (/[a-z]/.test(ch)) units += bold ? 556 : 500;
    else units += 556;
  }
  return units * size / 1000;
}

function pdfClip(text, size, bold, width) {
  let t = String(text || "");
  while (t.length > 1 && pdfTextWidth(t, size, bold) > width) t = t.slice(0, -2) + "…";
  return t;
}

function invoicePdf(view) {
  const W = 612;
  const H = 792;
  const M = 48;
  const pages = [];
  let ops = [];
  const rgb = (c) => (c[0] / 255).toFixed(3) + " " + (c[1] / 255).toFixed(3) + " " + (c[2] / 255).toFixed(3);
  const rect = (x, y, w, h, c) => ops.push(rgb(c) + " rg " + x + " " + y + " " + w + " " + h + " re f");
  const text = (x, y, value, size, bold, c, align) => {
    const t = String(value == null ? "" : value);
    const tx = align === "right" ? x - pdfTextWidth(t, size, bold) : x;
    ops.push("BT " + rgb(c || [14, 15, 12]) + " rg /" + (bold ? "F2" : "F1") + " " + size + " Tf " + tx.toFixed(1) + " " + y.toFixed(1) + " Td (" + pdfString(t) + ") Tj ET");
  };
  const line = (y) => ops.push("0.890 0.902 0.878 RG 0.8 w " + M + " " + y + " m " + (W - M) + " " + y + " l S");
  const forest = [22, 51, 0];
  const lime = [180, 255, 106];
  const slate = [79, 82, 78];

  // Header band
  rect(0, H - 120, W, 120, forest);
  text(M, H - 62, pdfClip(view.business, 22, true, 330), 22, true, [255, 255, 255]);
  text(M, H - 86, "INVOICE " + view.number, 11, true, lime);
  text(W - M, H - 62, view.balance, 22, true, [255, 255, 255], "right");
  text(W - M, H - 86, "Balance due", 11, false, lime, "right");

  let y = H - 160;
  text(M, y, "BILL TO", 9, true, slate);
  text(340, y, "ISSUED", 9, true, slate);
  text(460, y, "DUE", 9, true, slate);
  y -= 18;
  text(M, y, pdfClip(view.client, 13, true, 270), 13, true);
  text(340, y, prettyDate(view.issued) || "—", 12, false);
  text(460, y, prettyDate(view.due) || "—", 12, false);
  [view.email, view.phone].filter(Boolean).forEach((extra) => { y -= 16; text(M, y, pdfClip(extra, 11, false, 270), 11, false, slate); });

  const tableHead = (top) => {
    rect(M, top - 6, W - M * 2, 24, [238, 241, 236]);
    text(M + 10, top + 2, "DESCRIPTION", 9, true, slate);
    text(380, top + 2, "QTY", 9, true, slate, "right");
    text(470, top + 2, "RATE", 9, true, slate, "right");
    text(W - M - 10, top + 2, "AMOUNT", 9, true, slate, "right");
    return top - 30;
  };
  y = tableHead(y - 44);
  view.lines.forEach((row) => {
    if (y < 150) {
      text(W - M, 40, "Continued on the next page", 9, false, slate, "right");
      pages.push(ops);
      ops = [];
      y = tableHead(H - 70);
    }
    text(M + 10, y, pdfClip(row.name, 11, false, 250), 11, false);
    text(380, y, row.qty, 11, false, null, "right");
    text(470, y, row.rate, 11, false, null, "right");
    text(W - M - 10, y, row.amount, 11, false, null, "right");
    line(y - 9);
    y -= 26;
  });

  y -= 6;
  const totalRow = (label, value, strong) => {
    text(430, y, label, strong ? 12 : 11, strong, strong ? null : slate, "right");
    text(W - M - 10, y, value, strong ? 12 : 11, strong, null, "right");
    y -= strong ? 22 : 18;
  };
  totalRow("Subtotal", view.subtotal);
  totalRow(view.taxLabel, view.tax);
  totalRow("Total", view.total, true);
  if (view.paid) totalRow("Paid", view.paid);
  y -= 10;
  rect(300, y - 12, W - M - 300, 32, forest);
  text(316, y, "Balance due", 12, true, lime);
  text(W - M - 10, y, view.balance, 13, true, [255, 255, 255], "right");

  text(M, 56, "Thank you for your business.", 11, false, slate);
  text(W - M, 56, "Made with Simple Accountz", 9, false, slate, "right");
  pages.push(ops);

  // Assemble the file. Objects: 1 catalog, 2 pages, 3 F1, 4 F2, then a page + content per page.
  const objects = [];
  const kids = pages.map((_, i) => (5 + i * 2) + " 0 R").join(" ");
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push("<< /Type /Pages /Kids [" + kids + "] /Count " + pages.length + " >>");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  pages.forEach((pageOps, i) => {
    const stream = pageOps.join("\n");
    objects.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + W + " " + H + "] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents " + (6 + i * 2) + " 0 R >>");
    objects.push("<< /Length " + stream.length + " >>\nstream\n" + stream + "\nendstream");
  });
  let out = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += (i + 1) + " 0 obj\n" + body + "\nendobj\n";
  });
  const xref = out.length;
  out += "xref\n0 " + (objects.length + 1) + "\n0000000000 65535 f \n";
  offsets.forEach((offset) => { out += String(offset).padStart(10, "0") + " 00000 n \n"; });
  out += "trailer\n<< /Size " + (objects.length + 1) + " /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF\n";
  return out;
}

function invoicePdfName(view) {
  const who = String(view.client || "client").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "client";
  return (view.number || "Invoice") + "-" + who + ".pdf";
}

// Bytes (one per character) to base64, in browsers and in Node.
function binaryToBase64(binary) {
  if (typeof btoa === "function") return btoa(binary);
  return Buffer.from(binary, "latin1").toString("base64");
}

// ---- Print page link (data rides in the #fragment, which never reaches a server) ----
function printLink(view, base) {
  const json = JSON.stringify(view);
  const utf8 = unescape(encodeURIComponent(json));
  const b64 = binaryToBase64(utf8).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return (base || "https://simpleaccountz.com/print.html") + "#d=" + b64;
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
    autoSkip: [],
    deleted: {},
    activity: []
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
    autoSkip: Array.isArray(s.autoSkip) ? s.autoSkip : [],
    deleted: cleanDeleted(s.deleted),
    activity: cleanActivity(s.activity)
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
    autoSkip: Array.isArray(raw.autoSkip) ? raw.autoSkip.filter((item) => typeof item === "string") : [],
    deleted: cleanDeleted(raw.deleted),
    activity: cleanActivity(raw.activity)
  };
}

// ---- Cloud sync rules ----
// meta: { version: the server version this device last matched, dirty: unsynced local edits }
// server: { books, version } from GET /api/books

function hasBooksData(books) {
  if (!books) return false;
  return ["docs", "business", "personal", "uploads"].some((key) => Array.isArray(books[key]) && books[key].length > 0)
    || Boolean(books.businessName);
}

function planSync(meta, server) {
  const m = meta || { version: 0, dirty: false };
  const s = server || { books: null, version: 0 };
  if (s.version === m.version) return m.dirty ? "push" : "none";
  if (!m.dirty) return "pull";
  if (!hasBooksData(s.books)) return "push";
  return "merge";
}

function unionById(mine, theirs) {
  const out = [];
  const seen = {};
  (Array.isArray(mine) ? mine : []).concat(Array.isArray(theirs) ? theirs : []).forEach((item) => {
    if (!item || item.id == null || seen[item.id]) return;
    seen[item.id] = true;
    out.push(item);
  });
  return out;
}

function unionStrings(a, b) {
  const out = [];
  (Array.isArray(a) ? a : []).concat(Array.isArray(b) ? b : []).forEach((item) => {
    if (typeof item === "string" && out.indexOf(item) === -1) out.push(item);
  });
  return out;
}

// Both devices changed the books. Keep everything from both; where the same
// record changed on both, this device's copy wins because it is the newer edit.
// Deleted record ids and when they were deleted. Every device keeps the list,
// so a record deleted on one device is not brought back by another.
function cleanDeleted(value) {
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  const keys = Object.keys(value).filter((key) => key.length <= 120 && Number.isFinite(value[key]));
  keys.sort((a, b) => value[b] - value[a]).slice(0, 20000).forEach((key) => { out[key] = value[key]; });
  return out;
}

function mergeDeleted(a, b) {
  const out = Object.assign({}, cleanDeleted(a));
  const other = cleanDeleted(b);
  Object.keys(other).forEach((key) => { out[key] = Math.max(out[key] || 0, other[key]); });
  return out;
}

function withoutDeleted(list, deleted) {
  return (Array.isArray(list) ? list : []).filter((item) => !item || !Object.prototype.hasOwnProperty.call(deleted, item.id));
}

function mergeBooks(local, server) {
  const mine = restoreBooks(JSON.stringify(local || emptyBooks()));
  const theirs = restoreBooks(JSON.stringify(server || emptyBooks()));
  const deleted = mergeDeleted(mine.deleted, theirs.deleted);
  return {
    version: 1,
    businessName: mine.businessName || theirs.businessName,
    accountKind: mine.accountKind,
    docs: withoutDeleted(unionById(mine.docs, theirs.docs), deleted),
    business: withoutDeleted(unionById(mine.business, theirs.business), deleted),
    personal: withoutDeleted(unionById(mine.personal, theirs.personal), deleted),
    uploads: withoutDeleted(unionById(mine.uploads, theirs.uploads), deleted),
    deleted,
    autoMode: mine.autoMode,
    autoHandled: unionStrings(mine.autoHandled, theirs.autoHandled),
    autoSkip: unionStrings(mine.autoSkip, theirs.autoSkip),
    // Newest first, both devices' entries kept, capped.
    activity: unionById(mine.activity, theirs.activity).sort((a, b) => (a.at < b.at ? 1 : (a.at > b.at ? -1 : 0))).slice(0, ACTIVITY_MAX)
  };
}

// ---- Document scanning ----
// Finds the sheet of paper in a camera frame, straightens it, and reads the
// fields off it. Everything here works on plain arrays, so it can be tested
// without a camera and runs the same in a browser and in the store apps.

// Splits light paper from a darker background. Otsu's method: the cut that
// leaves the two sides as tight as possible.
function otsuThreshold(gray) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i]] += 1;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let weightB = 0;
  let best = 0;
  let cut = 128;
  for (let t = 0; t < 256; t++) {
    weightB += hist[t];
    if (!weightB) continue;
    const weightF = total - weightB;
    if (!weightF) break;
    sumB += t * hist[t];
    const between = weightB * weightF * Math.pow(sumB / weightB - (sum - sumB) / weightF, 2);
    if (between > best) { best = between; cut = t; }
  }
  return cut;
}

// The four corners of the page, as a quadrilateral, or null when the frame does
// not hold one clearly. gray is one brightness value (0-255) per pixel.
function findDocumentQuad(gray, width, height) {
  if (!gray || gray.length !== width * height || width < 16 || height < 16) return null;
  const cut = otsuThreshold(gray);
  // Paper must be clearly brighter than what it sits on.
  let light = 0;
  let lightSum = 0;
  let darkSum = 0;
  let dark = 0;
  for (let i = 0; i < gray.length; i++) {
    if (gray[i] > cut) { light += 1; lightSum += gray[i]; } else { dark += 1; darkSum += gray[i]; }
  }
  if (!light || !dark) return null;
  if (lightSum / light - darkSum / dark < 28) return null;
  const share = light / gray.length;
  if (share < 0.12 || share > 0.97) return null;

  // The extreme points of the bright area give the corners, which works even
  // when the page is held at an angle.
  let tl = null, tr = null, br = null, bl = null;
  let minSum = Infinity, maxSum = -Infinity, minDiff = Infinity, maxDiff = -Infinity;
  let minX = width, maxX = -1, minY = height, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (gray[y * width + x] <= cut) continue;
      const sum = x + y;
      const diff = x - y;
      if (sum < minSum) { minSum = sum; tl = { x, y }; }
      if (sum > maxSum) { maxSum = sum; br = { x, y }; }
      if (diff > maxDiff) { maxDiff = diff; tr = { x, y }; }
      if (diff < minDiff) { minDiff = diff; bl = { x, y }; }
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!tl || !tr || !br || !bl) return null;
  const corners = [tl, tr, br, bl];
  const area = Math.abs(quadArea(corners));
  const box = (maxX - minX + 1) * (maxY - minY + 1);
  // Reject blobs that are not solid and rectangular enough to be a page.
  if (area < box * 0.6) return null;
  if (area < gray.length * 0.10) return null;
  const sides = [0, 1, 2, 3].map((i) => Math.hypot(corners[(i + 1) % 4].x - corners[i].x, corners[(i + 1) % 4].y - corners[i].y));
  if (Math.min.apply(null, sides) < Math.min(width, height) * 0.12) return null;
  // A page is solid: nearly every pixel inside the outline is light. Stripes and
  // clutter can stretch a quadrilateral across the frame but stay patchy inside.
  let inside = 0;
  let bright = 0;
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      if (!pointInQuad(x, y, corners)) continue;
      inside += 1;
      if (gray[y * width + x] > cut) bright += 1;
    }
  }
  if (!inside || bright / inside < 0.82) return null;
  return { corners, area, fill: area / gray.length, solid: bright / inside, threshold: cut };
}

function pointInQuad(px, py, corners) {
  let hit = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const a = corners[i];
    const b = corners[j];
    if ((a.y > py) !== (b.y > py) && px < (b.x - a.x) * (py - a.y) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

function quadArea(corners) {
  let total = 0;
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    total += a.x * b.y - b.x * a.y;
  }
  return total / 2;
}

// True when two readings of the page sit in almost the same place, which means
// the hand has stopped moving and the shot is worth taking.
// A found outline is only shown when it can really be a page: no corner on the
// frame edge (that means the page runs off screen or the edge is background),
// opposite sides of similar length, and every corner roughly square.
function quadLooksLikePage(quad, width, height) {
  if (!quad || !Array.isArray(quad.corners) || quad.corners.length !== 4) return false;
  const c = quad.corners;
  if (c.some((p) => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) return false;
  const edge = Math.max(2, Math.round(Math.min(width, height) * 0.015));
  if (c.some((p) => p.x <= edge || p.y <= edge || p.x >= width - 1 - edge || p.y >= height - 1 - edge)) return false;
  const len = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const sides = [len(c[0], c[1]), len(c[1], c[2]), len(c[2], c[3]), len(c[3], c[0])];
  if (Math.min(...sides) < Math.min(width, height) * 0.12) return false;
  if (Math.min(sides[0], sides[2]) / Math.max(sides[0], sides[2]) < 0.6) return false;
  if (Math.min(sides[1], sides[3]) / Math.max(sides[1], sides[3]) < 0.6) return false;
  for (let i = 0; i < 4; i++) {
    const p = c[i];
    const a = c[(i + 3) % 4];
    const b = c[(i + 1) % 4];
    const v1x = a.x - p.x, v1y = a.y - p.y, v2x = b.x - p.x, v2y = b.y - p.y;
    const cos = (v1x * v2x + v1y * v2y) / ((Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y)) || 1);
    const degrees = Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
    if (degrees < 55 || degrees > 125) return false;
  }
  return true;
}

function quadIsSteady(a, b, tolerance) {
  if (!a || !b) return false;
  const limit = tolerance == null ? 0.02 : tolerance;
  return a.corners.every((corner, i) =>
    Math.hypot(corner.x - b.corners[i].x, corner.y - b.corners[i].y) <= limit * 100);
}

// The transform that pulls a slanted page into a straight rectangle.
function solveHomography(from, to) {
  const rows = [];
  for (let i = 0; i < 4; i++) {
    const s = from[i];
    const d = to[i];
    rows.push([s.x, s.y, 1, 0, 0, 0, -s.x * d.x, -s.y * d.x, d.x]);
    rows.push([0, 0, 0, s.x, s.y, 1, -s.x * d.y, -s.y * d.y, d.y]);
  }
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(rows[r][col]) > Math.abs(rows[pivot][col])) pivot = r;
    if (Math.abs(rows[pivot][col]) < 1e-9) return null;
    const swap = rows[col];
    rows[col] = rows[pivot];
    rows[pivot] = swap;
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const factor = rows[r][col] / rows[col][col];
      for (let c = col; c < 9; c++) rows[r][c] -= factor * rows[col][c];
    }
  }
  const h = rows.map((row, i) => row[8] / row[i]);
  return h.concat([1]);
}

function applyHomography(h, x, y) {
  const w = h[6] * x + h[7] * y + h[8];
  if (!w) return { x: 0, y: 0 };
  return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w };
}

// How big the straightened page should be, keeping the paper's real proportions.
function straightenedSize(corners, maxWidth) {
  const side = (a, b) => Math.hypot(corners[b].x - corners[a].x, corners[b].y - corners[a].y);
  const width = Math.max(side(0, 1), side(3, 2));
  const height = Math.max(side(0, 3), side(1, 2));
  if (!width || !height) return null;
  const limit = maxWidth || 1600;
  const scale = Math.min(1, limit / width);
  return { width: Math.max(8, Math.round(width * scale)), height: Math.max(8, Math.round(height * scale)) };
}

// ---- Reading the text off a scan ----
// Money written any of the usual ways: $1,234.56 · 1 234,56 · 1234.56 · 1234
function parseMoneyToken(text) {
  const raw = String(text || "").trim().replace(/[^\d.,-]/g, "");
  if (!/\d/.test(raw)) return null;
  const negative = /^-/.test(raw);
  let body = raw.replace(/-/g, "");
  const lastDot = body.lastIndexOf(".");
  const lastComma = body.lastIndexOf(",");
  const mark = Math.max(lastDot, lastComma);
  let cents = "";
  if (mark !== -1 && /^\d{1,2}$/.test(body.slice(mark + 1))) {
    cents = body.slice(mark + 1).padEnd(2, "0");
    body = body.slice(0, mark);
  }
  const whole = body.replace(/[.,\s]/g, "");
  if (!/^\d+$/.test(whole)) return null;
  const minor = Number(whole) * 100 + Number(cents || "0");
  if (!Number.isSafeInteger(minor) || minor > 1e11) return null;
  return negative ? -minor : minor;
}

const MONEY_RE = /(?:[$£€¥]\s?)?\d{1,3}(?:[.,\s]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?/g;

function findMoney(line) {
  const out = [];
  String(line || "").replace(MONEY_RE, (match, offset) => {
    if (!/\d/.test(match)) return match;
    const minor = parseMoneyToken(match);
    if (minor != null && minor > 0) out.push({ minor, raw: match.trim(), at: offset });
    return match;
  });
  return out;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// A date in any common layout, turned into 2026-11-26. Ambiguous day/month pairs
// use the order the business's country writes them in.
function parseLooseDate(text, today, dayFirst) {
  const value = String(text || "");
  const iso = /(20\d{2})[-\/.](\d{1,2})[-\/.](\d{1,2})/.exec(value);
  const pick = (y, m, d) => {
    if (m < 1 || m > 12 || d < 1 || d > 31) return "";
    const out = y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
    return out;
  };
  if (iso) return pick(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const named = new RegExp("(\\d{1,2})?\\s*(" + MONTHS.join("|") + ")[a-z]*\\.?,?\\s*(\\d{1,2})?,?\\s*(20\\d{2})", "i").exec(value);
  if (named) {
    const month = MONTHS.indexOf(named[2].toLowerCase()) + 1;
    const day = Number(named[1] || named[3] || 1);
    return pick(Number(named[4]), month, day);
  }
  const slash = /(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})/.exec(value);
  if (slash) {
    let year = Number(slash[3]);
    if (year < 100) year += 2000;
    let a = Number(slash[1]);
    let b = Number(slash[2]);
    // 13 or more can only be the day, whatever the local habit is.
    const monthFirst = b > 12 ? true : (a > 12 ? false : !dayFirst);
    return monthFirst ? pick(year, a, b) : pick(year, b, a);
  }
  return "";
}

const TOTAL_WORDS = /\b(grand\s*total|balance\s*due|amount\s*due|total\s*due|total)\b/i;
const SKIP_TOTAL = /\b(sub\s*-?total|tax|vat|gst|tip|change|cash|tendered|discount)\b/i;
const NOT_A_NAME = /^[\s\d\W]*$/;

function cleanLines(text) {
  return String(text || "").split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
}

// Pulls merchant, total, and date off a shop receipt.
function parseReceiptText(text, today, dayFirst) {
  const lines = cleanLines(text);
  const found = { merchant: "", totalMinor: 0, date: "", category: "", fields: 0 };
  if (!lines.length) return found;

  let best = null;
  lines.forEach((line, index) => {
    if (!TOTAL_WORDS.test(line) || SKIP_TOTAL.test(line)) return;
    const money = findMoney(line);
    if (!money.length) return;
    const amount = money[money.length - 1];
    const grand = /grand\s*total|balance\s*due|amount\s*due|total\s*due/i.test(line);
    const score = (grand ? 1000000 : 0) + index + amount.minor / 1e9;
    if (!best || score > best.score) best = { minor: amount.minor, score };
  });
  if (!best) {
    // No labelled total: the largest amount on the receipt is the usual answer.
    const all = lines.reduce((list, line) => list.concat(findMoney(line)), []);
    if (all.length) best = { minor: all.reduce((top, item) => Math.max(top, item.minor), 0) };
  }
  if (best && best.minor > 0) { found.totalMinor = best.minor; found.fields += 1; }

  for (let i = 0; i < lines.length && !found.date; i++) {
    const date = parseLooseDate(lines[i], today, dayFirst);
    if (date) { found.date = date; found.fields += 1; }
  }

  const header = lines.slice(0, 6).find((line) =>
    line.length >= 3 && line.length <= 40 && !NOT_A_NAME.test(line) && !TOTAL_WORDS.test(line)
    && !/receipt|invoice|order|www\.|http|@|tel|phone|\d{3}-\d{4}/i.test(line));
  if (header) {
    found.merchant = header.replace(/[*#|]+/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
    found.fields += 1;
    found.category = guessCategory(found.merchant);
  }
  return found;
}

// Pulls client, number, total, and due date off a paper invoice.
function parseInvoiceText(text, today, dayFirst) {
  const lines = cleanLines(text);
  const found = { client: "", number: "", totalMinor: 0, due: "", email: "", phone: "", fields: 0 };
  if (!lines.length) return found;
  const all = lines.join("\n");

  const number = /\b(?:invoice|inv)\s*(?:number|no\.?|#)?\s*[:#]?\s*([A-Z]{0,4}-?\d{2,8})\b/i.exec(all);
  if (number) { found.number = number[1].toUpperCase().slice(0, 20); found.fields += 1; }

  const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.exec(all);
  if (email) { found.email = email[0].toLowerCase(); found.fields += 1; }

  const phone = /(\+?\d[\d\s().-]{7,17}\d)/.exec(all.replace(/\b(?:invoice|inv|no|#)\s*[:#]?\s*\d+/gi, ""));
  if (phone) {
    const clean = cleanPhone(phone[1]);
    if (clean) { found.phone = clean; found.fields += 1; }
  }

  let best = null;
  lines.forEach((line, index) => {
    if (!TOTAL_WORDS.test(line) || SKIP_TOTAL.test(line)) return;
    const money = findMoney(line);
    if (!money.length) return;
    const grand = /balance\s*due|amount\s*due|total\s*due|grand\s*total/i.test(line);
    const score = (grand ? 1000000 : 0) + index;
    if (!best || score > best.score) best = { minor: money[money.length - 1].minor, score };
  });
  if (best && best.minor > 0) { found.totalMinor = best.minor; found.fields += 1; }

  const dueLine = lines.find((line) => /\bdue\b/i.test(line) && parseLooseDate(line, today, dayFirst));
  if (dueLine) { found.due = parseLooseDate(dueLine, today, dayFirst); found.fields += 1; }

  const billIndex = lines.findIndex((line) => /\b(bill\s*to|invoice\s*to|sold\s*to|customer)\b/i.test(line));
  if (billIndex !== -1) {
    const sameLine = lines[billIndex].replace(/.*\b(?:bill\s*to|invoice\s*to|sold\s*to|customer)\b\s*:?\s*/i, "").trim();
    const next = lines.slice(billIndex + 1).find((line) => !NOT_A_NAME.test(line));
    const name = sameLine && !NOT_A_NAME.test(sameLine) ? sameLine : next;
    if (name) { found.client = name.slice(0, 60); found.fields += 1; }
  }
  if (!found.client) {
    const header = lines.slice(0, 4).find((line) =>
      line.length >= 3 && line.length <= 40 && !NOT_A_NAME.test(line) && !/invoice|receipt|statement/i.test(line));
    if (header) { found.client = header.slice(0, 60); found.fields += 1; }
  }
  return found;
}

// ---- Activity feed and notifications ----
// Every change worth telling the owner about becomes one entry. The feed lives
// in the books, so it syncs: something recorded on a phone shows on the laptop.
// Each device remembers which entries it has already shown, so nothing is
// announced twice.
const ACTIVITY_MAX = 60;
const ACTIVITY_KINDS = [
  "sent", "paid", "overdue", "match", "sort", "recur", "late_fee", "reminded",
  // Bank feed. Nothing produces these yet: they arrive once a bank provider is
  // connected and its events are handed to applyBankEvents.
  "check_cleared", "deposit", "bill_paid", "payment_cleared"
];
const BANK_KINDS = ["check_cleared", "deposit", "bill_paid", "payment_cleared"];

function cleanActivity(value) {
  if (!Array.isArray(value)) return [];
  const seen = {};
  return value.filter((item) => {
    if (!item || typeof item !== "object") return false;
    if (typeof item.id !== "string" || item.id.length > 120 || seen[item.id]) return false;
    if (typeof item.text !== "string" || typeof item.at !== "string") return false;
    if (ACTIVITY_KINDS.indexOf(item.kind) === -1) return false;
    seen[item.id] = true;
    return true;
  }).map((item) => ({
    id: item.id,
    at: item.at.slice(0, 25),
    kind: item.kind,
    text: item.text.slice(0, 200),
    docId: typeof item.docId === "string" ? item.docId.slice(0, 120) : undefined
  })).slice(0, ACTIVITY_MAX);
}

// Adds entries, newest first, ignoring ids already in the feed.
function addActivity(activity, entries) {
  const list = cleanActivity(activity);
  const have = {};
  list.forEach((item) => { have[item.id] = true; });
  const fresh = cleanActivity(entries).filter((item) => !have[item.id]);
  if (!fresh.length) return list;
  return fresh.concat(list).sort((a, b) => (a.at < b.at ? 1 : (a.at > b.at ? -1 : 0))).slice(0, ACTIVITY_MAX);
}

function activityEntry(kind, text, at, extra) {
  return Object.assign({ id: uniqueId(kind), at: at || new Date().toISOString(), kind, text }, extra || {});
}

// Invoices that have just passed their due date and have not been announced yet.
function overdueActivity(docs, today, activity) {
  const day = today || todayIso();
  const told = {};
  cleanActivity(activity).forEach((item) => { if (item.kind === "overdue" && item.docId) told[item.docId] = true; });
  return (docs || []).filter((doc) => isOpenInvoice(doc) && doc.due && doc.due < day && !told[doc.id]).map((doc) =>
    activityEntry("overdue", (doc.number || "An invoice") + " for " + doc.name + " is overdue: "
      + formatMoney(balanceOf(doc), doc.currency) + ", due " + prettyDate(doc.due) + ".",
      day + "T09:00:00.000Z", { docId: doc.id }));
}

// What this device has not shown a notification for yet. Entries older than a
// day are skipped, so installing the app does not replay the whole history.
function unseenActivity(activity, seenIds, nowMs) {
  const seen = Array.isArray(seenIds) ? seenIds : [];
  const cutoff = new Date((nowMs || Date.now()) - 36 * 60 * 60 * 1000).toISOString();
  return cleanActivity(activity).filter((item) => item.at >= cutoff && seen.indexOf(item.id) === -1);
}

// ---- Bank feed plumbing ----
// A connected bank provider hands over events like these; nothing produces them
// yet. Each event: { kind, amountMinor, currency, name, date, reference }.
function bankEventText(event) {
  const amount = formatMoney(Math.abs(Number(event.amountMinor) || 0), event.currency || "USD");
  const who = String(event.name || "").trim();
  const when = /^\d{4}-\d{2}-\d{2}$/.test(String(event.date || "")) ? " on " + prettyDate(event.date) : "";
  const ref = event.reference ? " (" + String(event.reference).slice(0, 40) + ")" : "";
  if (event.kind === "check_cleared") return "Check" + ref + " for " + amount + " cleared" + when + ".";
  if (event.kind === "deposit") return amount + " was deposited" + (who ? " from " + who : "") + when + ".";
  if (event.kind === "bill_paid") return "A bill of " + amount + (who ? " to " + who : "") + " was paid" + when + ".";
  return amount + (who ? " from " + who : "") + " cleared your account" + when + ".";
}

function applyBankEvents(activity, events, nowIso) {
  const fresh = (Array.isArray(events) ? events : []).filter((event) =>
    event && BANK_KINDS.indexOf(event.kind) !== -1 && Number.isFinite(Number(event.amountMinor))
  ).map((event) => Object.assign(
    activityEntry(event.kind, bankEventText(event), /^\d{4}-\d{2}-\d{2}/.test(String(event.at || "")) ? event.at : (nowIso || new Date().toISOString())),
    // A provider id keeps the same event from being added twice.
    event.id ? { id: "bank-" + String(event.id).slice(0, 100) } : {}
  ));
  return addActivity(activity, fresh);
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

// ---- Clients, statements, mileage, time, and cash forecast ----

function clientKey(name) {
  return String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// One row per client, built from the invoices themselves, so the list is
// never out of step with the books.
function clientSummaries(docs, today) {
  const day = today || todayIso();
  const map = {};
  (docs || []).forEach((doc) => {
    if (!doc || (doc.type !== "invoice" && doc.type !== "estimate")) return;
    const key = clientKey(doc.name);
    if (!key) return;
    const row = map[key] || (map[key] = {
      key, name: String(doc.name).trim(), email: "", phone: "",
      owed: {}, openCount: 0, overdueCount: 0, invoiceCount: 0, last: ""
    });
    if (doc.email && !row.email) row.email = doc.email;
    if (doc.phone && !row.phone) row.phone = doc.phone;
    const date = doc.created || "";
    if (date > row.last) row.last = date;
    if (doc.type !== "invoice") return;
    row.invoiceCount += 1;
    if (isOpenInvoice(doc)) {
      const owe = balanceOf(doc);
      row.owed[doc.currency] = (row.owed[doc.currency] || 0) + owe;
      row.openCount += 1;
      if (doc.due && doc.due < day) row.overdueCount += 1;
    }
  });
  return Object.keys(map).map((k) => map[k]).sort((a, b) => {
    if (b.overdueCount !== a.overdueCount) return b.overdueCount - a.overdueCount;
    const ao = Object.keys(a.owed).reduce((t, c) => t + a.owed[c], 0);
    const bo = Object.keys(b.owed).reduce((t, c) => t + b.owed[c], 0);
    if (bo !== ao) return bo - ao;
    return a.name.localeCompare(b.name);
  });
}

function owedText(owed) {
  const keys = Object.keys(owed || {}).filter((c) => owed[c] > 0);
  return keys.length ? keys.map((c) => formatMoney(owed[c], c)).join(" + ") : "";
}

// A plain statement a client can read in an email or a text.
function clientStatement(docs, name, today, businessName) {
  const day = today || todayIso();
  const key = clientKey(name);
  const open = (docs || []).filter((doc) => doc && doc.type === "invoice" && clientKey(doc.name) === key && isOpenInvoice(doc))
    .sort((a, b) => (a.due < b.due ? -1 : (a.due > b.due ? 1 : 0)));
  const from = String(businessName || "").trim() || "Simple Accountz";
  const subject = "Statement from " + from;
  if (!open.length) {
    return { ok: true, open: 0, subject, body: "Hi " + String(name || "").trim() + ",\n\nYou are all paid up with " + from + ". Thank you.\n\n" + from };
  }
  const owed = {};
  const lines = open.map((doc) => {
    const owe = balanceOf(doc);
    owed[doc.currency] = (owed[doc.currency] || 0) + owe;
    const late = doc.due && doc.due < day ? " (overdue " + daysBetween(doc.due, day) + " days)" : "";
    return "- " + (doc.number || "Invoice") + ": " + formatMoney(owe, doc.currency) + " due " + (doc.due || "now") + late;
  });
  const body = "Hi " + String(name || "").trim() + ",\n\nHere is what is open with " + from + " as of " + day + ":\n\n"
    + lines.join("\n") + "\n\nTotal: " + owedText(owed) + "\n\nThank you,\n" + from;
  return { ok: true, open: open.length, owed, subject, body };
}

// A drive becomes an expense: miles times the rate, rounded to the cent.
function mileageExpense(fields) {
  const f = fields || {};
  const milesHundredths = f.milesHundredths;
  const rateMinor = f.rateMinor;
  if (!Number.isSafeInteger(milesHundredths) || milesHundredths <= 0) return { ok: false, error: "miles" };
  if (!Number.isSafeInteger(rateMinor) || rateMinor <= 0) return { ok: false, error: "rate" };
  const amountMinor = Number(divRoundHalfUp(BigInt(milesHundredths) * BigInt(rateMinor), 100n));
  const miles = String(milesHundredths / 100);
  const unit = f.unit === "km" ? "km" : "mi";
  const purpose = String(f.purpose || "").trim().slice(0, 80);
  return {
    ok: true,
    expense: {
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(f.date || "")) ? f.date : todayIso(),
      name: "Mileage: " + miles + " " + unit + (purpose ? " · " + purpose : ""),
      amountMinor,
      currency: f.currency || "USD",
      category: "Car and travel",
      mileage: { milesHundredths, rateMinor, unit }
    }
  };
}

// Tracked time becomes invoice hours, rounded to the nearest six minutes.
function hoursFromMs(ms) {
  const tenths = Math.round(Math.max(0, Number(ms) || 0) / 360000);
  return { tenths, qtyBps: tenths * 1000, text: (tenths / 10).toFixed(1) + " h" };
}

function timerElapsed(timer, nowMs) {
  if (!timer) return 0;
  const base = Math.max(0, Number(timer.accumulatedMs) || 0);
  return timer.startedAt ? base + Math.max(0, nowMs - timer.startedAt) : base;
}

// Money expected in, and likely out, over the next few weeks.
function cashForecast(docs, transactions, today, days, currency) {
  const day = today || todayIso();
  const span = days || 30;
  const end = shiftDate(day, span);
  let inMinor = 0;
  let overdueMinor = 0;
  let count = 0;
  (docs || []).forEach((doc) => {
    if (!isOpenInvoice(doc) || doc.currency !== currency) return;
    const owe = balanceOf(doc);
    if (doc.due && doc.due < day) { overdueMinor += owe; count += 1; return; }
    if (!doc.due || doc.due <= end) { inMinor += owe; count += 1; }
  });
  const since = shiftDate(day, -90);
  let spent = 0;
  (transactions || []).forEach((tx) => {
    if (tx && tx.kind === "out" && tx.currency === currency && tx.date > since && tx.date <= day) spent += tx.amountMinor || 0;
  });
  const outMinor = Number(divRoundHalfUp(BigInt(spent) * BigInt(span), 90n));
  return { days: span, inMinor, overdueMinor, outMinor, netMinor: inMinor + overdueMinor - outMinor, invoices: count };
}

// ---- Every country, its currency, and its usual sales-tax name ----
// Country -> ISO 4217 currency. Decimal places come from the platform (Intl),
// so a currency like JPY or KWD always rounds the way its banks do.
const COUNTRY_CURRENCY = ("AD:EUR AE:AED AF:AFN AG:XCD AL:ALL AM:AMD AO:AOA AR:ARS AT:EUR AU:AUD AZ:AZN BA:BAM BB:BBD BD:BDT BE:EUR BF:XOF BG:BGN BH:BHD BI:BIF BJ:XOF BN:BND BO:BOB BR:BRL BS:BSD BT:BTN BW:BWP BY:BYN BZ:BZD "
  + "CA:CAD CD:CDF CF:XAF CG:XAF CH:CHF CI:XOF CL:CLP CM:XAF CN:CNY CO:COP CR:CRC CU:CUP CV:CVE CY:EUR CZ:CZK DE:EUR DJ:DJF DK:DKK DM:XCD DO:DOP DZ:DZD EC:USD EE:EUR EG:EGP ER:ERN ES:EUR ET:ETB FI:EUR FJ:FJD FM:USD FR:EUR "
  + "GA:XAF GB:GBP GD:XCD GE:GEL GH:GHS GM:GMD GN:GNF GQ:XAF GR:EUR GT:GTQ GW:XOF GY:GYD HK:HKD HN:HNL HR:EUR HT:HTG HU:HUF ID:IDR IE:EUR IL:ILS IN:INR IQ:IQD IR:IRR IS:ISK IT:EUR JM:JMD JO:JOD JP:JPY "
  + "KE:KES KG:KGS KH:KHR KI:AUD KM:KMF KN:XCD KR:KRW KW:KWD KZ:KZT LA:LAK LB:LBP LC:XCD LI:CHF LK:LKR LR:LRD LS:LSL LT:EUR LU:EUR LV:EUR LY:LYD MA:MAD MC:EUR MD:MDL ME:EUR MG:MGA MH:USD MK:MKD ML:XOF MM:MMK MN:MNT MO:MOP MR:MRU MT:EUR MU:MUR MV:MVR MW:MWK MX:MXN MY:MYR MZ:MZN "
  + "NA:NAD NE:XOF NG:NGN NI:NIO NL:EUR NO:NOK NP:NPR NR:AUD NZ:NZD OM:OMR PA:PAB PE:PEN PG:PGK PH:PHP PK:PKR PL:PLN PR:USD PS:ILS PT:EUR PW:USD PY:PYG QA:QAR RO:RON RS:RSD RU:RUB RW:RWF "
  + "SA:SAR SB:SBD SC:SCR SD:SDG SE:SEK SG:SGD SI:EUR SK:EUR SL:SLE SM:EUR SN:XOF SO:SOS SR:SRD SS:SSP ST:STN SV:USD SY:SYP SZ:SZL TD:XAF TG:XOF TH:THB TJ:TJS TL:USD TM:TMT TN:TND TO:TOP TR:TRY TT:TTD TV:AUD TW:TWD TZ:TZS "
  + "UA:UAH UG:UGX US:USD UY:UYU UZ:UZS VA:EUR VC:XCD VE:VES VN:VND VU:VUV WS:WST XK:EUR YE:YER ZA:ZAR ZM:ZMW ZW:USD").split(" ").reduce((map, pair) => {
  const parts = pair.split(":");
  map[parts[0]] = parts[1];
  return map;
}, {});

const GST_COUNTRIES = ["AU", "NZ", "SG", "IN", "MY", "PG", "BT"];
const IVA_COUNTRIES = ["ES", "MX", "BR", "AR", "CL", "CO", "PE", "UY", "PY", "BO", "EC", "VE", "CR", "GT", "HN", "NI", "PA", "SV", "DO", "IT", "PT"];
const NO_VAT_COUNTRIES = ["HK", "KW", "QA", "BN", "MO", "LY", "SO", "KI", "TV", "NR", "MH", "FM", "PW", "TL", "IQ", "SY", "AF", "KP"];

function currencyDigits(code) {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits;
  } catch (error) {
    return 2;
  }
}

Object.keys(COUNTRY_CURRENCY).forEach((country) => {
  const code = COUNTRY_CURRENCY[country];
  if (!CURRENCIES[code]) CURRENCIES[code] = { exponent: currencyDigits(code) };
});

function defaultTaxName(country) {
  if (TAX_NAMES[country]) return TAX_NAMES[country].en;
  if (country === "US") return "Sales tax";
  if (GST_COUNTRIES.indexOf(country) !== -1) return "GST";
  if (IVA_COUNTRIES.indexOf(country) !== -1) return "IVA";
  if (NO_VAT_COUNTRIES.indexOf(country) !== -1) return "Tax";
  return "VAT";
}

function countryName(code) {
  try {
    const names = new Intl.DisplayNames(["en"], { type: "region" });
    return names.of(code) || code;
  } catch (error) {
    return code;
  }
}

// Every country the app can be set to, sorted by name.
function countryList() {
  return Object.keys(COUNTRY_CURRENCY).map((code) => ({
    code,
    name: countryName(code),
    currency: COUNTRY_CURRENCY[code],
    taxName: defaultTaxName(code)
  })).sort((a, b) => a.name.localeCompare(b.name));
}

// ---- Files other accounting software can import ----
// QuickBooks, Xero, Sage, Wave, FreshBooks, Zoho Books, and MYOB all import
// bank statements as OFX or a Date/Description/Amount CSV. QuickBooks and Xero
// also import sales invoices from their own CSV layouts, written here exactly.

function slashDate(iso, monthFirst) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!m) return "";
  return monthFirst ? m[2] + "/" + m[3] + "/" + m[1] : m[3] + "/" + m[2] + "/" + m[1];
}

function csvLine(cells) {
  // Plain numbers (amounts, quantities, rates) go out as-is so importers read them;
  // everything else goes through the formula guard.
  return cells.map((cell) => {
    const text = cell == null ? "" : String(cell);
    return /^-?\d+(\.\d+)?%?$/.test(text) ? text : csvCell(text);
  }).join(",");
}

function issuedInvoices(docs, start, end, currency) {
  return (docs || []).filter((doc) => {
    if (!doc || doc.type !== "invoice" || doc.currency !== currency) return false;
    if (ISSUED_STORED.indexOf(doc.stored) === -1) return false;
    const day = doc.sentOn || doc.created || "";
    return day >= start && day <= end;
  }).sort((a, b) => ((a.number || "") < (b.number || "") ? -1 : 1));
}

function invoiceRows(doc) {
  const rows = [];
  (doc.lines || []).forEach((line) => {
    if (!line || line.header || line.rateMinor == null) return;
    const amountMinor = divRoundHalfUp(BigInt(line.qtyBps) * BigInt(line.rateMinor), 10000n);
    const taxBps = (Array.isArray(line.taxes) ? line.taxes : []).reduce((t, tax) => t + (tax && tax.bps > 0 ? tax.bps : 0), 0);
    rows.push({
      description: String(line.name || doc.subtitle || "Services"),
      qty: String(line.qtyBps / 10000),
      rateMinor: line.rateMinor,
      amountMinor,
      taxBps
    });
  });
  return rows;
}

function bankRows(transactions, start, end, currency) {
  return (transactions || []).filter((tx) =>
    tx && tx.currency === currency && tx.date >= start && tx.date <= end
    && (tx.kind === "in" || tx.kind === "out" || tx.kind === "refund")
  ).sort((a, b) => (a.date === b.date ? (a.id < b.id ? -1 : 1) : (a.date < b.date ? -1 : 1)));
}

function ofxText(text) {
  return String(text || "").replace(/[<>&]/g, " ").replace(/[\r\n]+/g, " ").trim().slice(0, 32) || "Transaction";
}

const ACCOUNTING_FORMATS = {
  quickbooks: { label: "QuickBooks invoices", ext: "csv" },
  xero: { label: "Xero invoices", ext: "csv" },
  bank: { label: "Bank transactions (any program)", ext: "csv" },
  ofx: { label: "OFX bank statement", ext: "ofx" },
  customers: { label: "Customers", ext: "csv" }
};

function accountingExport(format, docs, transactions, period, today, currency, country, businessName) {
  const spec = ACCOUNTING_FORMATS[format];
  if (!spec) return { ok: false, error: "bad_format" };
  const bounds = periodBounds(period, today);
  if (!bounds) return { ok: false, error: "bad_period" };
  const start = bounds.start;
  const end = bounds.end;
  const monthFirst = country === "US" || country === "PH" || country === "CA";
  const amount = (minor) => decimalAmount(minor, currency);
  const lines = [];
  let count = 0;
  if (format === "quickbooks") {
    lines.push("InvoiceNo,Customer,InvoiceDate,DueDate,Memo,Item(Product/Service),ItemDescription,ItemQuantity,ItemRate,ItemAmount,Taxable,TaxRate,Currency");
    issuedInvoices(docs, start, end, currency).forEach((doc) => {
      count += 1;
      invoiceRows(doc).forEach((row) => lines.push(csvLine([
        doc.number, doc.name, slashDate(doc.sentOn || doc.created, monthFirst), slashDate(doc.due, monthFirst),
        doc.subtitle || "", "Services", row.description, row.qty, amount(row.rateMinor), amount(row.amountMinor),
        row.taxBps ? "Y" : "N", row.taxBps ? (row.taxBps / 100) + "%" : "", currency
      ])));
    });
  } else if (format === "xero") {
    lines.push("*ContactName,EmailAddress,*InvoiceNumber,*InvoiceDate,*DueDate,*Description,*Quantity,*UnitAmount,*AccountCode,*TaxType,Currency");
    issuedInvoices(docs, start, end, currency).forEach((doc) => {
      count += 1;
      invoiceRows(doc).forEach((row) => lines.push(csvLine([
        doc.name, doc.email || "", doc.number, slashDate(doc.sentOn || doc.created, monthFirst), slashDate(doc.due, monthFirst),
        row.description, row.qty, amount(row.rateMinor), "200", row.taxBps ? "Tax on Sales" : "Tax Exempt", currency
      ])));
    });
  } else if (format === "bank") {
    lines.push("Date,Description,Amount,Category");
    bankRows(transactions, start, end, currency).forEach((tx) => {
      count += 1;
      const signed = tx.kind === "in" ? amount(tx.amountMinor) : "-" + amount(tx.amountMinor);
      lines.push(csvLine([slashDate(tx.date, monthFirst), tx.name, signed, tx.category || ""]));
    });
  } else if (format === "customers") {
    lines.push("Name,Email,Phone,Open balance,Currency");
    clientSummaries(docs, today).forEach((row) => {
      count += 1;
      lines.push(csvLine([row.name, row.email, row.phone, amount(row.owed[currency] || 0), currency]));
    });
  } else if (format === "ofx") {
    const rows = bankRows(transactions, start, end, currency);
    count = rows.length;
    const stamp = (iso) => String(iso).replace(/-/g, "") + "120000";
    const body = rows.map((tx) => {
      const signed = tx.kind === "in" ? amount(tx.amountMinor) : "-" + amount(tx.amountMinor);
      return "<STMTTRN><TRNTYPE>" + (tx.kind === "in" ? "CREDIT" : "DEBIT") + "<DTPOSTED>" + stamp(tx.date)
        + "<TRNAMT>" + signed + "<FITID>" + ofxText(tx.id) + "<NAME>" + ofxText(tx.name) + "</STMTTRN>";
    });
    const text = ["OFXHEADER:100", "DATA:OFXSGML", "VERSION:102", "SECURITY:NONE", "ENCODING:USASCII", "CHARSET:1252", "COMPRESSION:NONE", "OLDFILEUID:NONE", "NEWFILEUID:NONE", "",
      "<OFX><SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS><DTSERVER>" + stamp(today) + "<LANGUAGE>ENG</SONRS></SIGNONMSGSRSV1>",
      "<BANKMSGSRSV1><STMTTRNRS><TRNUID>1<STATUS><CODE>0<SEVERITY>INFO</STATUS><STMTRS><CURDEF>" + currency,
      "<BANKACCTFROM><BANKID>SIMPLEACCOUNTZ<ACCTID>BOOKS<ACCTTYPE>CHECKING</BANKACCTFROM>",
      "<BANKTRANLIST><DTSTART>" + stamp(start) + "<DTEND>" + stamp(end)].concat(body).concat([
      "</BANKTRANLIST><LEDGERBAL><BALAMT>0.00<DTASOF>" + stamp(end) + "</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>"
    ]).join("\r\n");
    return { ok: true, format, count, mime: "application/x-ofx", filename: "simple-accountz-" + start + "-to-" + end + ".ofx", text };
  }
  const slug = String(businessName || "simple-accountz").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "simple-accountz";
  return { ok: true, format, count, mime: "text/csv", filename: slug + "-" + format + "-" + start + "-to-" + end + ".csv", text: "﻿" + lines.join("\r\n") + "\r\n" };
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
  hasBooksData,
  uniqueId,
  otsuThreshold,
  findDocumentQuad,
  quadArea,
  quadIsSteady,
  solveHomography,
  applyHomography,
  straightenedSize,
  parseMoneyToken,
  findMoney,
  parseLooseDate,
  parseReceiptText,
  parseInvoiceText,
  ACTIVITY_MAX,
  ACTIVITY_KINDS,
  cleanActivity,
  addActivity,
  activityEntry,
  overdueActivity,
  unseenActivity,
  applyBankEvents,
  bankEventText,
  cleanPhone,
  formatPhone,
  smsLink,
  invoiceSms,
  invoiceView,
  invoicePdf,
  invoicePdfName,
  binaryToBase64,
  printLink,
  planSync,
  mergeBooks,
  mergeDeleted,
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
  exportWorkbook,
  decimalAmount,
  crc32,
  zipArchive,
  buildWorkbook,
  utf8Binary,
  platformRevenue,
  subscriptionCharges,
  clientKey,
  clientSummaries,
  owedText,
  clientStatement,
  mileageExpense,
  hoursFromMs,
  timerElapsed,
  cashForecast,
  COUNTRY_CURRENCY,
  countryList,
  countryName,
  defaultTaxName,
  currencyDigits,
  ACCOUNTING_FORMATS,
  accountingExport,
  distanceUnit,
  distanceMeters,
  newDrive,
  driveStep,
  driveDistance,
  buildOds,
  quadLooksLikePage,
  DEMO_AUTH_CODE,
  RECOVERY_TOKEN
};

if (typeof module !== "undefined" && module.exports) module.exports = SA;
if (typeof window !== "undefined") window.SA = SA;
