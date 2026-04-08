const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const API_KEY = "d10d111151530107984df4d86f34f6db";

const AIRLINE_DOMAINS = [
  "saudia.com", "goindigo.in", "emirates.com",
  "travel-akasaair.in", "etihad.com", "flydubai.com",
  "gulfair.com", "airindia.in", "kuwaitairways.com",
  "omanair.com", "spicejet.com", "goair.in",
  "flyscoot.com", "flynas.com", "flyadeal.com",
  "biman-airlines.com", "airarabia.com", "jazeeraairways.com",
  "airvistara.com", "thaiairways.com",
];

app.get("/airport", async (req, res) => {
  try {
    const { code } = req.query;
    const response = await axios.get(`https://api.aviationstack.com/v1/airports?access_key=${API_KEY}&iata_code=${code}`);
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch airport" });
  }
});

app.get("/flight", async (req, res) => {
  try {
    const { number } = req.query;
    const response = await axios.get(`https://api.aviationstack.com/v1/flights?access_key=${API_KEY}&flight_iata=${number}`);
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch flight" });
  }
});

app.get("/airports/search", async (req, res) => {
  try {
    const { q } = req.query;
    const response = await axios.get(`https://api.aviationstack.com/v1/airports?access_key=${API_KEY}&search=${q}&limit=10`);
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: "Failed to search airports" });
  }
});

app.get("/live-flights", async (req, res) => {
  try {
    const response = await axios.get("https://opensky-network.org/api/states/all?lamin=10&lomin=30&lamax=40&lomax=65");
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch live flights" });
  }
});

app.post("/extract-flight", async (req, res) => {
  try {
    const { subject, from, body } = req.body;
    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-haiku-4-5",
        max_tokens: 1000,
        messages: [{ role: "user", content: `You extract flight booking data from airline emails. Be VERY generous - extract ANY flight information you can find.

Subject: ${subject}
From: ${from}
Body: ${body}

Look for: flight numbers (SV123, EK204, 6E456, GF64, JAI123 etc), airport codes (RUH, BOM, DXB, DEL etc), dates, times, seat numbers, booking codes.

These are booking confirmation emails from airlines like Saudia, IndiGo, Emirates, Gulf Air, Jazeera, Air Arabia, Etihad, FlyDubai, Kuwait Airways, Oman Air, Flynas, Scoot, SpiceJet, Air India, Akasa, Vistara, GoAir, Biman.

Extract flight details from booking confirmations and e-tickets only. Skip OTP, miles rewards, lounge invites, refunds, and promotional emails. If email has no actual flight booking return null.
Even if email is old (2014, 2015, 2016...) still extract.
Even if subject is in Arabic - still extract flight data from body.

Return ONLY JSON (no extra text, no markdown), examples:
{"flightNumber":"SV1487","from":"RUH","to":"AQI","fromCity":"Riyadh","toCity":"Qaisumah","date":"2026-02-13","seat":"5L","airline":"Saudia","departure":"15:40","arrival":"16:50"}
{"flightNumber":"6E456","from":"DEL","to":"BOM","fromCity":"Delhi","toCity":"Mumbai","date":"2019-05-10","seat":"12A","airline":"IndiGo","departure":"06:00","arrival":"08:10"}
{"flightNumber":"EK204","from":"DXB","to":"BOM","fromCity":"Dubai","toCity":"Mumbai","date":"2021-03-15","seat":"34B","airline":"Emirates","departure":"14:20","arrival":"18:30"}
{"flightNumber":"GF64","from":"BAH","to":"BOM","fromCity":"Bahrain","toCity":"Mumbai","date":"2023-11-20","seat":"19F","airline":"Gulf Air","departure":"14:30","arrival":"20:55"}
{"flightNumber":"JAI123","from":"KWI","to":"DXB","fromCity":"Kuwait","toCity":"Dubai","date":"2022-08-05","seat":"8C","airline":"Jazeera Airways","departure":"10:00","arrival":"11:30"}

If absolutely no flight info exists return: null` }]
      },
      {
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
        }
      }
    );
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Nylas fetch emails - fetch all then filter by airline domain
app.post("/nylas-emails", async (req, res) => {
  try {
    const { grantId } = req.body;
    const NYLAS_KEY = process.env.NYLAS_API_KEY;

    let allEmails = [];
    let cursor = null;
    let pageCount = 0;

    do {
      const url = cursor
        ? `https://api.us.nylas.com/v3/grants/${grantId}/messages?limit=50&page_token=${cursor}`
        : `https://api.us.nylas.com/v3/grants/${grantId}/messages?limit=50`;

      const response = await axios.get(url, {
        headers: { Authorization: `Bearer ${NYLAS_KEY}` }
      });

      if (response.data?.data?.length > 0) {
        const airlineEmails = response.data.data.filter(m => {
          const fromEmail = (m.from?.[0]?.email || "").toLowerCase();
          return AIRLINE_DOMAINS.some(domain => fromEmail.includes(domain));
        });
        allEmails = [...allEmails, ...airlineEmails];
      }

      cursor = response.data?.next_cursor || null;
      pageCount++;
      if (pageCount >= 10) break;

    } while (cursor);

    // Remove duplicates
    const seen = new Set();
    allEmails = allEmails.filter(m => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });

    // Format for frontend
    const formatted = allEmails.map(m => ({
      id: m.id,
      subject: m.subject || "",
      from: m.from?.[0]?.email || "",
      body: m.body ? m.body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").slice(0, 2000) : "",
      date: m.date,
    }));

    res.json({ emails: formatted, total: formatted.length });

  } catch (error) {
    console.error("Nylas error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get("/", (req, res) => {
  res.json({ message: "✈️ Flight Backend Running with Nylas!" });
});

app.get("/debug-key", (req, res) => {
  res.json({ key: process.env.ANTHROPIC_KEY ? process.env.ANTHROPIC_KEY.substring(0, 20) + "..." : "NOT SET" });
});

app.listen(PORT, () => {
  console.log(`✈️ Server running on http://localhost:${PORT}`);
});