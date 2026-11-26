// Draws one invoice from the #d= part of the link and opens the print dialog.
// The data never leaves the device (the fragment is not sent to any server),
// and it is only ever shown as text, never as HTML.
(function () {
  "use strict";

  function decode(hash) {
    const match = /^#d=([A-Za-z0-9_-]+)$/.exec(hash || "");
    if (!match) return null;
    try {
      const b64 = match[1].replace(/-/g, "+").replace(/_/g, "/");
      const binary = atob(b64 + "===".slice((b64.length + 3) % 4));
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      const view = JSON.parse(new TextDecoder().decode(bytes));
      return view && typeof view === "object" && Array.isArray(view.lines) ? view : null;
    } catch (error) {
      return null;
    }
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function pretty(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
    if (!m) return "—";
    return ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m[2]) - 1] + " " + Number(m[3]) + ", " + m[1];
  }

  const view = decode(location.hash);
  const root = document.getElementById("root");
  const button = document.getElementById("print-btn");
  button.addEventListener("click", () => window.print());

  if (!view) {
    document.querySelector(".bar").hidden = true;
    root.appendChild(el("p", "empty", "Open an invoice in Simple Accountz and tap Print to see it here."));
    return;
  }

  document.title = (view.number || "Invoice") + " · " + (view.business || "Simple Accountz");
  const sheet = el("article", "sheet");
  const header = el("header");
  const left = el("div");
  left.appendChild(el("h1", null, view.business));
  left.appendChild(el("div", "sub", "INVOICE " + (view.number || "")));
  const right = el("div", "due");
  right.appendChild(el("b", null, view.balance));
  right.appendChild(el("div", "sub", "Balance due"));
  header.appendChild(left);
  header.appendChild(right);
  sheet.appendChild(header);

  const meta = el("section", "meta");
  const who = el("div");
  who.appendChild(el("small", null, "BILL TO"));
  who.appendChild(el("b", null, view.client));
  if (view.email) who.appendChild(el("span", null, view.email));
  if (view.phone) who.appendChild(el("span", null, view.phone));
  meta.appendChild(who);
  [["ISSUED", view.issued], ["DUE", view.due]].forEach(([label, value]) => {
    const box = el("div");
    box.appendChild(el("small", null, label));
    box.appendChild(el("b", null, pretty(value)));
    meta.appendChild(box);
  });
  sheet.appendChild(meta);

  const table = el("table");
  const head = el("tr");
  [["DESCRIPTION", ""], ["QTY", "num"], ["RATE", "num"], ["AMOUNT", "num"]].forEach(([label, cls]) => head.appendChild(el("th", cls, label)));
  table.appendChild(head);
  view.lines.forEach((line) => {
    const row = el("tr");
    row.appendChild(el("td", null, line.name));
    row.appendChild(el("td", "num", line.qty));
    row.appendChild(el("td", "num", line.rate));
    row.appendChild(el("td", "num", line.amount));
    table.appendChild(row);
  });
  sheet.appendChild(table);

  const totals = el("section", "totals");
  const add = (label, value, cls) => {
    const row = el("div", cls || "");
    row.appendChild(el("span", null, label));
    row.appendChild(el("span", null, value));
    totals.appendChild(row);
  };
  add("Subtotal", view.subtotal);
  add(view.taxLabel || "Tax", view.tax);
  add("Total", view.total, "strong");
  if (view.paid) add("Paid", view.paid);
  add("Balance due", view.balance, "balance");
  sheet.appendChild(totals);

  const foot = el("footer");
  foot.appendChild(el("span", null, "Thank you for your business."));
  foot.appendChild(el("span", null, "Made with Simple Accountz"));
  sheet.appendChild(foot);
  root.appendChild(sheet);

  // Open the print dialog once the page has drawn (skipped with ?noprint for checks).
  if (!/[?&]noprint\b/.test(location.search)) setTimeout(() => window.print(), 400);
})();
