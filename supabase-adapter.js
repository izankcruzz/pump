(function () {
  window.POS_SUPABASE_ADAPTER_VERSION = "2026-06-29-expense-edit-v93-wallet-cleanup-capital-badge";
  console.info("POS Supabase adapter", window.POS_SUPABASE_ADAPTER_VERSION);

  const STORAGE_URL = "POS_SUPABASE_URL";
  const STORAGE_KEY = "POS_SUPABASE_ANON_KEY";
  const SUPABASE_LOGO_URL = "https://supabase.com/dashboard/img/supabase-logo.svg";
  const FUEL_CATEGORY = "น้ำมันเชื้อเพลิง";
  const FUEL_NAMES = ["เบนซิน 95", "ดีเซล"];
  const LIVE_CUTOVER_DATE = "2026-06-12";

  let client = null;
  let authReadyResolve;
  let authReadyReject;
  let authReady = new Promise((resolve, reject) => {
    authReadyResolve = resolve;
    authReadyReject = reject;
  });

  function normalizeBaseUrl(url) {
    return String(url || "").trim().replace(/\/rest\/v1\/?$/i, "").replace(/\/+$/g, "");
  }

  function clientUrl(url) {
    return normalizeBaseUrl(url);
  }

  function moneyNumber(value) {
    return Number(value || 0);
  }

  function bkkDate(value) {
    const d = value ? new Date(value) : new Date();
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Bangkok",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(d);
  }

  function normalizeDebtCustomer(value) {
    return String(value || "").trim().toLowerCase();
  }

  function isAppDebtSale(row) {
    if (!row) return false;
    return String(row.payment_status || "").toLowerCase() === "debt"
      || String(row.source || "") === "appsmith-debt";
  }

  function isFuelDebtSale(row, product = null) {
    if (!isAppDebtSale(row)) return false;
    if (product && isFuelProduct(product)) return true;
    return FUEL_NAMES.includes(row.product_name);
  }

  function debtCustomerFromSaleNote(note) {
    const raw = String(note || "").trim();
    const match = raw.match(/^(?:debt|ค้างจ่าย)\s*:\s*([^|(]+)/i);
    return normalizeDebtCustomer(match ? match[1] : "");
  }

  function debtRowsMatchSale(sale, debt) {
    if (!sale || !debt) return false;
    if (bkkDate(sale.sold_at) !== bkkDate(debt.debt_at)) return false;
    const saleProduct = String(sale.product_id || sale.product_name || "");
    const debtProduct = String(debt.product_id || debt.product_name || "");
    if (saleProduct !== debtProduct && String(sale.product_name || "") !== String(debt.product_name || "")) return false;
    const saleAmount = Number(sale.total || Number(sale.unit_price || 0) * Number(sale.qty || 0) || 0);
    const debtAmount = Number(debt.amount || 0);
    if (Math.abs(saleAmount - debtAmount) > 1) return false;
    const saleQty = Number(sale.qty || 0);
    const debtQty = Number(debt.qty || 0);
    if (debtQty > 0 && Math.abs(saleQty - debtQty) > 0.02) return false;
    const noteCustomer = debtCustomerFromSaleNote(sale.note);
    return !noteCustomer || noteCustomer === normalizeDebtCustomer(debt.customer_name);
  }

  function filterOrphanDebtSales(sales, debts) {
    const liveDebts = (debts || []).filter(row => String(row.status || "") !== "void");
    return (sales || []).filter(row => {
      if (!isAppDebtSale(row)) return true;
      return liveDebts.some(debt => debtRowsMatchSale(row, debt));
    });
  }

  async function findDebtSaleForDebt(db, debt) {
    if (!debt) return null;
    const day = bkkDate(debt.debt_at || debt.created_at);
    let query = db
      .from("sales")
      .select("*")
      .gte("sold_at", `${day}T00:00:00+07:00`)
      .lte("sold_at", `${day}T23:59:59+07:00`)
      .eq("payment_status", "debt")
      .eq("source", "appsmith-debt")
      .order("sold_at", { ascending: false })
      .limit(50);
    if (debt.product_id) query = query.eq("product_id", debt.product_id);
    else query = query.eq("product_name", debt.product_name);
    const { data, error } = await query;
    if (error) throw error;
    return (data || []).find(row => debtRowsMatchSale(row, debt)) || null;
  }

  function ymd(year, month, day) {
    return [
      String(year).padStart(4, "0"),
      String(month).padStart(2, "0"),
      String(day).padStart(2, "0")
    ].join("-");
  }

  function addDays(dateText, days) {
    const [y, m, d] = String(dateText || bkkDate()).split("-").map(Number);
    const date = new Date(y, (m || 1) - 1, d || 1);
    date.setDate(date.getDate() + days);
    return ymd(date.getFullYear(), date.getMonth() + 1, date.getDate());
  }

  function thaiDate(value) {
    const [y, m, d] = bkkDate(value).split("-");
    return `${d}/${m}/${y}`;
  }

  function thaiTime(value) {
    const d = value ? new Date(value) : new Date();
    return new Intl.DateTimeFormat("th-TH", {
      timeZone: "Asia/Bangkok",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(d);
  }

  function isFuelProduct(row) {
    return row.is_fuel || FUEL_NAMES.includes(row.name);
  }

  function findFuelRows(rows) {
    const fuelRows = (rows || []).filter(isFuelProduct);
    const gas95 = fuelRows.find(row => String(row.name || "").includes("95"))
      || fuelRows.find(row => /gas|benz|เบนซิน|แก๊ส/i.test(String(row.name || "")))
      || fuelRows[0]
      || null;
    const diesel = fuelRows.find(row => row.id !== (gas95 && gas95.id) && /diesel|ดีเซล/i.test(String(row.name || "")))
      || fuelRows.find(row => row.id !== (gas95 && gas95.id))
      || null;
    return { gas95, diesel };
  }

  function mapProduct(row, soldRankMap) {
    const fuel = isFuelProduct(row);
    return {
      id: row.id,
      name: row.name,
      price: moneyNumber(row.sale_price),
      category: fuel ? FUEL_CATEGORY : (row.category || "สินค้า"),
      img: row.image_url || "https://placehold.co/400x400?text=No+Img",
      stock: moneyNumber(row.stock_qty),
      unit: row.unit || (fuel ? "ลิตร" : "ชิ้น"),
      soldRank: soldRankMap && soldRankMap[row.name] ? soldRankMap[row.name] : 0,
      cost: moneyNumber(row.avg_cost)
    };
  }

  async function ensureReady() {
    await authReady;
    if (!client) throw new Error("Supabase client not ready");
    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    if (!data.session) {
      showLogin();
      throw new Error("กรุณา login");
    }
    return client;
  }

  function showLogin(message) {
    const overlay = document.getElementById("supabase-login-overlay");
    if (!overlay) return;
    overlay.classList.remove("hidden");
    const status = document.getElementById("sb-login-status");
    if (status && message) status.textContent = message;
  }

  function hideLogin() {
    const overlay = document.getElementById("supabase-login-overlay");
    if (overlay) overlay.classList.add("hidden");
  }

  function setLoginStatus(text, danger) {
    const status = document.getElementById("sb-login-status");
    if (!status) return;
    status.textContent = text || "";
    status.className = danger ? "text-sm text-red-600" : "text-sm text-slate-500";
  }

  function createLoginOverlay() {
    if (document.getElementById("supabase-login-overlay")) return;
    const wrap = document.createElement("div");
    wrap.id = "supabase-login-overlay";
    wrap.className = "fixed inset-0 z-[9999] bg-slate-950/70 backdrop-blur-sm flex items-center justify-center p-4";
    wrap.innerHTML = `
      <div class="bg-white w-full max-w-lg rounded-3xl shadow-2xl border border-white/50 p-6 space-y-4">
        <div class="flex items-center gap-3">
          <div class="w-12 h-12 rounded-2xl bg-slate-950 flex items-center justify-center p-2 shadow-sm">
            <img src="${SUPABASE_LOGO_URL}" alt="Supabase" class="w-8 h-8 object-contain">
          </div>
          <div>
            <div class="font-black text-slate-800 text-xl">เชื่อม Supabase</div>
            <div class="text-xs text-slate-400">ใช้ backend ใหม่แทน Google Sheet</div>
          </div>
        </div>
        <label class="block text-sm font-bold text-slate-600">Supabase URL</label>
        <input id="sb-url" class="w-full rounded-2xl border border-slate-200 p-3 outline-none focus:ring-4 focus:ring-emerald-50 focus:border-emerald-400" placeholder="https://xxxx.supabase.co/rest/v1/">
        <label class="block text-sm font-bold text-slate-600">Publishable key</label>
        <input id="sb-key" class="w-full rounded-2xl border border-slate-200 p-3 outline-none focus:ring-4 focus:ring-emerald-50 focus:border-emerald-400" placeholder="sb_publishable_...">
        <label class="block text-sm font-bold text-slate-600">Email</label>
        <input id="sb-email" type="email" class="w-full rounded-2xl border border-slate-200 p-3 outline-none focus:ring-4 focus:ring-emerald-50 focus:border-emerald-400">
        <label class="block text-sm font-bold text-slate-600">Password</label>
        <input id="sb-password" type="password" class="w-full rounded-2xl border border-slate-200 p-3 outline-none focus:ring-4 focus:ring-emerald-50 focus:border-emerald-400">
        <button id="sb-login-btn" class="w-full bg-emerald-600 hover:bg-emerald-700 text-white rounded-2xl p-3 font-black">เข้าสู่ระบบ</button>
        <div id="sb-login-status" class="text-sm text-slate-500"></div>
      </div>`;
    document.body.appendChild(wrap);
    document.getElementById("sb-url").value = localStorage.getItem(STORAGE_URL) || "";
    document.getElementById("sb-key").value = localStorage.getItem(STORAGE_KEY) || "";
    document.getElementById("sb-login-btn").addEventListener("click", loginFromOverlay);
  }

  async function loginFromOverlay() {
    try {
      const url = clientUrl(document.getElementById("sb-url").value);
      const key = document.getElementById("sb-key").value.trim();
      const email = document.getElementById("sb-email").value.trim();
      const password = document.getElementById("sb-password").value;
      if (!url || !key || !email || !password) {
        setLoginStatus("กรอกให้ครบ", true);
        return;
      }
      localStorage.setItem(STORAGE_URL, url);
      localStorage.setItem(STORAGE_KEY, key);
      client = window.supabase.createClient(url, key);
      setLoginStatus("กำลัง login...");
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw error;
      hideLogin();
      authReadyResolve();
      if (typeof loadDataFromSheet === "function") loadDataFromSheet();
      if (typeof loadDashboard === "function") loadDashboard();
    } catch (err) {
      setLoginStatus(err.message || String(err), true);
      authReadyReject = null;
    }
  }

  async function initAuth() {
    createLoginOverlay();
    const url = localStorage.getItem(STORAGE_URL);
    const key = localStorage.getItem(STORAGE_KEY);
    if (!url || !key) {
      showLogin();
      return;
    }
    client = window.supabase.createClient(clientUrl(url), key);
    const { data } = await client.auth.getSession();
    if (data.session) {
      hideLogin();
      authReadyResolve();
    } else {
      showLogin();
    }
  }

  async function productRows() {
    const db = await ensureReady();
    const { data, error } = await db.from("v_product_stock").select("*").order("is_fuel", { ascending: false }).order("name");
    if (error) throw error;
    const rows = data || [];

    try {
      const { data: purchases, error: purchaseError } = await db
        .from("purchases")
        .select("product_id,product_name,unit_cost,avg_cost_after,purchased_at,created_at")
        .order("purchased_at", { ascending: false })
        .limit(5000);
      if (purchaseError) throw purchaseError;

      const latestCost = {};
      (purchases || []).forEach(row => {
        const cost = Number(row.avg_cost_after || row.unit_cost || 0);
        if (cost <= 0) return;
        if (row.product_name && !latestCost[row.product_name]) latestCost[row.product_name] = cost;
        if (row.product_id && !latestCost[row.product_id]) latestCost[row.product_id] = cost;
      });

      return rows.map(row => {
        const fallback = latestCost[row.name] || latestCost[row.id] || 0;
        return fallback > 0 ? { ...row, avg_cost: fallback, profit_per_unit: Number(row.sale_price || 0) - fallback } : row;
      });
    } catch (err) {
      console.warn("purchase cost fallback failed", err);
      return rows;
    }
  }

  async function soldRankMap() {
    const db = await ensureReady();
    const totals = {};
    const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await db
        .from("sales")
        .select("product_name,qty,payment_status,source")
        .neq("payment_status", "void")
        .range(from, from + pageSize - 1);
      if (error) throw error;
      (data || []).forEach(row => {
        if (isFuelDebtSale(row)) return;
        const name = row.product_name;
        if (!name) return;
        totals[name] = (totals[name] || 0) + Number(row.qty || 0);
      });
      if (!data || data.length < pageSize) break;
    }
    return totals;
  }

  async function getProductData() {
    const rows = await productRows();
    const ranks = await soldRankMap();
    const items = rows.map(row => mapProduct(row, ranks));
    const fuelItems = items.filter(item => item.category === FUEL_CATEGORY);
    const gas95 = fuelItems.find(item => String(item.name || "").includes("95"));
    const diesel = fuelItems.find(item => item !== gas95 && /diesel|ดีเซล/i.test(String(item.name || "")));
    const orderedFuels = [gas95, diesel].filter(Boolean);
    fuelItems.forEach(item => {
      if (!orderedFuels.includes(item)) orderedFuels.push(item);
    });
    return {
      fuels: orderedFuels,
      products: items.filter(item => item.category !== FUEL_CATEGORY)
    };
  }

  async function getProductListForStockIn() {
    const data = await getProductData();
    return [...data.fuels, ...data.products].map(item => ({ name: item.name, unit: item.unit }));
  }

  async function getProductPriceInfo() {
    const rows = await productRows();
    return {
      items: rows.map(row => {
        const item = mapProduct(row, {});
        return { ...item, cost: moneyNumber(row.avg_cost) };
      })
    };
  }

  async function addProduct(form) {
    const db = await ensureReady();
    const { error } = await db.rpc("app_add_product", {
      p_name: form.name,
      p_sale_price: Number(form.salePrice || 0),
      p_category: form.category || "สินค้า",
      p_unit: form.unit || "ชิ้น",
      p_image_url: form.imageUrl || null,
      p_initial_stock: Number(form.initialStock || 0),
      p_initial_cost: Number(form.initialCost || 0),
      p_is_fuel: form.category === FUEL_CATEGORY || FUEL_NAMES.includes(form.name)
    });
    if (error) throw error;
    return "เพิ่มสินค้าแล้ว";
  }

  async function updateProductPrices(form) {
    const db = await ensureReady();
    const updates = Array.isArray(form.updates) ? form.updates : [];
    for (const item of updates) {
      const { error } = await db.rpc("app_update_product_price", {
        p_product_id: item.id,
        p_new_price: Number(item.newPrice)
      });
      if (error) throw error;
    }
    return `ปรับราคาแล้ว (${updates.length} รายการ)`;
  }

  async function saveOrder(orderItems) {
    const db = await ensureReady();
    const items = (orderItems || []).map(item => ({
      product_id: item.id,
      qty: Number(item.qty || 0),
      unit_price: Number(item.price || 0),
      note: item.note || ""
    }));
    const { error } = await db.rpc("app_create_sales", { p_items: items });
    if (error) throw error;
    return "Success";
  }

  async function getFuelLogData() {
    const db = await ensureReady();
    const rows = await productRows();
    const { gas95, diesel } = findFuelRows(rows);

    async function latestFuelLog(product) {
      if (!product) return null;
      async function readLatest(table, dateColumn) {
        let query = db
          .from(table)
          .select(`product_id,product_name,meter_start,meter_end,${dateColumn}`)
          .order(dateColumn, { ascending: false })
          .limit(1);

        if (product.id) {
          const byId = await query.eq("product_id", product.id);
          if (byId.error) throw byId.error;
          if ((byId.data || [])[0]) return byId.data[0];
        }

        const byName = await db
          .from(table)
          .select(`product_id,product_name,meter_start,meter_end,${dateColumn}`)
          .eq("product_name", product.name)
          .order(dateColumn, { ascending: false })
          .limit(1);
        if (byName.error) throw byName.error;
        return (byName.data || [])[0] || null;
      }

      return await readLatest("fuel_logs", "logged_at")
        || await readLatest("fuel_tests", "tested_at");
    }

    const [gasLog, dieselLog] = await Promise.all([
      latestFuelLog(gas95),
      latestFuelLog(diesel)
    ]);

    const lastData = {
      "ดีเซล": { meter: 0, digi: 0 },
      "เบนซิน 95": { meter: 0, digi: 0 }
    };
    if (gasLog) {
      lastData["เบนซิน 95"].meter = Number(gasLog.meter_end || 0);
      lastData["เบนซิน 95"].digi = Number(gasLog.meter_end || 0);
    }
    if (dieselLog) {
      lastData["ดีเซล"].meter = Number(dieselLog.meter_end || 0);
      lastData["ดีเซล"].digi = Number(dieselLog.meter_end || 0);
    }

    const today = bkkDate();
    const { data: debts, error: debtError } = await db.from("debts").select("*").gte("debt_at", `${today}T00:00:00+07:00`).lte("debt_at", `${today}T23:59:59+07:00`).neq("status", "void");
    if (debtError) throw debtError;
    const todayDebt = { "ดีเซล": 0, "เบนซิน 95": 0 };
    (debts || []).forEach(row => {
      if ((diesel && row.product_id === diesel.id) || row.product_name === (diesel && diesel.name)) todayDebt["ดีเซล"] += Number(row.amount || 0);
      if ((gas95 && row.product_id === gas95.id) || row.product_name === (gas95 && gas95.name)) todayDebt["เบนซิน 95"] += Number(row.amount || 0);
    });

    return {
      lastData,
      currentPrices: {
        "ดีเซล": moneyNumber(diesel && diesel.sale_price),
        "เบนซิน 95": moneyNumber(gas95 && gas95.sale_price)
      },
      todayDebt
    };
  }

  async function saveFuelLog(form) {
    const db = await ensureReady();
    const rows = await productRows();
    const { gas95, diesel } = findFuelRows(rows);
    const readings = [];
    if (gas95 && form.gas95_start !== "" && form.gas95_end !== "") {
      readings.push({
        product_id: gas95.id,
        meter_start: Number(form.gas95_start || 0),
        meter_end: Number(form.gas95_end || 0),
        unit_price: Number(form.gas95_price || gas95.sale_price || 0)
      });
    }
    if (diesel && form.diesel_start !== "" && form.diesel_end !== "") {
      readings.push({
        product_id: diesel.id,
        meter_start: Number(form.diesel_start || 0),
        meter_end: Number(form.diesel_end || 0),
        unit_price: Number(form.diesel_price || diesel.sale_price || 0)
      });
    }
    const { error } = await db.rpc("app_close_fuel_shift", {
      p_readings: readings,
      p_actual_cash: form.actual_cash ? Number(form.actual_cash) : null,
      p_actual_transfer: form.actual_transfer ? Number(form.actual_transfer) : null
    });
    if (error) throw error;
    return "Success";
  }

  async function saveStockIn(items) {
    const db = await ensureReady();
    const rows = await productRows();
    const byName = Object.fromEntries(rows.map(row => [row.name, row]));
    const insertWalletEntry = async entry => {
      const { error } = await db.from("capital_wallet_entries").insert(entry);
      if (error) throw error;
    };
    for (const item of items || []) {
      if (item.type === "cashExpense" || item.type === "capitalExpense") {
        const { error } = await db.from("expenses").insert({
          title: item.productName,
          amount: Number(item.totalPrice || item.pricePerUnit || 0),
          note: "จากจัดการสต็อก",
          expense_type: item.type === "capitalExpense" ? "capital" : "expense"
        });
        if (error) throw error;
        if (item.paymentSource === "wallet") {
          await insertWalletEntry({
            tx_type: "use",
            amount: Number(item.totalPrice || item.pricePerUnit || 0),
            note: item.productName || "ใช้เงินฝากทุน",
            ref_type: "expense"
          });
        }
        continue;
      }
      const product = byName[item.productName];
      if (!product) throw new Error(`ไม่พบสินค้า: ${item.productName}`);
      const purchase = {
        product_id: product.id,
        qty: Number(item.qty || 0),
        unit_cost: Number(item.pricePerUnit || 0),
        new_sale_price: item.salePrice ? Number(item.salePrice) : null,
        note: ""
      };
      const { data, error } = await db.rpc("app_create_purchase", { p_items: [purchase] });
      if (error) throw error;
      if (item.paymentSource === "wallet") {
        const inserted = (data || [])[0] || {};
        await insertWalletEntry({
          tx_type: "use",
          amount: Number(item.totalPrice || 0),
          note: `ใช้เงินฝากซื้อ: ${item.productName}`,
          ref_type: "purchase",
          ref_id: inserted.inserted_id || null
        });
      }
    }
    return "บันทึกรับสินค้าแล้ว";
  }

  async function saveCapitalWalletEntry(form) {
    const db = await ensureReady();
    const amount = Number(form.amount || 0);
    const txType = ["deposit", "adjust"].includes(form.type) ? form.type : "deposit";
    if (amount <= 0) throw new Error("จำนวนเงินต้องมากกว่า 0");
    const { error } = await db.from("capital_wallet_entries").insert({
      tx_type: txType,
      amount,
      note: form.note || (txType === "deposit" ? "ฝากเงินทุนล่วงหน้า" : "ปรับยอดเงินฝากทุน")
    });
    if (error) throw error;
    return txType === "deposit" ? "บันทึกฝากเงินทุนแล้ว" : "ปรับยอดเงินฝากทุนแล้ว";
  }

  async function saveCapitalBalanceReset(form) {
    const db = await ensureReady();
    const amount = Number(form.amount || 0);
    const entryDate = String(form.entryDate || bkkDate()).slice(0, 10);
    const note = String(form.note || "").trim();
    if (amount < 0) throw new Error("capital balance must not be negative");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) throw new Error("invalid reset date");
    const { error } = await db.from("money_ledger").insert({
      ledger_type: "capital",
      entry_date: entryDate,
      income_amount: amount,
      expense_amount: 0,
      net_amount: amount,
      balance_amount: amount,
      income_detail: note || `Reset capital balance to ${amount.toFixed(2)}`,
      expense_detail: null,
      source: "manual-reset"
    });
    if (error) throw error;
    return "ตั้งยอดเงินทุนคงเหลือแล้ว";
  }

  async function saveCapitalMovement(form) {
    const db = await ensureReady();
    const amount = Number(form.amount || 0);
    const entryDate = String(form.entryDate || bkkDate()).slice(0, 10);
    const direction = form.direction === "out" ? "out" : "in";
    const note = String(form.note || "").trim();
    if (amount <= 0) throw new Error("capital movement amount must be greater than zero");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) throw new Error("invalid movement date");
    const isOut = direction === "out";
    const { error } = await db.from("money_ledger").insert({
      ledger_type: "capital",
      entry_date: entryDate,
      income_amount: isOut ? 0 : amount,
      expense_amount: isOut ? amount : 0,
      net_amount: isOut ? -amount : amount,
      balance_amount: 0,
      income_detail: isOut ? null : (note || `Capital deposit ${amount.toFixed(2)}`),
      expense_detail: isOut ? (note || `Capital withdrawal ${amount.toFixed(2)}`) : null,
      source: isOut ? "manual-withdraw" : "manual-deposit"
    });
    if (error) throw error;
    return isOut ? "บันทึกนำทุนออกแล้ว" : "บันทึกนำทุนเข้าแล้ว";
  }

  async function getDebtPageData() {
    const db = await ensureReady();
    const rows = await productRows();
    const products = rows.map(row => ({
      id: row.id,
      name: row.name,
      price: moneyNumber(row.sale_price),
      category: isFuelProduct(row) ? FUEL_CATEGORY : row.category,
      unit: row.unit
    }));
    const { data: unpaid, error } = await db.from("debts").select("*").in("status", ["unpaid", "partial"]).order("debt_at", { ascending: true });
    if (error) throw error;
    const debtors = [...new Set((unpaid || []).map(row => row.customer_name))].sort();
    return {
      products,
      debtors,
      unpaid: (unpaid || []).map(row => ({
        rowIndex: row.id,
        date: thaiDate(row.debt_at),
        customer: row.customer_name,
        product: row.product_name,
        qty: Number(row.qty || 0),
        amount: Number(row.amount || 0),
        filler: row.filler_name || ""
      }))
    };
  }

  async function saveDebtTransaction(form) {
    const db = await ensureReady();
    const rows = await productRows();
    const product = rows.find(row => row.name === form.productName);
    if (!product) throw new Error(`ไม่พบสินค้า: ${form.productName}`);
    const { error } = await db.rpc("app_create_debt", {
      p_customer_name: form.customerName,
      p_product_id: product.id,
      p_qty: form.qty ? Number(form.qty) : null,
      p_amount: form.totalPrice ? Number(form.totalPrice) : null,
      p_filler_name: form.fillerName || null,
      p_note: null
    });
    if (error) throw error;
    return "บันทึกหนี้แล้ว";
  }

  async function clearDebtByCustomer(customerName) {
    const db = await ensureReady();
    const { error } = await db.rpc("app_receive_debt_payment", {
      p_customer_name: customerName,
      p_amount: await unpaidAmountFor(customerName),
      p_note: "clear"
    });
    if (error) throw error;
    return "เคลียร์แล้ว";
  }

  async function unpaidAmountFor(customerName) {
    const db = await ensureReady();
    const { data, error } = await db.from("debts").select("amount").eq("customer_name", customerName).in("status", ["unpaid", "partial"]);
    if (error) throw error;
    return (data || []).reduce((sum, row) => sum + Number(row.amount || 0), 0);
  }

  async function receiveDebtPayment(form) {
    const db = await ensureReady();
    const { error } = await db.rpc("app_receive_debt_payment", {
      p_customer_name: form.customerName,
      p_amount: Number(form.amount || 0),
      p_note: form.note || null
    });
    if (error) throw error;
    return "รับชำระแล้ว";
  }

  async function saveGeneralExpense(form) {
    const db = await ensureReady();
    const { error } = await db.from("expenses").insert({
      title: form.title,
      amount: Number(form.amount || 0),
      note: form.note || null,
      expense_type: form.type === "bank" ? "bank" : "expense"
    });
    if (error) throw error;
    return "บันทึกแล้ว";
  }

  async function getDashboardData(period = "day", customDate = null, dateRange = null) {
    const db = await ensureReady();
    const rows = await productRows();
    const productByName = Object.fromEntries(rows.map(row => [row.name, row]));
    let from = bkkDate();
    let to = bkkDate();
    if (period === "month") {
      const monthMatch = String(customDate || "").match(/^(\d{4})-(\d{2})/);
      const base = customDate && !monthMatch ? new Date(customDate) : new Date();
      const y = monthMatch ? Number(monthMatch[1]) : base.getFullYear();
      const m = monthMatch ? Number(monthMatch[2]) : base.getMonth() + 1;
      const today = bkkDate();
      const monthEnd = ymd(y, m, new Date(y, m, 0).getDate());
      from = ymd(y, m, 1);
      to = from <= today && today <= monthEnd ? today : monthEnd;
    } else if (period === "range" && dateRange) {
      from = dateRange.from;
      to = dateRange.to;
    } else if (customDate) {
      from = customDate;
      to = customDate;
    }

    const requestedTo = to;
    const start = `${from}T00:00:00+07:00`;
    const end = `${to}T23:59:59+07:00`;
    const monthKey = requestedTo.slice(0, 7);
    const [profitYear, profitMonth] = monthKey.split("-").map(Number);
    const profitMonthStart = ymd(profitYear, profitMonth, 1);
    const profitMonthEnd = ymd(profitYear, profitMonth, new Date(profitYear, profitMonth, 0).getDate());
    const todayForProfit = bkkDate();
    const profitMonthTo = profitMonthStart <= todayForProfit && todayForProfit <= profitMonthEnd ? todayForProfit : profitMonthEnd;
    const profitMonthStartTs = `${profitMonthStart}T00:00:00+07:00`;
    const profitMonthEndTs = `${profitMonthTo}T23:59:59+07:00`;
    let salesQuery = db.from("sales").select("*").gte("sold_at", start).lte("sold_at", end).neq("payment_status", "void");
    if (period === "day" && from === to && from >= LIVE_CUTOVER_DATE) {
      salesQuery = salesQuery.neq("source", "sheet-import");
    }

    const [salesRes, expensesRes, purchasesRes, debtsRes, unpaidDebtsRes, paymentsRes, testsRes, monthSalesRes, monthDebtsRes] = await Promise.all([
      salesQuery,
      db.from("expenses").select("*").gte("spent_at", start).lte("spent_at", end),
      db.from("purchases").select("*").gte("purchased_at", start).lte("purchased_at", end),
      db.from("debts").select("*").gte("debt_at", start).lte("debt_at", end).neq("status", "void"),
      db.from("debts").select("*").in("status", ["unpaid", "partial"]),
      db.from("debt_payments").select("*").gte("paid_at", start).lte("paid_at", end),
      db.from("fuel_tests").select("*").gte("tested_at", start).lte("tested_at", end),
      db.from("sales").select("*").gte("sold_at", profitMonthStartTs).lte("sold_at", profitMonthEndTs).neq("payment_status", "void"),
      db.from("debts").select("*").gte("debt_at", profitMonthStartTs).lte("debt_at", profitMonthEndTs).neq("status", "void")
    ]);
    for (const res of [salesRes, expensesRes, purchasesRes, debtsRes, unpaidDebtsRes, paymentsRes, testsRes, monthSalesRes, monthDebtsRes]) if (res.error) throw res.error;

    const mergeById = (primary, fallback) => {
      const map = new Map();
      (primary || []).forEach(row => map.set(row.id || `${map.size}`, row));
      (fallback || []).forEach(row => {
        const key = row.id || `${map.size}`;
        if (!map.has(key)) map.set(key, row);
      });
      return Array.from(map.values());
    };
    const readCreatedAtFallback = async (table, select = "*", filterBuilder = null) => {
      return [];
      let query = db.from(table).select(select).gte("created_at", start).lte("created_at", end);
      if (filterBuilder) query = filterBuilder(query);
      const { data, error } = await query;
      if (error) {
        if (!String(error.message || "").includes("created_at")) throw error;
        return [];
      }
      return data || [];
    };

    const [salesByCreated, expensesByCreated, purchasesByCreated, debtsByCreated, paymentsByCreated, testsByCreated] = await Promise.all([
      readCreatedAtFallback("sales", "*", query => query.neq("payment_status", "void")),
      readCreatedAtFallback("expenses"),
      readCreatedAtFallback("purchases"),
      readCreatedAtFallback("debts", "*", query => query.neq("status", "void")),
      readCreatedAtFallback("debt_payments"),
      readCreatedAtFallback("fuel_tests")
    ]);

    const rawSales = mergeById(salesRes.data || [], salesByCreated);
    const expenses = mergeById(expensesRes.data || [], expensesByCreated);
    const purchases = mergeById(purchasesRes.data || [], purchasesByCreated);
    const debts = mergeById(debtsRes.data || [], debtsByCreated);
    const salesWithDebtRows = filterOrphanDebtSales(rawSales, debts);
    const sales = salesWithDebtRows.filter(row => !isFuelDebtSale(row, productByName[row.product_name] || null));
    const monthSales = filterOrphanDebtSales(monthSalesRes.data || [], monthDebtsRes.data || []).filter(row => !isFuelDebtSale(row, productByName[row.product_name] || null));
    const unpaidDebts = unpaidDebtsRes.data || [];
    const payments = mergeById(paymentsRes.data || [], paymentsByCreated).filter(row => row.note !== "import paid debt");
    const tests = mergeById(testsRes.data || [], testsByCreated);
    let walletEntries = [];
    try {
      const { data: walletData, error: walletError } = await db
        .from("capital_wallet_entries")
        .select("*")
        .gte("tx_at", start)
        .lte("tx_at", end);
      if (walletError) throw walletError;
      walletEntries = walletData || [];
    } catch (err) {
      if (!String(err.message || "").includes("capital_wallet_entries")) throw err;
      console.warn("capital wallet entries unavailable", err);
    }

    const salesList = sales.map(row => {
      const product = productByName[row.product_name] || {};
      const qty = Number(row.qty || 0);
      const total = Number(row.total || row.unit_price * qty || 0);
      const unitCostAtSale = Number(row.unit_cost_at_sale || 0);
      const cost = unitCostAtSale > 0 ? unitCostAtSale : Number(product.avg_cost || 0);
      const costTotal = Number(row.cost_total || 0) || (cost * qty);
      return {
        name: row.product_name,
        day: bkkDate(row.sold_at),
        qty,
        unit: row.unit,
        category: product.category || "",
        isFuel: isFuelProduct(product) || FUEL_NAMES.includes(row.product_name),
        total,
        costTotal,
        profit: total - costTotal,
        profitPerUnit: Number(row.unit_price || 0) - cost
      };
    });

    const expenseList = expenses.map(row => ({
      id: row.id,
      title: row.title,
      amount: Number(row.amount || 0),
      note: row.note || "",
      type: row.expense_type === "capital" ? "stock" : "general",
      day: bkkDate(row.spent_at)
    }));
    const purchaseList = purchases.map(row => ({
      title: `ซื้อ: ${row.product_name}`,
      name: row.product_name,
      amount: Number(row.total || Number(row.unit_cost || 0) * Number(row.qty || 0) || 0),
      qty: Number(row.qty || 0),
      unit: row.unit || (productByName[row.product_name] || {}).unit || "",
      type: "stock",
      day: bkkDate(row.purchased_at)
    }));
    const periodDebtList = debts.map(row => ({
        customer: row.customer_name,
        item: row.product_name,
        qty: Number(row.qty || 0),
        unit: (productByName[row.product_name] || {}).unit || "",
        amount: Number(row.amount || 0),
        day: bkkDate(row.debt_at),
        createdAt: row.created_at || null
      }));
    const debtList = unpaidDebts.map(row => ({
      customer: row.customer_name,
      item: row.product_name,
      qty: Number(row.qty || 0),
      unit: (productByName[row.product_name] || {}).unit || "",
      amount: Number(row.amount || 0),
      createdAt: row.created_at || null
    }));
    const repayList = payments.map(row => ({
      customer: row.customer_name,
      debtDate: thaiDate(row.paid_at),
      day: bkkDate(row.paid_at),
      amount: Number(row.amount || 0)
    }));
    const fuelTests = tests.map(row => ({
      type: row.product_name,
      time: thaiTime(row.tested_at),
      qty: Number(row.qty || 0)
    }));
    const walletList = walletEntries.map(row => ({
      id: row.id,
      type: row.tx_type,
      amount: Number(row.amount || 0),
      note: row.note || "",
      day: bkkDate(row.tx_at)
    }));
    const saleProfitFromRows = rows => (rows || []).reduce((sum, row) => {
      const product = productByName[row.product_name] || {};
      const qty = Number(row.qty || 0);
      const total = Number(row.total || row.unit_price * qty || 0);
      const unitCostAtSale = Number(row.unit_cost_at_sale || 0);
      const cost = unitCostAtSale > 0 ? unitCostAtSale : Number(product.avg_cost || 0);
      const costTotal = Number(row.cost_total || 0) || (cost * qty);
      return sum + total - costTotal;
    }, 0);

    const totalSales = salesList.reduce((sum, row) => sum + row.total, 0);
    const totalExpenses = expenseList.reduce((sum, row) => sum + row.amount, 0);
    const totalDebt = periodDebtList.reduce((sum, row) => sum + row.amount, 0);
    const debtRepaid = repayList.reduce((sum, row) => sum + row.amount, 0);
    const walletDeposit = walletList.filter(row => row.type === "deposit").reduce((sum, row) => sum + row.amount, 0);
    const walletUsed = walletList.filter(row => row.type === "use").reduce((sum, row) => sum + row.amount, 0);
    const walletAdjust = walletList.filter(row => row.type === "adjust").reduce((sum, row) => sum + row.amount, 0);
    const liveProfit = salesList.reduce((sum, row) => sum + row.profit, 0);
    const monthlyProfit = saleProfitFromRows(monthSales);
    const liveCapitalReturned = salesList.reduce((sum, row) => sum + row.costTotal, 0);
    const livePurchasePaid = purchaseList.reduce((sum, row) => sum + row.amount, 0);
    const liveStockPaid = livePurchasePaid + expenseList.filter(row => row.type === "stock").reduce((sum, row) => sum + row.amount, 0);
    const liveGeneralExpenses = expenseList.filter(row => row.type !== "stock").reduce((sum, row) => sum + row.amount, 0);
    const balanceDate = requestedTo;
    const ledgerBalances = await getArchiveBalances(balanceDate, "month", `${balanceDate.slice(0, 7)}-01`);
    const balanceDeltas = await getBalanceDeltas(db, productByName, ledgerBalances, balanceDate);
    const capitalReturned = liveCapitalReturned;
    const stockPaid = liveStockPaid;
    const generalExpenses = liveGeneralExpenses;
    const profit = liveProfit;
    const headerNetProfit = liveProfit - liveGeneralExpenses;
    const capitalManualIn = balanceDeltas.capitalManualIn || 0;
    const capitalManualOut = balanceDeltas.capitalManualOut || 0;
    const capitalBalance = ledgerBalances.capital !== null
      ? ledgerBalances.capital + balanceDeltas.capitalReturned - balanceDeltas.stockPaid + capitalManualIn - capitalManualOut
      : liveCapitalReturned - liveStockPaid + capitalManualIn - capitalManualOut;
    const profitBalance = ledgerBalances.profit !== null
      ? ledgerBalances.profit + balanceDeltas.profit - balanceDeltas.generalExpenses
      : liveProfit - liveGeneralExpenses;
    const netCash = totalSales + walletUsed - stockPaid - totalDebt - generalExpenses + debtRepaid;
    const sumRowsByName = items => {
      const map = new Map();
      (items || []).forEach(item => {
        const key = item.name || item.title || "";
        if (!key) return;
        const old = map.get(key) || {
          name: key,
          title: item.title || key,
          qty: 0,
          unit: item.unit || "",
          total: 0,
          amount: 0,
          profit: 0,
          costTotal: 0,
          type: item.type || "stock"
        };
        old.qty += Number(item.qty || 0);
        old.total += Number(item.total || item.amount || 0);
        old.amount += Number(item.amount || item.total || 0);
        old.profit += Number(item.profit || 0);
        old.costTotal += Number(item.costTotal || 0);
        old.unit = old.unit || item.unit || "";
        old.type = old.type || item.type || "stock";
        map.set(key, old);
      });
      return Array.from(map.values()).sort((a, b) => b.total - a.total || b.qty - a.qty || a.name.localeCompare(b.name));
    };
    const sortByQtySold = items => (items || [])
      .slice()
      .sort((a, b) => (Number(b.qty) || 0) - (Number(a.qty) || 0)
        || (Number(b.total) || 0) - (Number(a.total) || 0)
        || String(a.name || "").localeCompare(String(b.name || "")));
    const fuelSales = sumRowsByName(salesList.filter(row => row.isFuel));
    const engineOilSales = sumRowsByName(salesList.filter(row => !row.isFuel));
    const bestSellerItems = sortByQtySold(sumRowsByName(salesList));
    const monthlyPayments = [...sumRowsByName(purchaseList), ...expenseList.filter(row => row.type !== "stock")];
    const capitalItems = [...sumRowsByName(purchaseList), ...expenseList.filter(row => row.type === "stock")];
    const chartDays = [];
    for (let day = from; day <= to; day = addDays(day, 1)) {
      chartDays.push(day);
      if (chartDays.length > 370) break;
    }
    const emptyChartDay = () => ({ total: 0, capital: 0, profit: 0, stockPaid: 0, walletUsed: 0, debt: 0, repaid: 0 });
    const chartByDay = Object.fromEntries(chartDays.map(day => [day, emptyChartDay()]));
    salesList.forEach(row => {
      const day = row.day || bkkDate();
      if (!chartByDay[day]) chartByDay[day] = emptyChartDay();
      chartByDay[day].total += Number(row.total || 0);
      chartByDay[day].capital += Number(row.costTotal || 0);
      chartByDay[day].profit += Number(row.profit || 0);
    });
    purchaseList.forEach(row => {
      const day = row.day || bkkDate();
      if (!chartByDay[day]) chartByDay[day] = emptyChartDay();
      chartByDay[day].stockPaid += Number(row.amount || 0);
    });
    expenseList.filter(row => row.type === "stock").forEach(row => {
      const day = row.day || bkkDate();
      if (!chartByDay[day]) chartByDay[day] = emptyChartDay();
      chartByDay[day].stockPaid += Number(row.amount || 0);
    });
    periodDebtList.forEach(row => {
      const day = row.day || bkkDate();
      if (!chartByDay[day]) chartByDay[day] = emptyChartDay();
      chartByDay[day].debt += Number(row.amount || 0);
    });
    walletList.filter(row => row.type === "use").forEach(row => {
      const day = row.day || bkkDate();
      if (!chartByDay[day]) chartByDay[day] = emptyChartDay();
      chartByDay[day].walletUsed += Number(row.amount || 0);
    });
    repayList.forEach(row => {
      const day = row.day || bkkDate();
      if (!chartByDay[day]) chartByDay[day] = emptyChartDay();
      chartByDay[day].repaid += Number(row.amount || 0);
    });
    return {
      summary: {
        sales: totalSales,
        expenses: totalExpenses,
        debt: totalDebt,
        cash: netCash,
        profit,
        monthlyProfit,
        netProfit: headerNetProfit,
        actualReceived: totalSales - totalDebt + debtRepaid,
        grocery: 0,
        stockPaid,
        debtRepaid,
        walletDeposit,
        walletUsed,
        walletAdjust,
        walletBalance: walletDeposit + walletAdjust - walletUsed,
        capitalReturned,
        capitalManualIn,
        capitalManualOut,
        capitalNet: capitalReturned - stockPaid,
        capitalBalance,
        profitBalance,
        openingCapitalBalance: ledgerBalances.capital,
        openingProfitBalance: ledgerBalances.profit,
        balanceDeltaCapitalReturned: balanceDeltas.capitalReturned,
        balanceDeltaStockPaid: balanceDeltas.stockPaid,
        balanceDeltaCapitalManualIn: capitalManualIn,
        balanceDeltaCapitalManualOut: capitalManualOut,
        balanceDeltaProfit: balanceDeltas.profit,
        balanceDeltaGeneralExpenses: balanceDeltas.generalExpenses,
        generalExpenses
      },
      prices: {
        "เบนซิน 95": Number((productByName["เบนซิน 95"] || {}).sale_price || 0),
        "ดีเซล": Number((productByName["ดีเซล"] || {}).sale_price || 0)
      },
      lists: {
        sales: salesList,
        expenses: expenseList,
        capital: capitalItems,
        debts: periodDebtList,
        repayments: repayList,
        wallet: walletList,
        fuelTests
      },
      chart: {
        labels: chartDays.map(day => thaiDate(day)),
        data: {
          total: chartDays.map(day => chartByDay[day].total),
          capital: chartDays.map(day => chartByDay[day].capital),
          profit: chartDays.map(day => chartByDay[day].profit),
          stockPaid: chartDays.map(day => chartByDay[day].stockPaid),
          walletUsed: chartDays.map(day => chartByDay[day].walletUsed),
          debt: chartDays.map(day => chartByDay[day].debt),
          repaid: chartDays.map(day => chartByDay[day].repaid),
          sales: chartDays.map(day => chartByDay[day].total),
          cash: chartDays.map(day => chartByDay[day].capital),
          totals: {
            total: totalSales,
            capital: capitalReturned,
            profit,
            stockPaid,
            walletUsed,
            debt: totalDebt,
            repaid: debtRepaid,
            net: netCash
          }
        }
      },
      monthlyOilSummary: {
        profitDays: [],
        repayments: repayList,
        debts: periodDebtList,
        payments: monthlyPayments,
        salesTotal: fuelSales.concat(engineOilSales).reduce((sum, row) => sum + Number(row.total || 0), 0),
        paymentsTotal: monthlyPayments.reduce((sum, row) => sum + Number(row.amount || 0), 0),
        debtTotal: totalDebt,
        repaidTotal: debtRepaid,
        sales: { fuel: fuelSales, engineOil: engineOilSales },
        profitItems: bestSellerItems,
        requestedTo,
        cutoffTo: to
      }
    };
  }

  async function getArchiveBalances(toDate, period = "day", fromDate = null) {
    const db = await ensureReady();
    const isMonthView = period === "month";
    const monthStart = `${String(toDate).slice(0, 7)}-01`;
    const periodStart = isMonthView ? monthStart : (fromDate || toDate);
    const result = {
      capital: null,
      profit: null,
      capitalDate: null,
      profitDate: null,
      capitalCreatedAt: null,
      profitCreatedAt: null,
      periodCapitalIncome: null,
      periodCapitalExpense: null,
      periodCapitalNet: null,
      periodProfitIncome: null,
      periodProfitExpense: null,
      periodProfitNet: null
    };

    const num = value => Number(value || 0);
    const closeMoney = (a, b) => Math.abs(num(a) - num(b)) < 0.01;
    const rowNet = row => (
      row.net_amount !== null && row.net_amount !== undefined
        ? num(row.net_amount)
        : num(row.income_amount) - num(row.expense_amount)
    );
    const summarizeLedgerRows = rows => (rows || []).reduce((sum, row) => {
      sum.income += num(row.income_amount);
      sum.expense += num(row.expense_amount);
      sum.net += rowNet(row);
      return sum;
    }, { income: 0, expense: 0, net: 0 });
    const latestValue = values => values.filter(Boolean).map(String).sort().pop() || null;
    const readManualReset = async ledgerType => {
      if (!toDate) return;
      const { data, error } = await db
        .from("money_ledger")
        .select("entry_date,balance_amount,created_at")
        .eq("ledger_type", ledgerType)
        .eq("source", "manual-reset")
        .lte("entry_date", toDate)
        .order("entry_date", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(1);
      if (error) throw error;
      const row = (data || [])[0];
      if (!row) return;
      if (ledgerType === "capital") {
        result.capital = num(row.balance_amount);
        result.capitalDate = row.entry_date;
        result.capitalCreatedAt = row.created_at || null;
      }
      if (ledgerType === "profit") {
        result.profit = num(row.balance_amount);
        result.profitDate = row.entry_date;
        result.profitCreatedAt = row.created_at || null;
      }
    };
    const findMonthlyTotalRow = rows => {
      const list = rows || [];
      if (list.length < 2) return null;
      const total = summarizeLedgerRows(list);
      return list.find(row => {
        const checks = [];
        const income = num(row.income_amount);
        const expense = num(row.expense_amount);
        const net = rowNet(row);
        if (Math.abs(income) > 0.01) checks.push(closeMoney(total.income - income, income));
        if (Math.abs(expense) > 0.01) checks.push(closeMoney(total.expense - expense, expense));
        if (Math.abs(net) > 0.01) checks.push(closeMoney(total.net - net, net));
        return checks.length >= 2 && checks.every(Boolean);
      }) || null;
    };
    const balanceFromRows = (rows, summary) => {
      const list = rows || [];
      if (list.length === 1) {
        const balance = num(list[0].balance_amount);
        if (Math.abs(balance) > 0.01) return balance;
      }
      return summary.net;
    };
    const betweenPeriod = row => row.entry_date >= periodStart && row.entry_date <= toDate;

    const readLedgerSummary = async ledgerType => {
      if (!toDate) return;
      if (ledgerType === "capital" && result.capital !== null) return;
      if (ledgerType === "profit" && result.profit !== null) return;
      const { data, error } = await db
        .from("money_ledger")
        .select("entry_date,income_amount,expense_amount,net_amount,balance_amount,created_at")
        .eq("ledger_type", ledgerType)
        .gte("entry_date", monthStart)
        .lte("entry_date", toDate)
        .order("entry_date", { ascending: false })
        .order("created_at", { ascending: false });
      if (error) throw error;
      const rows = data || [];
      if (!rows.length) return;

      const monthlyTotalRow = findMonthlyTotalRow(rows);
      const detailRows = monthlyTotalRow ? rows.filter(row => row !== monthlyTotalRow) : rows;
      const isCapitalCarryRow = row => {
        if (ledgerType !== "capital") return false;
        if (row.entry_date !== monthStart) return false;
        if (String(row.income_detail || "").trim() || String(row.expense_detail || "").trim()) return false;
        const net = rowNet(row);
        const balance = num(row.balance_amount);
        return balance > 0 && Math.abs(net) > 0.01 && Math.abs(balance - net) > 0.01;
      };
      const periodDetailRows = detailRows.filter(row => !isCapitalCarryRow(row));
      const periodRows = isMonthView
        ? (monthlyTotalRow ? [monthlyTotalRow] : periodDetailRows)
        : periodDetailRows.filter(betweenPeriod);
      const periodSummary = summarizeLedgerRows(periodRows);
      const balanceRows = monthlyTotalRow ? [monthlyTotalRow] : detailRows;
      const balanceSummary = summarizeLedgerRows(balanceRows);
      const coveredRows = detailRows.length ? detailRows : balanceRows;
      const coveredDate = latestValue(coveredRows.map(row => row.entry_date));
      const coveredCreatedAt = latestValue(coveredRows.map(row => row.created_at));

      if (ledgerType === "capital") {
        if (periodRows.length || isMonthView) {
          result.periodCapitalIncome = periodSummary.income;
          result.periodCapitalExpense = periodSummary.expense;
          result.periodCapitalNet = periodSummary.net;
        }
        result.capital = balanceFromRows(balanceRows, balanceSummary);
        result.capitalDate = coveredDate;
        result.capitalCreatedAt = coveredCreatedAt;
      }
      if (ledgerType === "profit") {
        if (periodRows.length || isMonthView) {
          result.periodProfitIncome = periodSummary.income;
          result.periodProfitExpense = periodSummary.expense;
          result.periodProfitNet = periodSummary.net;
        }
        result.profit = balanceFromRows(balanceRows, balanceSummary);
        result.profitDate = coveredDate;
        result.profitCreatedAt = coveredCreatedAt;
      }
    };

    try {
      await readManualReset("capital");
      await readManualReset("profit");
      await readLedgerSummary("capital");
      await readLedgerSummary("profit");
    } catch (err) {
      if (!String(err.message || "").includes("money_ledger")) {
        console.warn("monthly ledger summary lookup failed", err);
      }
    }

    const readDailyCapital = async useDateFilter => {
      let query = db
        .from("daily_summaries")
        .select("summary_date,capital_balance,created_at")
        .neq("capital_balance", 0)
        .order("summary_date", { ascending: false })
        .limit(1);
      if (useDateFilter && toDate) query = query.gte("summary_date", periodStart).lte("summary_date", toDate);
      const { data, error } = await query;
      if (error) throw error;
      const row = (data || [])[0];
      if (!row) return;
      result.capital = Number(row.capital_balance || 0);
      result.capitalDate = row.summary_date;
      result.capitalCreatedAt = row.created_at || null;
    };

    try {
      if (result.capital === null) await readDailyCapital(true);
    } catch (err) {
      if (!String(err.message || "").includes("daily_summaries")) {
        console.warn("daily capital lookup failed", err);
      }
    }

    const readLedgerType = async (ledgerType, useDateFilter) => {
      let query = db
        .from("money_ledger")
        .select("ledger_type,entry_date,income_amount,expense_amount,net_amount,balance_amount,created_at")
        .eq("ledger_type", ledgerType)
        .order("entry_date", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(30);
      if (useDateFilter && toDate) query = query.gte("entry_date", monthStart).lte("entry_date", toDate);
      const { data, error } = await query;
      if (error) throw error;
      const rows = data || [];
      let row = rows[0];
      if (ledgerType === "profit") {
        const looksLikeMonthlyNetOnly = candidate => {
          const balance = Number(candidate.balance_amount || 0);
          const net = candidate.net_amount !== null && candidate.net_amount !== undefined
            ? Number(candidate.net_amount || 0)
            : Number(candidate.income_amount || 0) - Number(candidate.expense_amount || 0);
          if (!balance || Math.abs(balance - net) > 0.01) return false;
          return rows.some(other => Math.abs(Number(other.balance_amount || 0)) > Math.abs(balance) + 0.01);
        };
        row = rows.find(candidate => Number(candidate.balance_amount || 0) !== 0 && !looksLikeMonthlyNetOnly(candidate))
          || rows.find(candidate => Number(candidate.balance_amount || 0) !== 0)
          || rows.find(candidate => !looksLikeMonthlyNetOnly(candidate))
          || rows[0];
      }
      if (!row) return;
      if (ledgerType === "capital") {
        result.capital = Number(row.balance_amount || 0);
        result.capitalDate = row.entry_date;
        result.capitalCreatedAt = row.created_at || null;
      }
      if (ledgerType === "profit") {
        result.profit = Number(row.balance_amount || 0);
        result.profitDate = row.entry_date;
        result.profitCreatedAt = row.created_at || null;
      }
    };

    try {
      if (result.profit === null) await readLedgerType("profit", true);
      if (result.capital === null) await readLedgerType("capital", true);
    } catch (err) {
      if (!String(err.message || "").includes("money_ledger")) {
        console.warn("money_ledger balance lookup failed", err);
      }
    }

    if (result.capital !== null && result.profit !== null) return result;

    const applyDailySummary = row => {
      if (!row) return;
      if (result.capital === null) {
        result.capital = Number(row.capital_balance || 0);
        result.capitalDate = row.summary_date;
        result.capitalCreatedAt = row.created_at || null;
      }
      if (result.profit === null) {
        result.profit = Number(row.profit || 0);
        result.profitDate = row.summary_date;
        result.profitCreatedAt = row.created_at || null;
      }
    };

    const readDailySummary = async useDateFilter => {
      let query = db
        .from("daily_summaries")
        .select("summary_date,capital_balance,profit,created_at")
        .order("summary_date", { ascending: false })
        .limit(1);
      if (useDateFilter && toDate) query = query.gte("summary_date", monthStart).lte("summary_date", toDate);
      const { data, error } = await query;
      if (error) throw error;
      applyDailySummary((data || [])[0]);
    };

    try {
      await readDailySummary(true);
    } catch (err) {
      if (!String(err.message || "").includes("daily_summaries")) {
        console.warn("daily_summaries balance lookup failed", err);
      }
    }

    return result;
  }

  async function getBalanceDeltas(db, productByName, ledgerBalances, toDate) {
    const result = { capitalReturned: 0, stockPaid: 0, profit: 0, generalExpenses: 0, capitalManualIn: 0, capitalManualOut: 0 };
    const startDates = [ledgerBalances.capitalDate, ledgerBalances.profitDate]
      .filter(Boolean)
      .map(String);
    if (startDates.length === 0) return result;

    const fromDate = startDates.sort()[0];
    if (fromDate > toDate) return result;

    const start = `${fromDate}T00:00:00+07:00`;
    const end = `${toDate}T23:59:59+07:00`;
    const [salesRes, expensesRes, purchasesRes, ledgerRes] = await Promise.all([
      db.from("sales").select("*").gte("sold_at", start).lte("sold_at", end).neq("payment_status", "void"),
      db.from("expenses").select("*").gte("spent_at", start).lte("spent_at", end),
      db.from("purchases").select("*").gte("purchased_at", start).lte("purchased_at", end),
      db.from("money_ledger").select("*").eq("ledger_type", "capital").in("source", ["manual-deposit", "manual-withdraw"]).gte("entry_date", fromDate).lte("entry_date", toDate)
    ]);
    if (salesRes.error) throw salesRes.error;
    if (expensesRes.error) throw expensesRes.error;
    if (purchasesRes.error) throw purchasesRes.error;
    if (ledgerRes.error) throw ledgerRes.error;

    const shouldApplyDelta = (day, ledgerDate, cutoff, createdAt) => {
      if (!ledgerDate) return true;
      if (day > ledgerDate) return true;
      if (day < ledgerDate) return false;
      if (!cutoff || !createdAt) return false;
      return new Date(createdAt).getTime() > new Date(cutoff).getTime() + 1000;
    };

    (salesRes.data || []).forEach(row => {
      const day = bkkDate(row.sold_at);
      const product = productByName[row.product_name] || {};
      if (isFuelDebtSale(row, product)) return;
      const qty = Number(row.qty || 0);
      const total = Number(row.total || row.unit_price * qty || 0);
      const unitCostAtSale = Number(row.unit_cost_at_sale || 0);
      const costTotal = Number(row.cost_total || 0) || (unitCostAtSale > 0 ? unitCostAtSale : Number(product.avg_cost || 0)) * qty;
      if (shouldApplyDelta(day, ledgerBalances.capitalDate, ledgerBalances.capitalCreatedAt, row.created_at)) result.capitalReturned += costTotal;
      if (shouldApplyDelta(day, ledgerBalances.profitDate, ledgerBalances.profitCreatedAt, row.created_at)) result.profit += total - costTotal;
    });

    (expensesRes.data || []).forEach(row => {
      const day = bkkDate(row.spent_at);
      const amount = Number(row.amount || 0);
      if (row.expense_type === "capital") {
        if (shouldApplyDelta(day, ledgerBalances.capitalDate, ledgerBalances.capitalCreatedAt, row.created_at)) result.stockPaid += amount;
      } else if (shouldApplyDelta(day, ledgerBalances.profitDate, ledgerBalances.profitCreatedAt, row.created_at)) {
        result.generalExpenses += amount;
      }
    });

    (purchasesRes.data || []).forEach(row => {
      const day = bkkDate(row.purchased_at);
      const amount = Number(row.total || Number(row.unit_cost || 0) * Number(row.qty || 0) || 0);
      if (shouldApplyDelta(day, ledgerBalances.capitalDate, ledgerBalances.capitalCreatedAt, row.created_at)) result.stockPaid += amount;
    });

    (ledgerRes.data || []).forEach(row => {
      const day = String(row.entry_date || "").slice(0, 10);
      if (!shouldApplyDelta(day, ledgerBalances.capitalDate, ledgerBalances.capitalCreatedAt, row.created_at)) return;
      if (row.source === "manual-deposit") result.capitalManualIn += Number(row.income_amount || row.net_amount || 0);
      if (row.source === "manual-withdraw") result.capitalManualOut += Number(row.expense_amount || Math.abs(Number(row.net_amount || 0)) || 0);
    });

    return result;
  }

  async function getOilPriceInfo() {
    const rows = await productRows();
    const byName = Object.fromEntries(rows.map(row => [row.name, row]));
    return {
      prices: {
        "เบนซิน 95": Number((byName["เบนซิน 95"] || {}).sale_price || 0),
        "ดีเซล": Number((byName["ดีเซล"] || {}).sale_price || 0)
      },
      costs: {
        "เบนซิน 95": Number((byName["เบนซิน 95"] || {}).avg_cost || 0),
        "ดีเซล": Number((byName["ดีเซล"] || {}).avg_cost || 0)
      }
    };
  }

  async function updateOilPrices(form) {
    const rows = await productRows();
    const updates = [];
    const byName = Object.fromEntries(rows.map(row => [row.name, row]));
    if (byName["เบนซิน 95"] && form.new_gas95) updates.push({ id: byName["เบนซิน 95"].id, newPrice: Number(form.new_gas95) });
    if (byName["ดีเซล"] && form.new_diesel) updates.push({ id: byName["ดีเซล"].id, newPrice: Number(form.new_diesel) });
    return updateProductPrices({ updates });
  }

  async function saveFuelTest(form) {
    const db = await ensureReady();
    const rows = await productRows();
    const product = rows.find(row => row.name === form.fuelType);
    if (!product) throw new Error("ไม่พบน้ำมัน");
    const { error } = await db.rpc("app_save_fuel_test", {
      p_product_id: product.id,
      p_meter_start: Number(form.meterStart || 0),
      p_meter_end: Number(form.meterEnd || 0),
      p_note: form.note || null
    });
    if (error) throw error;
    return "บันทึกทดสอบน้ำมันแล้ว";
  }

  async function getFuelTestHistory() {
    const db = await ensureReady();
    const today = bkkDate();
    const { data, error } = await db.from("fuel_tests").select("*").gte("tested_at", `${today}T00:00:00+07:00`).lte("tested_at", `${today}T23:59:59+07:00`).order("tested_at", { ascending: false });
    if (error) throw error;
    return (data || []).map(row => ({
      rowIndex: row.id,
      time: thaiTime(row.tested_at),
      type: row.product_name,
      meterStart: Number(row.meter_start || 0),
      meterEnd: Number(row.meter_end || 0),
      qty: Number(row.qty || 0),
      note: row.note || "",
      rawDate: thaiDate(row.tested_at)
    }));
  }

  async function findFuelLogForSale(db, sale) {
    if (!sale) return null;
    if (sale.fuel_log_id) {
      const linked = await db.from("fuel_logs").select("*").eq("id", sale.fuel_log_id).maybeSingle();
      if (linked.error) throw linked.error;
      if (linked.data) return linked.data;
    }

    const soldAt = sale.sold_at || sale.created_at || new Date().toISOString();
    const day = bkkDate(soldAt);
    const start = `${day}T00:00:00+07:00`;
    const end = `${day}T23:59:59+07:00`;

    async function readLogs(matchById) {
      let query = db
        .from("fuel_logs")
        .select("*")
        .gte("logged_at", start)
        .lte("logged_at", end)
        .order("logged_at", { ascending: false })
        .limit(100);
      if (matchById && sale.product_id) query = query.eq("product_id", sale.product_id);
      else query = query.eq("product_name", sale.product_name);
      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    }

    let logs = sale.product_id ? await readLogs(true) : [];
    if (!logs.length && sale.product_name) logs = await readLogs(false);
    logs = logs.filter(row => String(row.note || "").toLowerCase() !== "fuel test");
    if (!logs.length) return null;

    const saleTime = new Date(soldAt).getTime();
    const salePrice = Number(sale.unit_price || 0);
    const saleQty = Number(sale.qty || 0);
    const scored = logs.map(row => {
      const timeDiff = Math.abs(new Date(row.logged_at || row.created_at || soldAt).getTime() - saleTime);
      const priceDiff = Math.abs(Number(row.unit_price || 0) - salePrice);
      const qtyDiff = Math.abs(Number(row.qty || 0) - saleQty);
      return { row, timeDiff, score: timeDiff + (priceDiff * 60000) + (qtyDiff * 1000) };
    }).sort((a, b) => a.score - b.score);

    return scored[0] && scored[0].timeDiff <= 10 * 60 * 1000 ? scored[0].row : null;
  }

  async function findFuelLogForTest(db, test) {
    if (!test) return null;
    const day = bkkDate(test.tested_at || test.created_at || new Date().toISOString());
    let query = db
      .from("fuel_logs")
      .select("*")
      .gte("logged_at", `${day}T00:00:00+07:00`)
      .lte("logged_at", `${day}T23:59:59+07:00`)
      .eq("meter_start", Number(test.meter_start || 0))
      .eq("meter_end", Number(test.meter_end || 0))
      .order("logged_at", { ascending: false })
      .limit(20);
    if (test.product_id) query = query.eq("product_id", test.product_id);
    else query = query.eq("product_name", test.product_name);
    const { data, error } = await query;
    if (error) throw error;
    const rows = data || [];
    return rows.find(row => String(row.note || "").toLowerCase() === "fuel test") || rows[0] || null;
  }

  async function getRecentHistory(type) {
    const db = await ensureReady();
    const table = type === "expense" ? "expenses" : type === "stock" ? "purchases" : type === "debt" ? "debts" : "sales";
    const dateCol = table === "expenses" ? "spent_at" : table === "purchases" ? "purchased_at" : table === "debts" ? "debt_at" : "sold_at";
    const today = bkkDate();
    const { data, error } = await db
      .from(table)
      .select("*")
      .gte(dateCol, `${today}T00:00:00+07:00`)
      .lte(dateCol, `${today}T23:59:59+07:00`)
      .order(dateCol, { ascending: false })
      .limit(100);
    if (error) throw error;
    const rows = data || [];
    if (table === "sales") {
      const { data: dayDebts, error: debtError } = await db
        .from("debts")
        .select("*")
        .gte("debt_at", `${today}T00:00:00+07:00`)
        .lte("debt_at", `${today}T23:59:59+07:00`)
        .neq("status", "void");
      if (debtError) throw debtError;
      const products = await productRows();
      const fuelKeys = new Set(products.filter(isFuelProduct).flatMap(row => [row.id, row.name]).filter(Boolean));
      return Promise.all(filterOrphanDebtSales(rows, dayDebts || []).filter(row => !isFuelDebtSale(row)).map(async row => {
        const isFuelSale = fuelKeys.has(row.product_id) || fuelKeys.has(row.product_name) || FUEL_NAMES.includes(row.product_name);
        const log = isFuelSale ? await findFuelLogForSale(db, row) : null;
        return {
          rowIndex: row.id,
          data: [thaiDate(row.sold_at), row.product_name, row.unit_price, row.qty, row.unit, row.total, row.note || ""],
          extra: log ? {
            fuelLogId: log.id,
            start: Number(log.meter_start || 0),
            end: Number(log.meter_end || 0),
            qty: Number(log.qty || 0),
            stockAfter: Number(log.stock_after || 0)
          } : null
        };
      }));
    }
    return rows.map(row => {
      if (table === "expenses") return { rowIndex: row.id, data: [thaiDate(row.spent_at), row.title, row.amount, row.amount, row.note || ""] };
      if (table === "purchases") return { rowIndex: row.id, data: [thaiDate(row.purchased_at), row.product_name, row.unit_cost, row.qty, row.unit, row.total, row.avg_cost_after] };
      if (table === "debts") return { rowIndex: row.id, data: [thaiDate(row.debt_at), row.customer_name, row.product_name, row.qty, row.amount, row.filler_name || ""] };
      return { rowIndex: row.id, data: [thaiDate(row.sold_at), row.product_name, row.unit_price, row.qty, row.unit, row.total, row.note || ""] };
    });
  }

  async function updateHistoryRow(type, rowIndex, form = {}) {
    const db = await ensureReady();
    const table = type === "expense" ? "expenses" : type === "stock" ? "purchases" : type === "debt" ? "debts" : type === "fueltest" ? "fuel_tests" : "sales";
    const positiveNumber = value => Math.max(0, Number(value || 0));
    const meterQty = (start, end) => {
      const a = Number(start || 0);
      const b = Number(end || 0);
      return Math.max(0, b >= a ? b - a : (b + 10000) - a);
    };
    const adjustStock = async (productId, delta) => {
      if (!productId || Math.abs(Number(delta || 0)) < 0.0001) return;
      const { data: product, error: productError } = await db
        .from("products")
        .select("stock_qty")
        .eq("id", productId)
        .maybeSingle();
      if (productError) throw productError;
      if (!product) return;
      const nextStock = Math.max(0, Number(product.stock_qty || 0) + Number(delta || 0));
      const { error: stockError } = await db
        .from("products")
        .update({ stock_qty: nextStock })
        .eq("id", productId);
      if (stockError) throw stockError;
    };

    if (table === "sales") {
      const { data: sale, error: saleError } = await db.from("sales").select("*").eq("id", rowIndex).maybeSingle();
      if (saleError) throw saleError;
      if (!sale) throw new Error("ไม่พบรายการขาย");
      const oldQty = Number(sale.qty || 0);
      const nextQty = form.isFuel ? meterQty(form.start_meter, form.end_meter) : positiveNumber(form.qty);
      const nextPrice = positiveNumber(form.price || sale.unit_price);
      if (nextQty <= 0) throw new Error("จำนวนต้องมากกว่า 0");
      const fuelLog = form.isFuel ? await findFuelLogForSale(db, sale) : null;
      const oldMeterQty = fuelLog ? Number(fuelLog.qty || 0) : oldQty;
      const { error } = await db
        .from("sales")
        .update({
          unit_price: nextPrice,
          qty: nextQty,
          unit: form.unit || sale.unit,
          note: form.note || sale.note || ""
        })
        .eq("id", rowIndex);
      if (error) throw error;
      if (fuelLog) {
        const { error: logError } = await db
          .from("fuel_logs")
          .update({
            meter_start: positiveNumber(form.start_meter),
            meter_end: positiveNumber(form.end_meter),
            qty: nextQty,
            unit_price: nextPrice
          })
          .eq("id", fuelLog.id);
        if (logError) throw logError;
      }
      if (sale.payment_status !== "void") await adjustStock(sale.product_id, oldMeterQty - nextQty);
      return "แก้ไขรายการขายแล้ว";
    }

    if (table === "expenses") {
      const { error } = await db
        .from("expenses")
        .update({ title: form.title || "", amount: positiveNumber(form.amount), note: form.note || null })
        .eq("id", rowIndex);
      if (error) throw error;
      return "แก้ไขรายจ่ายแล้ว";
    }

    if (table === "debts") {
      const { error } = await db
        .from("debts")
        .update({
          customer_name: form.customer || "",
          product_name: form.product || "",
          qty: positiveNumber(form.qty),
          amount: positiveNumber(form.amount),
          filler_name: form.filler || null
        })
        .eq("id", rowIndex);
      if (error) throw error;
      return "แก้ไขค้างชำระแล้ว";
    }

    if (table === "purchases") {
      const { data: purchase, error: purchaseError } = await db.from("purchases").select("*").eq("id", rowIndex).maybeSingle();
      if (purchaseError) throw purchaseError;
      if (!purchase) throw new Error("ไม่พบรายการรับเข้า");
      const oldQty = Number(purchase.qty || 0);
      const nextQty = positiveNumber(form.qty);
      const nextTotal = positiveNumber(form.total);
      const nextCost = nextQty > 0 ? nextTotal / nextQty : Number(purchase.unit_cost || 0);
      if (nextQty <= 0) throw new Error("จำนวนต้องมากกว่า 0");
      const { error } = await db
        .from("purchases")
        .update({ qty: nextQty, unit_cost: nextCost, avg_cost_after: nextCost })
        .eq("id", rowIndex);
      if (error) throw error;
      await adjustStock(purchase.product_id, nextQty - oldQty);
      return "แก้ไขรายการรับเข้าแล้ว";
    }

    if (table === "fuel_tests") {
      const { data: test, error: testError } = await db.from("fuel_tests").select("*").eq("id", rowIndex).maybeSingle();
      if (testError) throw testError;
      const startMeter = positiveNumber(form.start_meter);
      const endMeter = positiveNumber(form.end_meter);
      const qty = meterQty(startMeter, endMeter);
      const fuelLog = test ? await findFuelLogForTest(db, test) : null;
      const { error } = await db
        .from("fuel_tests")
        .update({ meter_start: startMeter, meter_end: endMeter, qty })
        .eq("id", rowIndex);
      if (error) throw error;
      if (fuelLog) {
        const { error: logError } = await db
          .from("fuel_logs")
          .update({ meter_start: startMeter, meter_end: endMeter, qty })
          .eq("id", fuelLog.id);
        if (logError) throw logError;
      }
      return "แก้ไขทดสอบน้ำมันแล้ว";
    }
    return "ยังไม่รองรับแก้ไขในโหมด Supabase";
  }

  async function deleteHistoryRow(type, rowIndex) {
    const db = await ensureReady();
    const table = type === "expense" ? "expenses" : type === "stock" ? "purchases" : type === "debt" ? "debts" : type === "fueltest" ? "fuel_tests" : "sales";

    const deleteWalletLinks = async (refType, refId, fallback = null) => {
      try {
        const { error: refError } = await db
          .from("capital_wallet_entries")
          .delete()
          .eq("ref_type", refType)
          .eq("ref_id", refId);
        if (refError) throw refError;
        if (!fallback) return;

        let query = db
          .from("capital_wallet_entries")
          .select("id")
          .eq("ref_type", refType)
          .is("ref_id", null)
          .eq("tx_type", "use")
          .eq("amount", Number(fallback.amount || 0));
        if (fallback.note) query = query.eq("note", fallback.note);
        if (fallback.start && fallback.end) {
          query = query.gte("tx_at", fallback.start).lte("tx_at", fallback.end);
        }
        const { data, error: findError } = await query;
        if (findError) throw findError;
        if ((data || []).length !== 1) return;
        const { error: deleteError } = await db
          .from("capital_wallet_entries")
          .delete()
          .eq("id", data[0].id);
        if (deleteError) throw deleteError;
      } catch (err) {
        if (!String(err.message || "").includes("capital_wallet_entries")) throw err;
        console.warn("capital wallet cleanup skipped", err);
      }
    };

    if (table === "debts") {
      const { data: debt, error: debtError } = await db.from("debts").select("*").eq("id", rowIndex).maybeSingle();
      if (debtError) throw debtError;
      const linkedSale = debt ? await findDebtSaleForDebt(db, debt) : null;
      if (linkedSale && linkedSale.product_id) {
        const { data: product, error: productError } = await db.from("products").select("stock_qty,is_fuel").eq("id", linkedSale.product_id).maybeSingle();
        if (productError) throw productError;
        if (product && !product.is_fuel) {
          const { error: stockError } = await db
            .from("products")
            .update({ stock_qty: Number(product.stock_qty || 0) + Number(linkedSale.qty || 0) })
            .eq("id", linkedSale.product_id);
          if (stockError) throw stockError;
        }
      }
      if (linkedSale) {
        const { error: saleDeleteError } = await db.from("sales").delete().eq("id", linkedSale.id);
        if (saleDeleteError) throw saleDeleteError;
      }
    }

    if (table === "sales") {
      const { data: sale, error: saleError } = await db.from("sales").select("*").eq("id", rowIndex).maybeSingle();
      if (saleError) throw saleError;
      const fuelLog = sale ? await findFuelLogForSale(db, sale) : null;
      const stockQtyToRestore = fuelLog ? Number(fuelLog.qty || 0) : Number(sale && sale.qty || 0);
      if (sale && sale.product_id) {
        const { data: product, error: productError } = await db.from("products").select("stock_qty").eq("id", sale.product_id).maybeSingle();
        if (productError) throw productError;
        if (product) {
          const { error: stockError } = await db
            .from("products")
            .update({ stock_qty: Number(product.stock_qty || 0) + stockQtyToRestore })
            .eq("id", sale.product_id);
          if (stockError) throw stockError;
        }
      }
      if (fuelLog) {
        const { error: logDeleteError } = await db.from("fuel_logs").delete().eq("id", fuelLog.id);
        if (logDeleteError) throw logDeleteError;
      }
    }

    if (table === "purchases") {
      const { data: purchase, error: purchaseError } = await db.from("purchases").select("*").eq("id", rowIndex).maybeSingle();
      if (purchaseError) throw purchaseError;
      if (purchase && purchase.product_id) {
        const { data: product, error: productError } = await db.from("products").select("stock_qty").eq("id", purchase.product_id).maybeSingle();
        if (productError) throw productError;
        if (product) {
          const { error: stockError } = await db
            .from("products")
            .update({ stock_qty: Math.max(0, Number(product.stock_qty || 0) - Number(purchase.qty || 0)) })
            .eq("id", purchase.product_id);
          if (stockError) throw stockError;
        }
      }
      await deleteWalletLinks("purchase", rowIndex);
    }

    if (table === "expenses") {
      const { data: expense, error: expenseError } = await db.from("expenses").select("*").eq("id", rowIndex).maybeSingle();
      if (expenseError) throw expenseError;
      const day = expense && bkkDate(expense.spent_at);
      await deleteWalletLinks("expense", rowIndex, expense ? {
        amount: Number(expense.amount || 0),
        note: expense.title || "",
        start: day ? `${day}T00:00:00+07:00` : null,
        end: day ? `${day}T23:59:59+07:00` : null
      } : null);
    }

    if (table === "fuel_tests") {
      const { data: test, error: testError } = await db.from("fuel_tests").select("*").eq("id", rowIndex).maybeSingle();
      if (testError) throw testError;
      const fuelLog = test ? await findFuelLogForTest(db, test) : null;
      if (fuelLog) {
        const { error: logDeleteError } = await db.from("fuel_logs").delete().eq("id", fuelLog.id);
        if (logDeleteError) throw logDeleteError;
      }
    }

    const { error } = await db.from(table).delete().eq("id", rowIndex);
    if (error) throw error;
    return "ลบแล้ว";
  }

  async function recalculateFuelStockFromSheets() {
    return "โหมด Supabase ใช้ stock_qty ในตาราง products";
  }

  async function DailyReportToLineFlex() {
    return "ยังไม่ได้ตั้ง LINE ในโหมด Supabase";
  }

  const api = {
    getProductData,
    getProductListForStockIn,
    getProductPriceInfo,
    addProduct,
    updateProductPrices,
    saveOrder,
    getFuelLogData,
    saveFuelLog,
    saveStockIn,
    saveCapitalWalletEntry,
    saveCapitalBalanceReset,
    saveCapitalMovement,
    getDebtPageData,
    saveDebtTransaction,
    clearDebtByCustomer,
    receiveDebtPayment,
    saveGeneralExpense,
    getDashboardData,
    getOilPriceInfo,
    updateOilPrices,
    saveFuelTest,
    getFuelTestHistory,
    getRecentHistory,
    updateHistoryRow,
    deleteHistoryRow,
    recalculateFuelStockFromSheets,
    DailyReportToLineFlex
  };

  function runner(success, failure) {
    return new Proxy({}, {
      get(_target, prop) {
        if (prop === "withSuccessHandler") return cb => runner(cb, failure);
        if (prop === "withFailureHandler") return cb => runner(success, cb);
        return (...args) => {
          Promise.resolve()
            .then(() => {
              if (!api[prop]) throw new Error(`ยังไม่รองรับฟังก์ชัน ${String(prop)}`);
              return api[prop](...args);
            })
            .then(result => {
              if (success) success(result);
            })
            .catch(err => {
              if (failure) failure(err);
              else console.error(err);
            });
        };
      }
    });
  }

  async function debugArchiveBalances(toDate = bkkDate(), period = "day", fromDate = null) {
    const db = await ensureReady();
    const [capital, profit, balances] = await Promise.all([
      db.from("money_ledger").select("ledger_type,entry_date,income_amount,expense_amount,net_amount,balance_amount,created_at").eq("ledger_type", "capital").order("entry_date", { ascending: false }).order("created_at", { ascending: false }).limit(10),
      db.from("money_ledger").select("ledger_type,entry_date,income_amount,expense_amount,net_amount,balance_amount,created_at").eq("ledger_type", "profit").order("entry_date", { ascending: false }).order("created_at", { ascending: false }).limit(10),
      getArchiveBalances(toDate, period, fromDate)
    ]);
    return {
      version: window.POS_SUPABASE_ADAPTER_VERSION,
      toDate,
      period,
      fromDate,
      balances,
      capitalRows: capital.data || [],
      capitalError: capital.error && capital.error.message,
      profitRows: profit.data || [],
      profitError: profit.error && profit.error.message
    };
  }

  async function debugFuelLogData() {
    const db = await ensureReady();
    const rows = await productRows();
    const fuels = findFuelRows(rows);
    const latest = await getFuelLogData();
    const recentLogs = await db
      .from("fuel_logs")
      .select("product_id,product_name,meter_start,meter_end,qty,logged_at")
      .order("logged_at", { ascending: false })
      .limit(10);
    const recentTests = await db
      .from("fuel_tests")
      .select("product_id,product_name,meter_start,meter_end,qty,tested_at")
      .order("tested_at", { ascending: false })
      .limit(10);
    return {
      version: window.POS_SUPABASE_ADAPTER_VERSION,
      detectedFuels: fuels,
      lastData: latest.lastData,
      currentPrices: latest.currentPrices,
      recentLogs: recentLogs.data || [],
      recentLogsError: recentLogs.error && recentLogs.error.message,
      recentTests: recentTests.data || [],
      recentTestsError: recentTests.error && recentTests.error.message
    };
  }

  window.google = { script: { run: runner() } };
  window.posSupabaseAdapter = { initAuth, showLogin, debugArchiveBalances, debugFuelLogData };
  document.addEventListener("DOMContentLoaded", initAuth);
})();
