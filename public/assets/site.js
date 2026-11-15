/* Hourhand site behaviour. No third-party calls, no cookies, no tracking. */
(function () {
  "use strict";
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  // Year in footer
  $$("[data-year]").forEach(function (el) { el.textContent = String(new Date().getFullYear()); });

  // Mobile menu
  var menuBtn = $("[data-menu]");
  var nav = $("#site-nav");
  if (menuBtn && nav) {
    menuBtn.addEventListener("click", function () {
      var open = nav.classList.toggle("open");
      menuBtn.setAttribute("aria-expanded", String(open));
      menuBtn.textContent = open ? "Close" : "Menu";
    });
    $$("a", nav).forEach(function (a) {
      a.addEventListener("click", function () {
        if (nav.classList.contains("open")) { nav.classList.remove("open"); menuBtn.setAttribute("aria-expanded", "false"); menuBtn.textContent = "Menu"; }
      });
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && nav.classList.contains("open")) { nav.classList.remove("open"); menuBtn.setAttribute("aria-expanded", "false"); menuBtn.textContent = "Menu"; menuBtn.focus(); }
    });
  }

  function tomorrow() { return new Date(Date.now() + 86400000); }
  function fmtDate(locale) {
    try { return new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long" }).format(tomorrow()); }
    catch (e) { return ""; }
  }
  function userZone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) { return ""; }
  }

  // Hero demo: sync light and pause
  var demo = $("[data-demo]");
  if (demo) {
    var dateEl = $("[data-demo-date]", demo);
    if (dateEl) dateEl.textContent = fmtDate("en-IN") + ", times in IST";
    var slots = $$(".slot", demo);
    var bookBtn = $("[data-book]", demo);
    var slotWrap = $("[data-slots]", demo);
    var paused = $("[data-paused]", demo);
    var sw = $("[data-switch]", demo);
    var pill = $("[data-pill]", demo);
    var mail = $("[data-mail]", demo);
    var chosen = "10:30 am";
    var resetTimer = null;
    function setBookLabel() { bookBtn.textContent = "Book " + chosen; }
    slots.forEach(function (b) {
      b.addEventListener("click", function () {
        slots.forEach(function (o) { o.setAttribute("aria-pressed", "false"); });
        b.setAttribute("aria-pressed", "true");
        chosen = b.textContent.trim();
        setBookLabel();
      });
    });
    bookBtn.addEventListener("click", function () {
      if (bookBtn.disabled) return;
      bookBtn.textContent = "Booked for " + chosen + ". Confirmation sent.";
      clearTimeout(resetTimer);
      resetTimer = setTimeout(setBookLabel, 2600);
    });
    sw.addEventListener("click", function () {
      var on = sw.getAttribute("aria-checked") !== "true";
      sw.setAttribute("aria-checked", String(on));
      clearTimeout(resetTimer);
      if (on) {
        pill.className = "pill ok"; pill.textContent = "In sync, checked just now";
        slotWrap.hidden = false; paused.hidden = true; mail.hidden = true;
        bookBtn.disabled = false; setBookLabel();
      } else {
        pill.className = "pill bad"; pill.textContent = "Disconnected, bookings paused";
        slotWrap.hidden = true; paused.hidden = false; mail.hidden = false;
        bookBtn.disabled = true; bookBtn.textContent = "No times offered";
      }
    });
  }

  // Language preview
  var preview = $("[data-preview]");
  if (preview && window.HH_LANGS) {
    var tabs = $$("[data-lang]");
    var pick = $("[data-p-pick]", preview), date = $("[data-p-date]", preview), tz = $("[data-p-tz]", preview), go = $("[data-p-book]", preview), lab = $("[data-p-label]", preview);
    function show(code) {
      var L = window.HH_LANGS[code]; if (!L) return;
      preview.setAttribute("lang", code);
      lab.textContent = L.label; pick.textContent = L.pick; tz.textContent = L.tz; go.textContent = L.book;
      date.textContent = fmtDate(L.locale);
      tabs.forEach(function (t) { t.setAttribute("aria-pressed", String(t.getAttribute("data-lang") === code)); });
    }
    tabs.forEach(function (t) { t.addEventListener("click", function () { show(t.getAttribute("data-lang")); }); });
    show("hi");
  }
  var tzEl = $("[data-tz]");
  if (tzEl) { var z = userZone(); if (z) { var nice = (z === "Asia/Kolkata" || z === "Asia/Calcutta") ? "India (IST)" : z.replace(/_/g, " ").replace("/", ", "); tzEl.textContent = "Your browser is set to " + nice + ". A guest there sees your times in that zone automatically."; } }

  // Pricing
  var pricing = $("[data-pricing]");
  if (pricing && window.HH_PRICES) {
    var P = window.HH_PRICES;
    var z2 = userZone();
    var state = { region: (z2 === "Asia/Kolkata" || z2 === "Asia/Calcutta" || !z2) ? "in" : "intl", billing: "mo" };
    function render() {
      var R = P[state.region], B = R[state.billing];
      $$("[data-amt]", pricing).forEach(function (el) { el.textContent = B[el.getAttribute("data-amt")]; });
      $$("[data-note]", pricing).forEach(function (el) { el.textContent = B[el.getAttribute("data-note") + "Note"]; });
      $$("[data-per]", pricing).forEach(function (el) { el.textContent = state.billing === "yr" ? "/yr" : "/mo"; });
      var free = $("[data-free]", pricing); if (free) free.textContent = R.free;
      var tax = $("[data-tax]", pricing); if (tax) tax.textContent = R.tax;
      $$("[data-region]", pricing).forEach(function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-region") === state.region)); });
      $$("[data-billing]", pricing).forEach(function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-billing") === state.billing)); });
      $$("[data-plan-link]", pricing).forEach(function (a) {
        var u = new URL(a.getAttribute("href"), window.location.href);
        u.searchParams.set("billing", state.billing === "yr" ? "yearly" : "monthly");
        u.searchParams.set("currency", state.region === "in" ? "INR" : "USD");
        a.setAttribute("href", u.toString());
      });
    }
    $$("[data-region]", pricing).forEach(function (b) { b.addEventListener("click", function () { state.region = b.getAttribute("data-region"); render(); }); });
    $$("[data-billing]", pricing).forEach(function (b) { b.addEventListener("click", function () { state.billing = b.getAttribute("data-billing"); render(); }); });
    render();
  }
})();
