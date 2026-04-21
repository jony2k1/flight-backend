const express = require("express");
const cors = require("cors");
const axios = require("axios");
const https = require("https");
const { parse } = require("csv-parse");

let airportsCache = [];

async function loadAirports() {
  return new Promise((resolve) => {
    const airports = [];
    const url = "https://davidmegginson.github.io/ourairports-data/airports.csv";
    https.get(url, (res) => {
      res.pipe(parse({ columns: true, skip_empty_lines: true }))
        .on("data", (row) => {
          if (row.iata_code && row.latitude_deg && row.longitude_deg && row.type !== "closed") {
            airports.push({
              iata: row.iata_code,
              name: row.name,
              city: row.municipality || "",
              country: row.iso_country,
              lat: parseFloat(row.latitude_deg),
              lng: parseFloat(row.longitude_deg),
              type: row.type,
            });
          }
        })
        .on("end", () => {
          airportsCache = airports;
          console.log(`✅ Loaded ${airports.length} airports`);
          resolve(airports);
        })
        .on("error", () => resolve([]));
    }).on("error", () => resolve([]));
  });
}

loadAirports();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const API_KEY = "d10d111151530107984df4d86f34f6db";
const WEATHER_KEY = "bd5e378503939ddaee76f12ad7a97608";

const AIRLINE_DOMAINS = [
  "saudia.com", "goindigo.in", "emirates.com",
  "travel-akasaair.in", "etihad.com", "flydubai.com",
  "gulfair.com", "airindia.in", "airindia.com", "goair.in", "jetairways.com", "kuwaitairways.com",
  "omanair.com", "spicejet.com", "goair.in",
  "flyscoot.com", "flynas.com", "flyadeal.com",
  "biman-airlines.com", "airarabia.com", "jazeeraairways.com",
  "airvistara.com", "thaiairways.com",
];

app.get('/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

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

// ── WEATHER via backend (no CORS) ──────────────────────────────
app.get("/weather", async (req, res) => {
  try {
    const { city } = req.query;
    const response = await axios.get(
      `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${WEATHER_KEY}&units=metric`
    );
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── REAL DRIVE TIME via Google Maps ────────────────────────────
app.get("/drive-time", async (req, res) => {
  try {
    const { from, to } = req.query;
    const GKEY = process.env.GOOGLE_PLACES_KEY;
    const response = await axios.get(
      `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(from)}&destinations=${encodeURIComponent(to)}&mode=driving&language=en&key=${GKEY}`
    );
    const el = response.data.rows?.[0]?.elements?.[0];
    if (el?.status === "OK") {
      res.json({
        duration: el.duration.text,
        distance: el.distance.text,
        durationSeconds: el.duration.value,
        distanceMeters: el.distance.value,
      });
    } else {
      res.json({ error: "Route not found", status: el?.status });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
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
        messages: [{ role: "user", content: `You extract flight booking data from airline emails. Extract ALL flights found - if email has multiple flights return a JSON array.

Subject: ${subject}
From: ${from}
Body: ${body}

IMPORTANT RULES:
- IndiGo emails use city names - convert to IATA: Mumbai=BOM, Delhi=DEL, Bangalore=BLR, Hyderabad=HYD, Chennai=MAA, Kolkata=CCU, Ahmedabad=AMD, Kochi=COK, Goa=GOI, Jaipur=JAI, Lucknow=LKO, Amritsar=ATQ, Chandigarh=IXC, Pune=PNQ, Vadodara=BDQ
- Saudia emails may be in Arabic - still extract flight data
- Look for PNR codes, booking references, e-ticket numbers
- For round trips extract BOTH flights as array
- Dates may be in any format - convert to YYYY-MM-DD
- Even old emails from 2013, 2014, 2015 - still extract

Return ONLY JSON, no markdown. Single flight:
{"flightNumber":"6E456","from":"DEL","to":"BOM","fromCity":"Delhi","toCity":"Mumbai","date":"2019-05-10","seat":"12A","airline":"IndiGo","departure":"06:00","arrival":"08:10"}

Multiple flights as array:
[{"flightNumber":"6E456","from":"DEL","to":"BOM","fromCity":"Delhi","toCity":"Mumbai","date":"2019-05-10","seat":"12A","airline":"IndiGo","departure":"06:00","arrival":"08:10"},{"flightNumber":"6E457","from":"BOM","to":"DEL","fromCity":"Mumbai","toCity":"Delhi","date":"2019-05-15","seat":"14B","airline":"IndiGo","departure":"09:00","arrival":"11:10"}]

Skip: OTP emails, miles/rewards, lounge invites, promotional offers, flight status updates.
If no booking found return: null` }]
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

app.post("/nylas-emails", async (req, res) => {
  try {
    const { grantId } = req.body;
    const NYLAS_KEY = process.env.NYLAS_API_KEY;

    let allEmails = [];
    let cursor = null;
    let pageCount = 0;

    do {
      const url = cursor
        ? `https://api.us.nylas.com/v3/grants/${grantId}/messages?limit=500&page_token=${cursor}`
        : `https://api.us.nylas.com/v3/grants/${grantId}/messages?limit=500`;

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

    const seen = new Set();
    allEmails = allEmails.filter(m => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });

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

app.get("/city-photo", async (req, res) => {
  try {
    const { city, iata } = req.query;
    const searchQuery = city || iata;

    const CITY_LANDMARKS = {
      "RUH": "Riyadh Saudi Arabia", "JED": "Jeddah Saudi Arabia",
      "DXB": "Dubai UAE", "AUH": "Abu Dhabi UAE",
      "BOM": "Mumbai India", "DEL": "New Delhi India",
      "SIN": "Singapore", "BKK": "Bangkok Thailand",
      "KUL": "Kuala Lumpur Malaysia", "BAH": "Manama Bahrain",
      "DOH": "Doha Qatar", "MCT": "Muscat Oman",
      "KWI": "Kuwait City", "DAC": "Dhaka Bangladesh",
      "LHR": "London England", "NRT": "Tokyo Japan",
      "IST": "Istanbul Turkey", "CAI": "Cairo Egypt",
      "DMM": "Dammam Saudi Arabia", "MED": "Medina Saudi Arabia",
      "LKO": "Lucknow India", "IXD": "Prayagraj India",
      "MAA": "Chennai India", "BLR": "Bangalore India",
      "HYD": "Hyderabad India", "CCU": "Kolkata India",
      "CMB": "Colombo Sri Lanka", "MLE": "Maldives",
      "SHJ": "Sharjah UAE", "CGP": "Chittagong Bangladesh",
      "ISB": "Islamabad Pakistan", "KHI": "Karachi Pakistan",
      "LHE": "Lahore Pakistan", "CDG": "Paris France",
      "FRA": "Frankfurt Germany", "JFK": "New York City",
      "RAH": "Rafha Saudi Arabia", "AQI": "Qaisumah Saudi Arabia",
      "TIF": "Taif Saudi Arabia", "GIZ": "Jizan Saudi Arabia",
      "ABT": "Al Baha Saudi Arabia", "ELQ": "Madinah Saudi Arabia",
    };

    const searchQuery2 = CITY_LANDMARKS[iata] || `${searchQuery} city skyline landmark`;

    const searchRes = await axios({
      url: "https://api.unsplash.com/search/photos",
      params: {
        query: searchQuery2,
        per_page: 10,
        order_by: "relevant",
        orientation: "landscape",
        content_filter: "high",
      },
      headers: {
        Authorization: `Client-ID FDMg0AEVWycwezGaeF3qO7316GBeetnvKqHQ3Q7a22w`,
      }
    });

    const results = searchRes.data?.results || [];
    if (!results.length) return res.status(404).json({ url: null });

    const photo = results.find(p => {
      const ratio = p.width / p.height;
      return ratio > 1.2;
    }) || results[0];

    const photoUrl = photo.urls?.regular || photo.urls?.full;
    if (!photoUrl) return res.status(404).json({ url: null });

    res.set("Cache-Control", "public, max-age=86400");
    res.json({ url: photoUrl });

  } catch (error) {
    console.error("City photo error:", error.response?.data || error.message);
    res.json({ url: null, error: error.response?.data || error.message });
  }
});

app.get("/nearby-airports", async (req, res) => {
  try {
    const { lat, lng, limit = 5 } = req.query;
    const userLat = parseFloat(lat);
    const userLng = parseFloat(lng);
    if (airportsCache.length === 0) await loadAirports();
    const withDistance = airportsCache
      .filter(a => a.iata && a.iata.length === 3)
      .map(a => {
        const dLat = (parseFloat(a.lat) - userLat) * Math.PI / 180;
        const dLng = (parseFloat(a.lng) - userLng) * Math.PI / 180;
        const x = Math.sin(dLat/2)**2 + Math.cos(userLat*Math.PI/180)*Math.cos(a.lat*Math.PI/180)*Math.sin(dLng/2)**2;
        const dist = Math.round(6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x)));
        return { ...a, distance: dist };
      })
      .filter(a => !isNaN(a.distance) && a.distance < 300)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, parseInt(limit));
    res.json({ airports: withDistance });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (req, res) => {
  res.json({ message: "✈️ Flight Backend Running with Nylas!" });
});

// debug-key endpoint removed for security

app.post("/trip-plan", async (req, res) => {
  try {
    const { destination, fromCity, duration, month, budget, tripType } = req.body;
    const prompt = `You are an expert travel planner. Destination: ${destination}, From: ${fromCity}, Duration: ${duration}, Month: ${month}, Budget: ${budget}, Trip type: ${tripType}. Return ONLY valid JSON no markdown: {"destination":"city","country":"country","tagline":"inspiring tagline","description":"2-3 human inspiring lines","weather":"weather in ${month}","visa":"visa info for Saudi/GCC passport","currency":"local currency name and symbol only like AED, THB, GBP","language":"local language and 2 useful phrases","timezone":"UTC offset","bestTime":"is ${month} good and why","travelVibe":"Relax/Adventure/Luxury/City Life","estimatedBudget":{"flightLocal":"price range in local currency with symbol","hotelPerNight":"price per night in local currency with symbol","dailySpend":"daily spend in local currency with symbol","totalTrip":"total trip estimate in local currency with symbol"},"attractions":[{"name":"name","desc":"1 line","emoji":"emoji","type":"must-see"},{"name":"name","desc":"1 line","emoji":"emoji","type":"hidden-gem"},{"name":"name","desc":"1 line","emoji":"emoji","type":"food"},{"name":"name","desc":"1 line","emoji":"emoji","type":"activity"},{"name":"name","desc":"1 line","emoji":"emoji","type":"must-see"}],"nearbyDestinations":[{"city":"city","country":"country","emoji":"emoji","reason":"why visit"},{"city":"city","country":"country","emoji":"emoji","reason":"why"},{"city":"city","country":"country","emoji":"emoji","reason":"why"}],"hotelAreas":["area1","area2","area3"],"foodMustTry":["dish1","dish2","dish3"],"packingList":{"essential":["item1","item2","item3"],"clothing":["item1","item2","item3"],"documents":["item1","item2"]},"dayPlan":[{"day":1,"title":"Arrival","activities":["act1","act2","act3"]},{"day":2,"title":"Explore","activities":["act1","act2","act3"]},{"day":3,"title":"Hidden Gems","activities":["act1","act2","act3"]}],"tips":["tip1","tip2","tip3"],"moodTips":{"Relax":["destination specific relax tip1","tip2","tip3"],"Adventure":["destination specific adventure tip1","tip2","tip3"],"Budget":["destination specific budget tip1","tip2","tip3"],"Luxury":["destination specific luxury tip1","tip2","tip3"]}}`;
    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      { model: "claude-haiku-4-5", max_tokens: 3000, messages: [{ role: "user", content: prompt }] },
      { headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_KEY, "anthropic-version": "2023-06-01" } }
    );
    const text = response.data.content[0].text;
    const clean = text.replace(/```json\n?|```\n?/g, "").trim();
    res.json(JSON.parse(clean));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get("/geocode", async (req, res) => {
  try {
    const { city } = req.query;
    const r = await axios.get(`https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(city)}&limit=1&appid=${WEATHER_KEY}`);
    res.json(r.data[0] || null);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get("/aqi", async (req, res) => {
  try {
    const { lat, lon } = req.query;
    const r = await axios.get(`https://api.openweathermap.org/data/2.5/air_pollution?lat=${lat}&lon=${lon}&appid=${WEATHER_KEY}`);
    const aqi = r.data.list[0];
    const labels = ["", "Good 🟢", "Fair 🟡", "Moderate 🟠", "Poor 🔴", "Very Poor 🟣"];
    res.json({ aqi: aqi.main.aqi, label: labels[aqi.main.aqi], pm25: aqi.components.pm2_5, pm10: aqi.components.pm10 });
  } catch(err) { res.status(500).json({ error: err.message }); }
});
// Gmail fetch using user's Google token
app.post("/gmail-emails", async (req, res) => {
  try {
    const { accessToken } = req.body;
    if (!accessToken) return res.status(400).json({ error: "No access token" });

    const AIRLINE_DOMAINS = [
      "saudia.com", "flynas.com", "flyadeal.com", "emirates.com",
      "etihad.com", "flydubai.com", "gulfair.com", "airindia.in",
      "goindigo.in", "customer.goindigo.in", "notification.saudia.com", "emirates.email", "itinerary.flyscoot.com", "kuwaitairways.com", "omanair.com", "spicejet.com",
      "flyscoot.com", "airarabia.com", "jazeeraairways.com",
      "qatarairways.com", "turkishairlines.com", "egyptair.com",
      "biman-airlines.com", "thaiairways.com", "malaysiaairlines.com",
    ];

    const query = AIRLINE_DOMAINS.map(d => `from:${d}`).join(" OR ");

    let allMessages = [];
    let pageToken = null;

    do {
      const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=500${pageToken ? `&pageToken=${pageToken}` : ""}`;
      const searchRes = await axios.get(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      const msgs = searchRes.data.messages || [];
      allMessages = [...allMessages, ...msgs];
      pageToken = searchRes.data.nextPageToken || null;
    } while (pageToken);

    if (!allMessages.length) return res.json({ emails: [], total: 0 });

    const emails = [];
    for (const msg of allMessages) {
      try {
        const detail = await axios.get(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const headers = detail.data.payload?.headers || [];
        const subject = headers.find(h => h.name === "Subject")?.value || "";
        const from = headers.find(h => h.name === "From")?.value || "";
        const date = headers.find(h => h.name === "Date")?.value || "";

        let body = "";
        const allParts = [];
        function collectParts(payload) {
          if (!payload) return;
          if (payload.parts) payload.parts.forEach(collectParts);
          else allParts.push(payload);
          if (payload.body?.data) allParts.push(payload);
        }
        collectParts(detail.data.payload);

        for (const part of allParts) {
          if (part?.mimeType === "text/plain" && part?.body?.data) {
            body = Buffer.from(part.body.data, "base64").toString("utf-8").slice(0, 3000);
            break;
          }
        }
        if (!body) {
          for (const part of allParts) {
            if (part?.mimeType === "text/html" && part?.body?.data) {
              const html = Buffer.from(part.body.data, "base64").toString("utf-8");
              body = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 3000);
              break;
            }
          }
        }
        if (!body && detail.data.payload?.body?.data) {
          body = Buffer.from(detail.data.payload.body.data, "base64").toString("utf-8").slice(0, 3000);
        }

        emails.push({ id: msg.id, subject, from, body, date });
      } catch {}
    }

    res.json({ emails, total: emails.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


app.post("/travel-dna", async (req, res) => {
  try {
    const { stats } = req.body;
    const prompt = `You are a witty, poetic travel personality analyzer. Based on this traveler's real flight data, create their unique Travel DNA profile.

FLIGHT DATA:
- Total flights: ${stats.totalFlights}
- Total km: ${stats.totalKm}
- Countries visited: ${stats.countries.join(", ")}
- Top airline: ${stats.topAirline} (${stats.topAirlineCount} flights)
- Second airline: ${stats.secondAirline || "none"}
- Most flown route: ${stats.topRoute}
- Average flight distance: ${stats.avgKm} km
- Favorite day to fly: ${stats.favoriteDay}
- Favorite month: ${stats.favoriteMonth}
- Short haul % (under 1500km): ${stats.shortHaulPct}%
- Long haul % (over 5000km): ${stats.longHaulPct}%
- Years flying: ${stats.yearsFlying}
- Most visited city: ${stats.topCity}
- Total days in air: ${stats.daysInAir}

Return ONLY valid JSON, no markdown:
{"title":"THE GULF NOMAD","subtitle":"Short-Haul Royalty","poem":["Line 1 poetic max 8 words","Line 2 poetic max 8 words","Line 3 poetic max 8 words","Line 4 poetic max 8 words"],"traits":[{"emoji":"🕐","label":"Thursday Night Flyer","detail":"34% of flights"},{"emoji":"🛫","label":"Short Haul Addict","detail":"avg 892 km"},{"emoji":"🔁","label":"Route Loyalist","detail":"RUH↔BOM x 12"},{"emoji":"✈️","label":"Saudia Faithful","detail":"81 flights 38%"},{"emoji":"🌍","label":"Gulf Resident","detail":"68% GCC routes"}],"dnaScores":{"Loyalty":78,"Adventure":42,"Distance":18,"Frequency":91,"Explorer":35},"funFact":"One surprising funny insight in 1 sentence"}`;

    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      { model: "claude-haiku-4-5", max_tokens: 1000, messages: [{ role: "user", content: prompt }] },
      { headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_KEY, "anthropic-version": "2023-06-01" } }
    );
    const text = response.data.content[0].text;
    const clean = text.replace(/```json\n?|```\n?/g, "").trim();
    res.json(JSON.parse(clean));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


app.get("/flight-info", async (req, res) => {
  try {
    const { flightNumber } = req.query;
    if (!flightNumber) return res.status(400).json({ error: "Flight number required" });
    const { date } = req.query;
    const dates = [];
    if (date) {
      // Specific date requested
      dates.push(date);
    } else {
      // Auto: today, tomorrow, yesterday, last 7 days
      dates.push(new Date(Date.now() + 2*86400000).toISOString().slice(0,10));
      dates.push(new Date(Date.now() + 86400000).toISOString().slice(0,10));
      for (let i = 0; i <= 7; i++) {
        dates.push(new Date(Date.now() - i * 86400000).toISOString().slice(0,10));
      }
    }

    let flight = null;
    for (const date of dates) {
      try {
        const response = await axios.get(
          `https://aerodatabox.p.rapidapi.com/flights/number/${flightNumber.toUpperCase().replace(/\s/g,"")}/${date}`,
          { headers: { "X-RapidAPI-Key": process.env.AERODATABOX_KEY, "X-RapidAPI-Host": "aerodatabox.p.rapidapi.com" } }
        );
        const data = response.data;
        if (Array.isArray(data) && data.length > 0) { flight = data[0]; break; }
      } catch(e) {}
    }
    if (!flight) return res.json({ found: false });
    const schedDep = flight.departure?.scheduledTime?.utc;
    const revisedDep = flight.departure?.revisedTime?.utc;
    let delayMinutes = 0;
    if (schedDep && revisedDep) delayMinutes = Math.round((new Date(revisedDep)-new Date(schedDep))/60000);
    res.json({
      found: true,
      flightNumber: flight.number || flightNumber,
      airline: flight.airline?.name || "",
      airlineIata: flight.airline?.iata || "",
      from: flight.departure?.airport?.iata || "",
      fromCity: flight.departure?.airport?.municipalityName || "",
      fromTerminal: flight.departure?.terminal || "",
      to: flight.arrival?.airport?.iata || "",
      toCity: flight.arrival?.airport?.municipalityName || "",
      toTerminal: flight.arrival?.terminal || "",
      baggageBelt: flight.arrival?.baggageBelt || "",
      aircraft: flight.aircraft?.model || "",
      aircraftReg: flight.aircraft?.reg || "",
      distanceKm: Math.round(flight.greatCircleDistance?.km || 0),
      scheduledDep: flight.departure?.scheduledTime?.local || "",
      scheduledArr: flight.arrival?.scheduledTime?.local || "",
      revisedDep: flight.departure?.revisedTime?.local || "",
      revisedArr: flight.arrival?.revisedTime?.local || "",
      status: flight.status || "",
      delayMinutes,
      isCargo: flight.isCargo || false,
    });
  } catch (err) { res.json({ found: false, error: err.message }); }
});

app.get("/aircraft-photo", async (req, res) => {
  try {
    const { reg, airline, aircraft } = req.query;

    // Try 1: Planespotters by exact registration
    if (reg && reg.trim()) {
      try {
        const r = await axios.get(`https://api.planespotters.net/pub/photos/reg/${reg.toUpperCase().trim()}`, { timeout: 5000 });
        const photos = r.data?.photos;
        if (photos && photos.length > 0) {
          return res.json({
            found: true,
            thumbnail: photos[0].thumbnail_large?.src || photos[0].thumbnail?.src,
            photographer: photos[0].photographer,
            aircraft: photos[0].aircraft?.model || "",
            source: "registration",
          });
        }
      } catch(e) {}
    }

    // Try 2: Planespotters by airline IATA code
    if (airline && airline.trim()) {
      try {
        const r = await axios.get(`https://api.planespotters.net/pub/photos/airline/${airline.toUpperCase().trim()}`, { timeout: 5000 });
        const photos = r.data?.photos;
        if (photos && photos.length > 0) {
          // Pick a photo matching aircraft type if possible
          let best = photos[0];
          if (aircraft) {
            const match = photos.find(p => p.aircraft?.model?.toLowerCase().includes(aircraft.toLowerCase().split(" ")[1] || ""));
            if (match) best = match;
          }
          return res.json({
            found: true,
            thumbnail: best.thumbnail_large?.src || best.thumbnail?.src,
            photographer: best.photographer,
            aircraft: best.aircraft?.model || "",
            source: "airline_fleet",
          });
        }
      } catch(e) {}
    }

    // Try 3: Unsplash — high quality aviation photos
    if (airline || aircraft) {
      try {
        const UNSPLASH_KEY = process.env.UNSPLASH_ACCESS_KEY;
        if (UNSPLASH_KEY) {
          // Build search query
          const airlineNames = {
            "EK": "Emirates", "SV": "Saudia", "6E": "IndiGo", "AI": "Air India",
            "QR": "Qatar Airways", "EY": "Etihad", "FZ": "flydubai", "XY": "flynas",
            "WY": "Oman Air", "GF": "Gulf Air", "G9": "Air Arabia", "KU": "Kuwait Airways",
            "TK": "Turkish Airlines", "BA": "British Airways", "LH": "Lufthansa",
            "AF": "Air France", "KL": "KLM", "J9": "Jazeera", "F3": "Flyadeal",
            "BG": "Biman Bangladesh", "SG": "SpiceJet", "TG": "Thai Airways",
            "SQ": "Singapore Airlines", "CX": "Cathay Pacific",
          };
          const airlineName = airlineNames[airline?.toUpperCase()] || airline || "";
          const aircraftType = aircraft?.split(" ").slice(0,2).join(" ") || "";
          const query = `${airlineName} ${aircraftType} airplane`.trim();

          const r = await axios.get(`https://api.unsplash.com/search/photos`, {
            params: { query, per_page: 5, orientation: "landscape" },
            headers: { Authorization: `Client-ID ${UNSPLASH_KEY}` },
            timeout: 5000,
          });

          const results = r.data?.results;
          if (results && results.length > 0) {
            const photo = results[0];
            return res.json({
              found: true,
              thumbnail: photo.urls?.regular || photo.urls?.small,
              photographer: photo.user?.name || "Unsplash",
              source: "unsplash",
              credit_url: photo.links?.html,
            });
          }
        }
      } catch(e) {}
    }

    // Try 4: Unsplash generic aviation (no API key needed — public collections)
    try {
      const airlineNames = {
        "EK": "Emirates", "SV": "Saudia", "QR": "Qatar", "EY": "Etihad",
        "6E": "IndiGo", "AI": "Air India", "TK": "Turkish", "BA": "British Airways",
      };
      const airlineName = airlineNames[airline?.toUpperCase()] || "airplane";
      const aircraftShort = aircraft?.split(" ")[1] || "aircraft";
      const query = encodeURIComponent(`${airlineName} ${aircraftShort}`);
      
      // Use Unsplash source (no API key, returns random relevant image)
      return res.json({
        found: true,
        thumbnail: `https://source.unsplash.com/800x500/?${query}`,
        photographer: "Unsplash",
        source: "unsplash_public",
      });
    } catch(e) {}

    res.json({ found: false });
  } catch (err) { res.json({ found: false, error: err.message }); }
});


app.get("/route-flights", async (req, res) => {
  try {
    const { from, to, date } = req.query;
    if (!from || !to) return res.status(400).json({ error: "from and to required" });
    const useDate = date || new Date().toISOString().slice(0,10);
    const response = await axios.get(
      `https://aerodatabox.p.rapidapi.com/flights/airports/iata/${from}/${useDate}T00:00/${useDate}T23:59`,
      {
        params: { withLeg: true, direction: "Departure", withCancelled: false, withCodeshared: false, withCargo: false },
        headers: { "X-RapidAPI-Key": process.env.AERODATABOX_KEY, "X-RapidAPI-Host": "aerodatabox.p.rapidapi.com" }
      }
    );
    const flights = response.data?.departures || [];
    const matching = flights
      .filter(f => f.arrival?.airport?.iata === to.toUpperCase())
      .map(f => ({
        number: f.number,
        airline: f.airline?.name || "",
        dep: f.departure?.scheduledTime?.local || "",
        arr: f.arrival?.scheduledTime?.local || "",
        status: f.status || "",
      }));
    res.json({ flights: matching });
  } catch(err) {
    res.json({ flights: [], error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✈️ Server running on http://localhost:${PORT}`);
});