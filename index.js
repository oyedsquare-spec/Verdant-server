const express = require("express");
const cors = require("cors");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const app = express();
app.use(cors());
app.use(express.json());

let config = {
  fmpKey: process.env.FMP_KEY || "",
  twilioSid: process.env.TWILIO_SID || "",
  twilioToken: process.env.TWILIO_TOKEN || "",
  twilioFrom: process.env.TWILIO_FROM || "+14155238886",
  twilioTo: process.env.TWILIO_TO || "",
};

let alertLog = [];
let seenArticles = new Set();
let pollInterval = null;
let lastPollTime = null;
let nextPollTime = null;
let isPolling = false;
let stats = { totalAlerts: 0, newsAlerts: 0, priceAlerts: 0, lastError: null };

const POLL_MS = 15 * 60 * 1000;
const FINNHUB = "https://finnhub.io/api/v1";

function addAlert(type, title, ticker, body, sent) {
  const alert = { id: Date.now() + Math.random(), type, title, ticker, body, sent, time: new Date().toISOString() };
  alertLog.unshift(alert);
  if (alertLog.length > 100) alertLog = alertLog.slice(0, 100);
  return alert;
}

async function isBreakingNews(headline, summary) {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 50,
        system: "You are a financial news filter. Reply with ONLY 'YES' or 'NO'.",
        messages: [{ role: "user", content: `Is this stock market news SIGNIFICANT enough to alert a long-term investor? Consider: earnings surprises, FDA approvals/rejections, major acquisitions, CEO resignations, major lawsuits, regulatory actions, dividend cuts, bankruptcy. NOT significant: routine analyst upgrades, minor price targets, general commentary.\n\nHeadline: ${headline}\nSummary: ${summary || ""}\n\nAnswer YES or NO only.` }]
      })
    });
    const data = await res.json();
    return data.content?.[0]?.text?.trim().toUpperCase() === "YES";
  } catch (e) { return false; }
}

async function sendWhatsApp(message) {
  if (!config.twilioSid || !config.twilioToken || !config.twilioTo) return false;
  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${config.twilioSid}/Messages.json`;
    const params = new URLSearchParams({
      To: `whatsapp:${config.twilioTo}`,
      From: `whatsapp:${config.twilioFrom}`,
      Body: message
    });
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${config.twilioSid}:${config.twilioToken}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params
    });
    return res.ok;
  } catch (e) { stats.lastError = e.message; return false; }
}

async function fetchNews() {
  if (!config.fmpKey) return [];
  try {
    const res = await fetch(`${FINNHUB}/news?category=general&token=${config.fmpKey}`);
    const data = await res.json();
    return Array.isArray(data) ? data.map(a => ({
      title: a.headline,
      text: a.summary,
      url: a.url,
      symbol: a.related || "MARKET",
      site: a.source,
      publishedDate: new Date(a.datetime * 1000).toISOString()
    })) : [];
  } catch (e) { stats.lastError = e.message; return []; }
}

async function fetchBigMovers() {
  if (!config.fmpKey) return [];
  try {
    const symbols = ["AAPL","MSFT","NVDA","TSLA","AMZN","GOOGL","META","V","JPM","JNJ"];
    const results = await Promise.all(symbols.map(async s => {
      try {
        const res = await fetch(`${FINNHUB}/quote?symbol=${s}&token=${config.fmpKey}`);
        const d = await res.json();
        const pct = d.dp || 0;
        return { ticker: s, price: d.c, change: d.d, changesPercentage: pct };
      } catch(e) { return null; }
    }));
    return results.filter(r => r && Math.abs(r.changesPercentage) >= 5);
  } catch (e) { stats.lastError = e.message; return []; }
}

async function poll() {
  if (isPolling) return;
  isPolling = true;
  lastPollTime = new Date().toISOString();
  nextPollTime = new Date(Date.now() + POLL_MS).toISOString();
  try {
    const articles = await fetchNews();
    const newArticles = articles.filter(a => !seenArticles.has(a.url));
    for (const article of newArticles.slice(0, 10)) {
      seenArticles.add(article.url);
      if (seenArticles.size > 2000) {
        const arr = [...seenArticles];
        seenArticles = new Set(arr.slice(arr.length - 1000));
      }
      const significant = await isBreakingNews(article.title, article.text);
      if (significant) {
        const msg = `📈 *VERDANT ALERT*\n\n*${article.symbol || "MARKET"}* — Breaking News\n\n${article.title}\n\n${article.text ? article.text.slice(0, 200) + "..." : ""}\n\n🔗 ${article.url}\n\n⏰ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York" })} EST`;
        const sent = await sendWhatsApp(msg);
        addAlert("news", article.title, article.symbol || "MARKET", msg, sent);
        stats.totalAlerts++; stats.newsAlerts++;
      }
    }
    const movers = await fetchBigMovers();
    for (const mover of movers.slice(0, 5)) {
      const alertKey = `price_${mover.ticker}_${new Date().toDateString()}`;
      if (seenArticles.has(alertKey)) continue;
      seenArticles.add(alertKey);
      const emoji = mover.changesPercentage > 0 ? "🟢" : "🔴";
      const direction = mover.changesPercentage > 0 ? "UP" : "DOWN";
      const msg = `${emoji} *VERDANT PRICE ALERT*\n\n*${mover.ticker}* is ${direction} ${Math.abs(mover.changesPercentage).toFixed(1)}%\n\nPrice: $${mover.price}\nChange: ${mover.change > 0 ? "+" : ""}$${Number(mover.change).toFixed(2)}\n\n⏰ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York" })} EST`;
      const sent = await sendWhatsApp(msg);
      addAlert("price", `${mover.ticker} moved ${mover.changesPercentage.toFixed(1)}%`, mover.ticker, msg, sent);
      stats.totalAlerts++; stats.priceAlerts++;
    }
  } catch (e) { stats.lastError = e.message; }
  isPolling = false;
}

function startPolling() {
  if (pollInterval) clearInterval(pollInterval);
  poll();
  pollInterval = setInterval(poll, POLL_MS);
}

function stopPolling() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}

if (config.fmpKey && config.twilioSid && config.twilioTo) startPolling();

app.get("/health", (req, res) => res.json({ status: "ok", polling: !!pollInterval, lastPollTime, nextPollTime, stats, alertCount: alertLog.length, configured: !!(config.fmpKey) }));
app.get("/config", (req, res) => res.json({ fmpKey: config.fmpKey ? "***" + config.fmpKey.slice(-4) : "", twilioSid: config.twilioSid ? "set" : "", polling: !!pollInterval }));
app.post("/config", (req, res) => {
  const { fmpKey, twilioSid, twilioToken, twilioFrom, twilioTo } = req.body;
  if (fmpKey) config.fmpKey = fmpKey;
  if (twilioSid) config.twilioSid = twilioSid;
  if (twilioToken) config.twilioToken = twilioToken;
  if (twilioFrom) config.twilioFrom = twilioFrom;
  if (twilioTo) config.twilioTo = twilioTo;
  if (config.fmpKey) startPolling();
  res.json({ ok: true, polling: !!pollInterval });
});
app.get("/alerts", (req, res) => res.json({ alerts: alertLog, stats }));
app.post("/poll", (req, res) => { poll(); res.json({ ok: true }); });
app.post("/start", (req, res) => { startPolling(); res.json({ ok: true }); });
app.post("/stop", (req, res) => { stopPolling(); res.json({ ok: true }); });
app.post("/test-whatsapp", async (req, res) => {
  const msg = `✅ *VERDANT Test Alert*\n\nYour WhatsApp alerts are working!\n\n⏰ ${new Date().toLocaleTimeString()}`;
  const sent = await sendWhatsApp(msg);
  res.json({ ok: sent, message: sent ? "Test message sent!" : "Failed — check Twilio keys" });
});
app.get("/news", async (req, res) => {
  const articles = await fetchNews();
  res.json({ articles });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Verdant server running on port ${PORT}`));
