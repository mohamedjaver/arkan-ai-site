/**
 * ARKAN AI — USDT (TRC20) Sales Backend
 * ───────────────────────────────────────────────────────────
 * - كل طلب يحصل على مبلغ فريد (سنتات عشوائية) للتمييز بمحفظة واحدة
 * - يراقب المحفظة عبر TronGrid، يطابق المبلغ + النافذة الزمنية
 * - عند التأكيد: يولّد رابط دعوة Telegram لمرة واحدة + يشعرك
 * Node 18+ (native fetch)
 */
require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();

const {
  DOMAIN = "http://localhost:3000",
  USDT_WALLET,                 // عنوان استقبال USDT TRC20
  TRONGRID_API_KEY = "",       // مفتاح مجاني من trongrid.io (يرفع حد الطلبات)
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHANNEL_ID,         // -100xxxxxxxxxx
  TELEGRAM_ADMIN_ID,
  BETA_TOTAL_SEATS = 50,
  ORDER_WINDOW_MIN = 40,       // مهلة الدفع بالدقائق
} = process.env;

const USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"; // USDT الرسمي على TRON
const TG = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

/* ----------------------------- الخطط (USD) ----------------------------- */
const PLANS = {
  pro_monthly: { name: "ARKAN AI — PRO (شهري)",  price: 39,  cycle: "شهري" },
  beta_yearly: { name: "ARKAN AI — BETA Founder (سنوي)", price: 179, cycle: "سنوي", beta: true },
  lifetime:    { name: "ARKAN AI — LIFETIME (مدى الحياة)", price: 499, cycle: "مرة واحدة" },
};

/* ----------------------------- تخزين JSON ----------------------------- */
const DB = path.join(__dirname, "orders.json");
const db = fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB, "utf8")) : { orders: {}, betaSold: 0, usedCents: {} };
const save = () => fs.writeFileSync(DB, JSON.stringify(db, null, 2));

/* ----------------------------- أدوات Telegram ----------------------------- */
async function tg(method, payload) {
  try {
    const r = await fetch(`${TG}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const d = await r.json();
    if (!d.ok) console.error("TG", method, d.description);
    return d;
  } catch (e) { console.error("TG fail", e.message); return { ok: false }; }
}
const notifyAdmin = (t) => TELEGRAM_ADMIN_ID && tg("sendMessage", { chat_id: TELEGRAM_ADMIN_ID, text: t, parse_mode: "HTML" });

async function createInvite(orderId) {
  const d = await tg("createChatInviteLink", {
    chat_id: TELEGRAM_CHANNEL_ID, name: `ARKAN ${orderId}`,
    member_limit: 1, expire_date: Math.floor(Date.now() / 1000) + 7 * 86400,
  });
  return d.ok ? d.result.invite_link : null;
}

/* ----------------------------- مبلغ فريد لكل طلب ----------------------------- */
// نضيف سنتات عشوائية (0.01–0.99) غير مستخدمة حالياً لنفس السعر الأساسي
function uniqueAmount(base) {
  for (let i = 0; i < 200; i++) {
    const cents = crypto.randomInt(1, 9999) / 10000; // 4 خانات: 0.0001–0.9999
    const amt = +(base + cents).toFixed(4);
    if (!db.usedCents[amt]) { db.usedCents[amt] = true; return amt; }
  }
  return +(base + Math.random()).toFixed(4);
}

/* ----------------------------- TronGrid: فحص الواردات ----------------------------- */
async function fetchIncoming() {
  const url = `https://api.trongrid.io/v1/accounts/${USDT_WALLET}/transactions/trc20`
    + `?only_to=true&only_confirmed=true&limit=50&contract_address=${USDT_CONTRACT}`;
  const headers = TRONGRID_API_KEY ? { "TRON-PRO-API-KEY": TRONGRID_API_KEY } : {};
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error("trongrid " + r.status);
  const j = await r.json();
  return (j.data || []).map(t => ({
    txID: t.transaction_id,
    to: t.to,
    amount: Number(t.value) / 1e6,        // USDT = 6 decimals
    ts: t.block_timestamp,
  }));
}

// مطابقة دفعة بطلب معلّق (نفس المبلغ الدقيق + داخل النافذة + لم تُستخدم)
async function reconcile() {
  const pending = Object.values(db.orders).filter(o => o.status === "pending");
  if (!pending.length) return;
  let txs;
  try { txs = await fetchIncoming(); } catch (e) { return console.error("poll", e.message); }

  for (const o of pending) {
    if (Date.now() > o.expiresAt) { o.status = "expired"; save(); continue; }
    const match = txs.find(t =>
      Math.abs(t.amount - o.amount) < 0.00005 &&   // تطابق المبلغ الفريد
      t.ts >= o.createdAt - 120000 &&              // بعد إنشاء الطلب (هامش دقيقتين)
      !Object.values(db.orders).some(x => x.txID === t.txID) // لم تُربط بطلب آخر
    );
    if (!match) continue;

    o.status = "paid"; o.txID = match.txID; o.paidAt = Date.now();
    o.inviteLink = await createInvite(o.orderId);
    if (PLANS[o.plan]?.beta) db.betaSold++;
    save();
    notifyAdmin(
      `💰 <b>دفعة USDT مؤكدة — ARKAN AI</b>\n` +
      `🧾 ${o.orderId} · ${o.plan}\n💵 ${o.amount} USDT\n` +
      `🔗 ${o.inviteLink || "فشل توليد الرابط — أرسله يدويًا"}\n` +
      `🔍 tx: <code>${match.txID}</code>`
    );
  }
}
setInterval(reconcile, 20000); // كل 20 ثانية

/* ----------------------------- Middleware ----------------------------- */
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

/* ----------------------------- API ----------------------------- */
app.get("/api/seats", (_, res) =>
  res.json({ total: +BETA_TOTAL_SEATS, left: Math.max(0, BETA_TOTAL_SEATS - db.betaSold) }));

// إنشاء طلب → يرجع المبلغ الفريد + عنوان المحفظة + مهلة
app.post("/api/order", (req, res) => {
  const p = PLANS[req.body.plan];
  if (!p) return res.status(400).json({ error: "خطة غير صحيحة" });
  if (p.beta && db.betaSold >= BETA_TOTAL_SEATS) return res.status(409).json({ error: "اكتملت مقاعد Beta" });

  const id = crypto.randomBytes(5).toString("hex");
  const orderId = "ARK-" + id.toUpperCase();
  const amount = uniqueAmount(p.price);
  db.orders[id] = {
    id, orderId, plan: req.body.plan, basePrice: p.price, amount,
    status: "pending", createdAt: Date.now(),
    expiresAt: Date.now() + ORDER_WINDOW_MIN * 60000,
    tradingview: null, inviteLink: null, txID: null,
  };
  save();
  res.json({
    id, orderId, amount, wallet: USDT_WALLET,
    network: "TRON (TRC20)", expiresInMin: +ORDER_WINDOW_MIN, plan: p.name,
  });
});

// تتبّع حالة الطلب (الموقع يستعلم كل بضع ثوانٍ)
app.get("/api/order/:id", (req, res) => {
  const o = db.orders[req.params.id];
  if (!o) return res.status(404).json({ status: "notfound" });
  res.json({ status: o.status, orderId: o.orderId, amount: o.amount,
    wallet: USDT_WALLET, inviteLink: o.inviteLink, expiresAt: o.expiresAt });
});

// استلام اسم TradingView بعد الدفع
app.post("/api/tradingview", (req, res) => {
  const o = db.orders[req.body.id];
  if (!o || o.status !== "paid") return res.status(400).json({ ok: false });
  if (!/^[A-Za-z0-9_\-.]{3,30}$/.test(req.body.username || "")) return res.status(400).json({ ok: false });
  o.tradingview = req.body.username; save();
  notifyAdmin(`🎯 <b>طلب تفعيل TradingView</b>\n🧾 ${o.orderId}\n👤 <code>${req.body.username}</code>\n➕ TradingView → المؤشر → Manage Access`);
  res.json({ ok: true });
});

// بوت Telegram (اختياري)
app.post("/api/telegram", async (req, res) => {
  const m = req.body?.message;
  if (m?.text === "/start") await tg("sendMessage", { chat_id: m.chat.id, text: "أهلًا بك في ARKAN AI 🖤\nللاشتراك:\n" + DOMAIN + "/#pricing" });
  if (m?.text === "/id") await tg("sendMessage", { chat_id: m.chat.id, text: `chat_id: ${m.chat.id}` });
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ ARKAN AI (USDT) → http://localhost:${PORT}`));
