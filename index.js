const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const API_KEY = "d10d111151530107984df4d86f34f6db";

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
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [{ role: "user", content: `Extract flight booking from this email. Return ONLY JSON or null.

Subject: ${subject}
From: ${from}
Body: ${body}

Return ONLY:
{"flightNumber":"SV1487","from":"RUH","to":"AQI","fromCity":"Riyadh","toCity":"Qaisumah","date":"2026-02-13","seat":"5L","airline":"Saudia","departure":"15:40","arrival":"16:50"}

If NOT a flight booking return: null` }]
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

app.get("/", (req, res) => {
  res.json({ message: "✈️ Flight Backend Running!" });
});

app.listen(PORT, () => {
  console.log(`✈️ Server running on http://localhost:${PORT}`);
});