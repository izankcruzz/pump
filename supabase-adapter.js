(function () {
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
