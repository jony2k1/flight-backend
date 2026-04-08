const express = require("express");
const cors = require("cors");
const axios = require("axios");
const Nylas = require("nylas").default;

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const API_KEY = "d10d111151530107984df4d86f34f6db";

// Initialize Nylas
const nylas = new Nylas({
  apiKey: process.env.NYLAS_API_KEY,
  apiUri: "https://api.us.nylas.com",
});

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

// NEW — Nylas fetch emails endpoint
app.post("/nylas-emails", async (req, res) => {
  try {
    const { grantId } = req.body;

    const senders = [
      "info@saudia.com", "saudia.com",
      "reservations@customer.goindigo.in", "customer.goindigo.in",
      "do-not-reply@emirates.com", "noreply@emirates.com",
      "updates@travel-akasaair.in",
      "noreply@etihad.com", "info@bookings.etihad.com",
      "confirmation@flydubai.com",
      "no-reply@gulfair.com", "noreply@gulfair.com",
      "airindia@airindia.in",
      "kuwaitairways@kuwaitairways.com", "travelinfo@kuwaitairways.com",
      "webbooking@omanair.com",
      "Itinerary@spicejet.com",
      "info@goair.in",
      "your-trip@itinerary.flyscoot.com", "noreply@flyscoot.com",
      "no-reply@flynas.com",
      "flyadeal@flyadeal.com",
      "biman@biman-airlines.com",
      "reservations@airarabia.com", "info@airarabia.com",
      "info@jazeeraairways.com", "bookings@jazeeraairways.com",
      "vistara@airvistara.com",
      "thaiairways.com",
    ];

    let allEmails = [];

    // Search each sender separately to maximize results
    for (const sender of senders) {
      try {
        let cursor = null;
        let pageCount = 0;
        do {
          const messages = await nylas.messages.list({
            identifier: grantId,
            queryParams: {
              from: sender,
              limit: 500,
              ...(cursor && { page_token: cursor }),
            }
          });
          if (messages.data && messages.data.length > 0) {
            allEmails = [...allEmails, ...messages.data];
          }
          cursor = messages.next_cursor || null;
          pageCount++;
          if (pageCount > 10) break;
        } while (cursor);
      } catch (err) {
        console.log(`Error fetching from ${sender}:`, err.message);
        continue;
      }
    }

    // Remove duplicates by message ID
    const seen = new Set();
    allEmails = allEmails.filter(m => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });

    // Format emails for frontend
    const formatted = allEmails.map(m => ({
      id: m.id,
      subject: m.subject || "",
      from: m.from?.[0]?.email || "",
      body: m.body ? m.body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").slice(0, 2000) : "",
      date: m.date,
    }));

    res.json({ emails: formatted, total: formatted.length });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Nylas Auth URL generator
app.get("/nylas-auth-url", async (req, res) => {
  try {
    const authURL = nylas.auth.urlForOAuth2({
      clientId: process.env.NYLAS_CLIENT_ID || "066dd961-f845-4cbe-a1d3-ea7548813ca5",
      redirectUri: "https://skytracker-ten.vercel.app/auth/callback",
      scope: ["https://www.googleapis.com/auth/gmail.readonly"],
    });
    res.json({ url: authURL });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Nylas Auth callback
app.post("/nylas-auth-callback", async (req, res) => {
  try {
    const { code } = req.body;
    const { grantId } = await nylas.auth.exchangeCodeForToken({
      clientId: process.env.NYLAS_CLIENT_ID || "066dd961-f845-4cbe-a1d3-ea7548813ca5",
      clientSecret: process.env.NYLAS_CLIENT_SECRET || "",
      redirectUri: "https://skytracker-ten.vercel.app/auth/callback",
      code,
    });
    res.json({ grantId });
  } catch (error) {
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