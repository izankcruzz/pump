(function () {
  window.POS_SUPABASE_ADAPTER_VERSION = "2026-06-12-period-ledger-v29";
  console.info("POS Supabase adapter", window.POS_SUPABASE_ADAPTER_VERSION);

  const STORAGE_URL = "POS_SUPABASE_URL";
  const STORAGE_KEY = "POS_SUPABASE_ANON_KEY";
  const FUEL_CATEGORY = "น้ำมันเชื้อเพลิง";
  const FUEL_NAMES = ["เบนซิน 95", "ดีเซล"];

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

  function addDays(dateText, days) {
    const [y, m, d] = String(dateText || bkkDate()).split("-").map(Number);
    const date = new Date(y, (m || 1) - 1, d || 1);
    date.setDate(date.getDate() + days);
    return date.toISOString().slice(0, 10);
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
          <div class="w-12 h-12 rounded-2xl bg-emerald-600 text-white flex items-center justify-center">
            <i class="fa-solid fa-database text-xl"></i>
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
        const purchasedAt = new Date(row.purchased_at).getTime();
        const createdAt = new Date(row.created_at).getTime();
        if (Number.isFinite(purchasedAt) && Number.isFinite(createdAt) && Math.abs(purchasedAt - createdAt) <= 3600 * 1000) return;
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

  async function getProductData() {
    const rows = await productRows();
    const items = rows.map(row => mapProduct(row, {}));
    return {
      fuels: items.filter(item => item.category === FUEL_CATEGORY),
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
    const { data: debts, error: debtError } = await db.from("debts").select("*").gte("debt_at", `${today}T00:00:00+07:00`).lte("debt_at", `${today}T23:59:59+07:00`);
    if (debtError) throw debtError;
    const todayDebt = { "ดีเซล": 0, "เบนซิน 95": 0 };
    (debts || []).forEach(row => {
      if ((diesel && row.product_id === diesel.id) || row.product_name === (diesel && diesel.name)) todayDebt["ดีเซล"] += Number(row.qty || 0);
      if ((gas95 && row.product_id === gas95.id) || row.product_name === (gas95 && gas95.name)) todayDebt["เบนซิน 95"] += Number(row.qty || 0);
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
    const purchases = [];
    for (const item of items || []) {
      if (item.type === "cashExpense" || item.type === "capitalExpense") {
        const { error } = await db.from("expenses").insert({
          title: item.productName,
          amount: Number(item.totalPrice || item.pricePerUnit || 0),
          note: "จากจัดการสต็อก",
          expense_type: item.type === "capitalExpense" ? "capital" : "expense"
        });
        if (error) throw error;
        continue;
      }
      const product = byName[item.productName];
      if (!product) throw new Error(`ไม่พบสินค้า: ${item.productName}`);
      purchases.push({
        product_id: product.id,
        qty: Number(item.qty || 0),
        unit_cost: Number(item.pricePerUnit || 0),
        new_sale_price: item.salePrice ? Number(item.salePrice) : null,
        note: ""
      });
    }
    if (purchases.length) {
      const { error } = await db.rpc("app_create_purchase", { p_items: purchases });
      if (error) throw error;
    }
    return "บันทึกรับสินค้าแล้ว";
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
      const base = customDate ? new Date(customDate) : new Date();
      const y = base.getFullYear();
      const m = base.getMonth();
      from = new Date(y, m, 1).toISOString().slice(0, 10);
      to = new Date(y, m + 1, 0).toISOString().slice(0, 10);
    } else if (period === "range" && dateRange) {
      from = dateRange.from;
      to = dateRange.to;
    } else if (customDate) {
      from = customDate;
      to = customDate;
    }

    const start = `${from}T00:00:00+07:00`;
    const end = `${to}T23:59:59+07:00`;
    const [salesRes, expensesRes, debtsRes, unpaidDebtsRes, paymentsRes, testsRes] = await Promise.all([
      db.from("sales").select("*").gte("sold_at", start).lte("sold_at", end).neq("payment_status", "void"),
      db.from("expenses").select("*").gte("spent_at", start).lte("spent_at", end),
      db.from("debts").select("*").gte("debt_at", start).lte("debt_at", end).neq("status", "void"),
      db.from("debts").select("*").in("status", ["unpaid", "partial"]),
      db.from("debt_payments").select("*").gte("paid_at", start).lte("paid_at", end),
      db.from("fuel_tests").select("*").gte("tested_at", start).lte("tested_at", end)
    ]);
    for (const res of [salesRes, expensesRes, debtsRes, unpaidDebtsRes, paymentsRes, testsRes]) if (res.error) throw res.error;

    const sales = salesRes.data || [];
    const expenses = expensesRes.data || [];
    const debts = debtsRes.data || [];
    const unpaidDebts = unpaidDebtsRes.data || [];
    const payments = (paymentsRes.data || []).filter(row => row.note !== "import paid debt");
    const tests = testsRes.data || [];

    const salesList = sales.map(row => {
      const product = productByName[row.product_name] || {};
      const cost = Number(product.avg_cost || 0);
      const qty = Number(row.qty || 0);
      const total = Number(row.total || row.unit_price * qty || 0);
      return {
        name: row.product_name,
        day: bkkDate(row.sold_at),
        qty,
        unit: row.unit,
        total,
        costTotal: cost * qty,
        profit: total - (cost * qty),
        profitPerUnit: Number(row.unit_price || 0) - cost
      };
    });

    const expenseList = expenses.map(row => ({
      title: row.title,
      amount: Number(row.amount || 0),
      type: row.expense_type === "capital" ? "stock" : "general",
      day: bkkDate(row.spent_at)
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
      amount: Number(row.amount || 0)
    }));
    const fuelTests = tests.map(row => ({
      type: row.product_name,
      time: thaiTime(row.tested_at),
      qty: Number(row.qty || 0)
    }));

    const totalSales = salesList.reduce((sum, row) => sum + row.total, 0);
    const totalExpenses = expenseList.reduce((sum, row) => sum + row.amount, 0);
    const totalDebt = debtList.reduce((sum, row) => sum + row.amount, 0);
    const debtRepaid = repayList.reduce((sum, row) => sum + row.amount, 0);
    const profit = salesList.reduce((sum, row) => sum + row.profit, 0);
    const capitalReturned = salesList.reduce((sum, row) => sum + row.costTotal, 0);
    const stockPaid = expenseList.filter(row => row.type === "stock").reduce((sum, row) => sum + row.amount, 0);
    const generalExpenses = expenseList.filter(row => row.type !== "stock").reduce((sum, row) => sum + row.amount, 0);
    const ledgerBalances = await getArchiveBalances(to, period, from);
    const balanceDeltas = await getBalanceDeltas(db, productByName, ledgerBalances, to);
    const capitalBalance = ledgerBalances.capital !== null
      ? ledgerBalances.capital + balanceDeltas.capitalReturned - balanceDeltas.stockPaid
      : capitalReturned - stockPaid;
    const profitBalance = ledgerBalances.profit !== null
      ? ledgerBalances.profit + balanceDeltas.profit - balanceDeltas.generalExpenses
      : profit - generalExpenses;
    const headerNetProfit = ledgerBalances.profit !== null ? profitBalance : profit - generalExpenses;

    return {
      summary: {
        sales: totalSales,
        expenses: totalExpenses,
        debt: totalDebt,
        cash: totalSales + debtRepaid - totalExpenses,
        profit,
        netProfit: headerNetProfit,
        actualReceived: totalSales + debtRepaid,
        grocery: 0,
        stockPaid,
        debtRepaid,
        capitalReturned,
        capitalNet: capitalReturned - stockPaid,
        capitalBalance,
        profitBalance,
        openingCapitalBalance: ledgerBalances.capital,
        openingProfitBalance: ledgerBalances.profit,
        balanceDeltaCapitalReturned: balanceDeltas.capitalReturned,
        balanceDeltaStockPaid: balanceDeltas.stockPaid,
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
        capital: expenseList.filter(row => row.type === "stock"),
        debts: debtList,
        repayments: repayList,
        fuelTests
      },
      chart: {
        labels: [from === to ? thaiDate(from) : `${from} - ${to}`],
        data: {
          sales: [totalSales],
          cash: [totalSales + debtRepaid - totalExpenses],
          profit: [headerNetProfit]
        }
      },
      monthlyOilSummary: {
        profitItems: salesList,
        profitDays: [],
        repayments: repayList,
        debts: debtList,
        payments: expenseList,
        sales: { fuel: [], engineOil: [] }
      }
    };
  }

  async function getArchiveBalances(toDate, period = "day", fromDate = null) {
    const db = await ensureReady();
    const isMonthView = period === "month";
    const startDate = isMonthView ? `${String(toDate).slice(0, 7)}-01` : (fromDate || toDate);
    const result = {
      capital: null,
      profit: null,
      capitalDate: null,
      profitDate: null,
      capitalCreatedAt: null,
      profitCreatedAt: null
    };

    const readMonthlyCapitalNet = async () => {
      if (!toDate) return;
      const { data, error } = await db
        .from("money_ledger")
        .select("entry_date,net_amount,income_amount,expense_amount,created_at")
        .eq("ledger_type", "capital")
        .gte("entry_date", startDate)
        .lte("entry_date", toDate)
        .order("entry_date", { ascending: false });
      if (error) throw error;
      if (!(data || []).length) return;
      const rows = data || [];
      const nets = rows.map(row => (
        row.net_amount !== null && row.net_amount !== undefined
          ? Number(row.net_amount || 0)
          : Number(row.income_amount || 0) - Number(row.expense_amount || 0)
      ));
      const total = nets.reduce((sum, net) => sum + net, 0);
      const duplicateMonthlyTotal = nets.find(net => net !== 0 && Math.abs((total - net) - net) < 0.01);
      result.capital = duplicateMonthlyTotal !== undefined ? duplicateMonthlyTotal : total;
      /*
      result.capital = (data || []).reduce((sum, row) => {
        const net = row.net_amount !== null && row.net_amount !== undefined
          ? Number(row.net_amount || 0)
          : Number(row.income_amount || 0) - Number(row.expense_amount || 0);
        return sum + net;
      }, 0);
      */
      result.capitalDate = (data || [])[0].entry_date;
      result.capitalCreatedAt = rows
        .map(row => row.created_at)
        .filter(Boolean)
        .sort()
        .pop() || null;
    };

    const readMonthlyProfitBalance = async () => {
      if (!toDate) return;
      const { data, error } = await db
        .from("money_ledger")
        .select("entry_date,income_amount,expense_amount,net_amount,balance_amount,created_at")
        .eq("ledger_type", "profit")
        .gte("entry_date", startDate)
        .lte("entry_date", toDate)
        .order("entry_date", { ascending: false })
        .order("created_at", { ascending: false });
      if (error) throw error;
      const rows = data || [];
      if (!rows.length) return;

      const nets = rows.map(row => (
        row.net_amount !== null && row.net_amount !== undefined
          ? Number(row.net_amount || 0)
          : Number(row.income_amount || 0) - Number(row.expense_amount || 0)
      ));
      const total = nets.reduce((sum, net) => sum + net, 0);
      const duplicateMonthlyTotal = nets.find(net => net !== 0 && Math.abs((total - net) - net) < 0.01);
      result.profit = duplicateMonthlyTotal !== undefined ? duplicateMonthlyTotal : total;
      result.profitDate = rows[0].entry_date;
      result.profitCreatedAt = rows
        .map(row => row.created_at)
        .filter(Boolean)
        .sort()
        .pop() || null;
    };

    try {
      await readMonthlyCapitalNet();
      await readMonthlyProfitBalance();
    } catch (err) {
      if (!String(err.message || "").includes("money_ledger")) {
        console.warn("monthly ledger lookup failed", err);
      }
    }

    const readDailyCapital = async useDateFilter => {
      let query = db
        .from("daily_summaries")
        .select("summary_date,capital_balance,created_at")
        .neq("capital_balance", 0)
        .order("summary_date", { ascending: false })
        .limit(1);
      if (useDateFilter && toDate) query = query.lte("summary_date", toDate);
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
      if (result.capital === null) await readDailyCapital(false);
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
      if (useDateFilter && toDate) query = query.lte("entry_date", toDate);
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
      if (result.capital === null) await readLedgerType("capital", false);
      if (result.profit === null) await readLedgerType("profit", false);
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
      if (useDateFilter && toDate) query = query.lte("summary_date", toDate);
      const { data, error } = await query;
      if (error) throw error;
      applyDailySummary((data || [])[0]);
    };

    try {
      await readDailySummary(true);
      if (result.capital === null || result.profit === null) await readDailySummary(false);
    } catch (err) {
      if (!String(err.message || "").includes("daily_summaries")) {
        console.warn("daily_summaries balance lookup failed", err);
      }
    }

    return result;
  }

  async function getBalanceDeltas(db, productByName, ledgerBalances, toDate) {
    const result = { capitalReturned: 0, stockPaid: 0, profit: 0, generalExpenses: 0 };
    const startDates = [ledgerBalances.capitalDate, ledgerBalances.profitDate]
      .filter(Boolean)
      .map(String);
    if (startDates.length === 0) return result;

    const fromDate = startDates.sort()[0];
    if (fromDate > toDate) return result;

    const start = `${fromDate}T00:00:00+07:00`;
    const end = `${toDate}T23:59:59+07:00`;
    const [salesRes, expensesRes] = await Promise.all([
      db.from("sales").select("*").gte("sold_at", start).lte("sold_at", end).neq("payment_status", "void"),
      db.from("expenses").select("*").gte("spent_at", start).lte("spent_at", end)
    ]);
    if (salesRes.error) throw salesRes.error;
    if (expensesRes.error) throw expensesRes.error;

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
      const qty = Number(row.qty || 0);
      const total = Number(row.total || row.unit_price * qty || 0);
      const costTotal = Number(product.avg_cost || 0) * qty;
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
    return (data || []).map(row => {
      if (table === "expenses") return { rowIndex: row.id, data: [thaiDate(row.spent_at), row.title, row.amount, row.amount, row.note || ""] };
      if (table === "purchases") return { rowIndex: row.id, data: [thaiDate(row.purchased_at), row.product_name, row.unit_cost, row.qty, row.unit, row.total, row.avg_cost_after] };
      if (table === "debts") return { rowIndex: row.id, data: [thaiDate(row.debt_at), row.customer_name, row.product_name, row.qty, row.amount, row.filler_name || ""] };
      return { rowIndex: row.id, data: [thaiDate(row.sold_at), row.product_name, row.unit_price, row.qty, row.unit, row.total, row.note || ""] };
    });
  }

  async function updateHistoryRow() {
    return "ยังไม่รองรับแก้ไขในโหมด Supabase";
  }

  async function deleteHistoryRow(type, rowIndex) {
    const db = await ensureReady();
    const table = type === "expense" ? "expenses" : type === "stock" ? "purchases" : type === "debt" ? "debts" : type === "fueltest" ? "fuel_tests" : "sales";

    if (table === "sales") {
      const { data: sale, error: saleError } = await db.from("sales").select("*").eq("id", rowIndex).maybeSingle();
      if (saleError) throw saleError;
      if (sale && sale.product_id) {
        const { data: product, error: productError } = await db.from("products").select("stock_qty").eq("id", sale.product_id).maybeSingle();
        if (productError) throw productError;
        if (product) {
          const { error: stockError } = await db
            .from("products")
            .update({ stock_qty: Number(product.stock_qty || 0) + Number(sale.qty || 0) })
            .eq("id", sale.product_id);
          if (stockError) throw stockError;
        }
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

  async function debugArchiveBalances(toDate = bkkDate()) {
    const db = await ensureReady();
    const [capital, profit, balances] = await Promise.all([
      db.from("money_ledger").select("ledger_type,entry_date,income_amount,expense_amount,net_amount,balance_amount,created_at").eq("ledger_type", "capital").order("entry_date", { ascending: false }).order("created_at", { ascending: false }).limit(10),
      db.from("money_ledger").select("ledger_type,entry_date,income_amount,expense_amount,net_amount,balance_amount,created_at").eq("ledger_type", "profit").order("entry_date", { ascending: false }).order("created_at", { ascending: false }).limit(10),
      getArchiveBalances(toDate)
    ]);
    return {
      version: window.POS_SUPABASE_ADAPTER_VERSION,
      toDate,
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
