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


// Cache for flight info - expires after 1 hour
const flightCache = {};

app.get("/flight-info", async (req, res) => {
  try {
    const { flightNumber, date } = req.query;
    if (!flightNumber) return res.status(400).json({ error: "Flight number required" });
    
    const fn = flightNumber.toUpperCase().replace(/\s/g,"");
    const cacheKey = date ? `${fn}-${date}` : fn;
    
    // Return cache if less than 1 hour old
    if (flightCache[cacheKey] && (Date.now() - flightCache[cacheKey].ts) < 3600000 && flightCache[cacheKey].data.status !== "Arrived") {
      return res.json(flightCache[cacheKey].data);
    }

    // Build date list - today, tomorrow, yesterday, up to 7 days back
    const dates = date ? [date] : [
      new Date().toISOString().slice(0,10),                           // today
      new Date(Date.now() + 86400000).toISOString().slice(0,10),     // tomorrow
      new Date(Date.now() - 86400000).toISOString().slice(0,10),     // yesterday
      new Date(Date.now() - 2*86400000).toISOString().slice(0,10),   // 2 days ago
      new Date(Date.now() - 3*86400000).toISOString().slice(0,10),   // 3 days ago
    ];

    let flight = null;
    for (const d of dates) {
      try {
        const r = await axios.get(
          `https://aerodatabox.p.rapidapi.com/flights/number/${fn}/${d}`,
          { headers: { "X-RapidAPI-Key": process.env.AERODATABOX_KEY, "X-RapidAPI-Host": "aerodatabox.p.rapidapi.com" } }
        );
        if (Array.isArray(r.data) && r.data.length > 0) {
          flight = r.data[0];
          // If has reg, stop searching
          if (flight.aircraft?.reg) break;
        }
      } catch(e) { if(e.response?.status === 429) break; } // Stop on rate limit
    }

    if (!flight) {
      flightCache[cacheKey] = { data: { found: false }, ts: Date.now() };
      return res.json({ found: false });
    }

    const schedDep = flight.departure?.scheduledTime?.utc;
    const revisedDep = flight.departure?.revisedTime?.utc;
    const delayMinutes = schedDep && revisedDep
      ? Math.round((new Date(revisedDep) - new Date(schedDep)) / 60000)
      : 0;

    const result = {
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
      durationMins: (() => { const dep = new Date((flight.departure?.scheduledTime?.utc||"").replace(" ","T")); const arr = new Date((flight.arrival?.scheduledTime?.utc||"").replace(" ","T")); const apiMins = arr-dep > 0 ? Math.round((arr-dep)/60000) : 0; const distMins = Math.round((flight.greatCircleDistance?.km||0)/850*60); return apiMins > 0 && apiMins < 600 ? apiMins : distMins; })(),
      scheduledDep: flight.departure?.scheduledTime?.local || "",
      scheduledDepUtc: flight.departure?.scheduledTime?.utc || "",
      scheduledArr: flight.arrival?.scheduledTime?.local || "",
      scheduledArrUtc: flight.arrival?.scheduledTime?.utc || "",
      revisedDep: flight.departure?.revisedTime?.local || "",
      revisedArr: flight.arrival?.revisedTime?.local || "",
      status: flight.status || "",
      delayMinutes,
      isCargo: flight.isCargo || false,
      durationMins: Math.round((flight.greatCircleDistance?.km || 0) / 850 * 60),
    };

    flightCache[cacheKey] = { data: result, ts: Date.now() };
    res.json(result);
  } catch (err) { res.json({ found: false, error: err.message }); }
});

app.get("/aircraft-photo", async (req, res) => {
  try {
    const { reg, airline, aircraft } = req.query;

    const AIRLINE_NAMES = {
      'EK':'Emirates','SV':'Saudia','QR':'Qatar Airways','EY':'Etihad Airways',
      '6E':'IndiGo','AI':'Air India','TK':'Turkish Airlines','BA':'British Airways',
      'XY':'flynas','FZ':'flydubai','F3':'Flyadeal','WY':'Oman Air',
      'GF':'Gulf Air','G9':'Air Arabia','KU':'Kuwait Airways','LH':'Lufthansa',
      'AF':'Air France','KL':'KLM','SQ':'Singapore Airlines','CX':'Cathay Pacific',
      'J9':'Jazeera Airways','BG':'Biman Bangladesh','SG':'SpiceJet','TG':'Thai Airways',
    };

    // Try 1: Planespotters by exact registration (most accurate)
    if (reg && reg.trim().length > 3) {
      try {
        const r = await axios.get(
          `https://api.planespotters.net/pub/photos/reg/${reg.toUpperCase().trim()}`,
          { timeout: 6000, headers: { 'User-Agent': 'FlowntoApp/1.0' } }
        );
        const photos = r.data?.photos;
        if (photos && photos.length > 0) {
          const p = photos[0];
          return res.json({
            found: true,
            thumbnail: p.thumbnail_large?.src || p.thumbnail?.src,
            photographer: p.photographer || 'Planespotters',
            aircraft: p.aircraft?.model || '',
            source: 'registration',
          });
        }
      } catch(e) { console.log('Planespotters reg failed:', e.message); }
    }

    // Try 2: Unsplash with API key (high quality, specific)
    const UNSPLASH_KEY = process.env.UNSPLASH_ACCESS_KEY;
    if (UNSPLASH_KEY) {
      try {
        const airlineName = AIRLINE_NAMES[airline?.toUpperCase()] || airline || '';
        const aircraftType = aircraft?.split(' ').slice(0, 2).join(' ') || '';
        const query = `${airlineName} ${aircraftType} airplane`.trim();
        const r = await axios.get('https://api.unsplash.com/search/photos', {
          params: { query, per_page: 3, orientation: 'landscape' },
          headers: { Authorization: `Client-ID ${UNSPLASH_KEY}` },
          timeout: 5000,
        });
        const results = r.data?.results;
        if (results && results.length > 0) {
          const photo = results[0];
          return res.json({
            found: true,
            thumbnail: photo.urls?.regular || photo.urls?.small,
            photographer: photo.user?.name || 'Unsplash',
            source: 'unsplash',
          });
        }
      } catch(e) { console.log('Unsplash API failed:', e.message); }
    }

    // Try 3: Unsplash Source (no API key needed — always works)
    const airlineName = AIRLINE_NAMES[airline?.toUpperCase()] || 'airplane';
    const aircraftShort = aircraft ? aircraft.split(' ').slice(0, 2).join(' ') : 'aircraft';
    const query = encodeURIComponent(`${airlineName} ${aircraftShort}`);
    const airlinePhotos = {
      'EK': 'https://images.unsplash.com/photo-1569629743817-70d8db6c323b?w=800&q=80',
      'SV': 'https://images.unsplash.com/photo-1436491865332-7a61a109cc05?w=800&q=80',
      'QR': 'https://images.unsplash.com/photo-1540962351504-03099e0a754b?w=800&q=80',
      'EY': 'https://images.unsplash.com/photo-1559268950-b7a0e5b5e5b5?w=800&q=80',
      '6E': 'https://images.unsplash.com/photo-1474302771604-a11e4b7d8f1a?w=800&q=80',
      'AI': 'https://images.unsplash.com/photo-1436491865332-7a61a109cc05?w=800&q=80',
      'TK': 'https://images.unsplash.com/photo-1569629743817-70d8db6c323b?w=800&q=80',
      'XY': 'https://images.unsplash.com/photo-1436491865332-7a61a109cc05?w=800&q=80',
      'FZ': 'https://images.unsplash.com/photo-1436491865332-7a61a109cc05?w=800&q=80',
    };
    const directPhoto = airlinePhotos[airline?.toUpperCase()] || 'https://images.unsplash.com/photo-1436491865332-7a61a109cc05?w=800&q=80';
    return res.json({
      found: true,
      thumbnail: directPhoto,
      photographer: 'Unsplash',
      source: 'unsplash_public',
    });

  } catch (err) {
    // Absolute last resort
    res.json({
      found: true,
      thumbnail: 'https://source.unsplash.com/800x450/?airplane',
      photographer: 'Unsplash',
      source: 'fallback',
    });
  }
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


app.get("/airport-info", async (req, res) => {
  try {
    const { iata } = req.query;
    if (!iata) return res.status(400).json({ error: "IATA required" });
    const response = await axios.get(
      `https://aerodatabox.p.rapidapi.com/airports/iata/${iata.toUpperCase()}`,
      { headers: { "X-RapidAPI-Key": process.env.AERODATABOX_KEY, "X-RapidAPI-Host": "aerodatabox.p.rapidapi.com" } }
    );
    res.json(response.data);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

const similarFlightsCache = {};

app.get("/similar-flights", async (req, res) => {
  try {
    const { from, to, date } = req.query;
    if (!from || !to) return res.status(400).json({ error: "from and to required" });
    const useDate = date || new Date().toISOString().slice(0,10);
    const cacheKey = `${from}-${to}-${useDate}`;

    // Cache for 2 hours
    if (similarFlightsCache[cacheKey] && (Date.now() - similarFlightsCache[cacheKey].ts) < 7200000) {
      return res.json({ flights: similarFlightsCache[cacheKey].data, cached: true });
    }

    const start = `${useDate}T00:00`;
    const end = `${useDate}T12:00`;
    const response = await axios.get(
      `https://aerodatabox.p.rapidapi.com/flights/airports/iata/${from.toUpperCase()}/${start}/${end}?withLeg=true&direction=Departure&withCancelled=false&withCodeshared=false&withCargo=false`,
      { headers: { "X-RapidAPI-Key": process.env.AERODATABOX_KEY, "X-RapidAPI-Host": "aerodatabox.p.rapidapi.com" } }
    );
    const all = response.data?.departures || [];
    const matching = all
      .filter(f => f.arrival?.airport?.iata === to.toUpperCase())
      .map(f => ({
        number: f.number,
        airline: f.airline?.name || "",
        airlineIata: f.airline?.iata || "",
        dep: f.departure?.scheduledTime?.local || "",
        arr: f.arrival?.scheduledTime?.local || "",
        terminal: f.departure?.terminal || "",
        aircraft: f.aircraft?.model || "",
        status: f.status || "",
      }));

    similarFlightsCache[cacheKey] = { data: matching, ts: Date.now() };
    res.json({ flights: matching });
  } catch(err) { res.json({ flights: [], error: err.message }); }
});


app.get("/flight-autocomplete", async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json({ items: [] });
    const r = await axios.get(
      `https://aerodatabox.p.rapidapi.com/flights/search/term?q=${q.toUpperCase()}`,
      { headers: { "X-RapidAPI-Key": process.env.AERODATABOX_KEY, "X-RapidAPI-Host": "aerodatabox.p.rapidapi.com" } }
    );
    res.json({ items: r.data?.items || [] });
  } catch(e) { res.json({ items: [] }); }
});

app.get("/aircraft-image", async (req, res) => {
  try {
    const { reg } = req.query;
    if (!reg) return res.json({ found: false });
    const r = await axios.get(
      `https://aerodatabox.p.rapidapi.com/aircrafts/reg/${reg.toUpperCase()}/image/beta`,
      { headers: { "X-RapidAPI-Key": process.env.AERODATABOX_KEY, "X-RapidAPI-Host": "aerodatabox.p.rapidapi.com" } }
    );
    if (r.data?.url) return res.json({ found: true, url: r.data.url, author: r.data.author });
    res.json({ found: false });
  } catch(e) { res.json({ found: false }); }
});

app.get("/aircraft-details", async (req, res) => {
  try {
    const { reg } = req.query;
    if (!reg) return res.json({ found: false });
    const r = await axios.get(
      `https://aerodatabox.p.rapidapi.com/aircrafts/reg/${reg.toUpperCase()}`,
      { headers: { "X-RapidAPI-Key": process.env.AERODATABOX_KEY, "X-RapidAPI-Host": "aerodatabox.p.rapidapi.com" } }
    );
    if (r.data) return res.json({
      found: true,
      reg: r.data.reg,
      model: r.data.model,
      airlineName: r.data.airlineName,
      age: r.data.age,
      firstFlightDate: r.data.firstFlightDate,
      numSeats: r.data.numSeats,
    });
    res.json({ found: false });
  } catch(e) { res.json({ found: false }); }
});

app.get("/flight-dates", async (req, res) => {
  try {
    const { flightNumber } = req.query;
    if (!flightNumber) return res.json({ dates: [] });
    const today = new Date();
    const from = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0,10);
    const to = new Date(today.getFullYear(), today.getMonth()+2, 0).toISOString().slice(0,10);
    const r = await axios.get(
      `https://aerodatabox.p.rapidapi.com/flights/number/${flightNumber.toUpperCase().replace(/\s/g,"")}/dates/${from}/${to}`,
      { headers: { "X-RapidAPI-Key": process.env.AERODATABOX_KEY, "X-RapidAPI-Host": "aerodatabox.p.rapidapi.com" } }
    );
    res.json({ dates: Array.isArray(r.data) ? r.data : [] });
  } catch(e) { res.json({ dates: [] }); }
});


app.get("/find-aircraft-reg", async (req, res) => {
  try {
    const { flightNumber } = req.query;
    if (!flightNumber) return res.json({ reg: "" });
    const fn = flightNumber.toUpperCase().replace(/\s/g,"");
    // Check last 7 days
    for (let i = 1; i <= 7; i++) {
      const date = new Date(Date.now() - i * 86400000).toISOString().slice(0,10);
      try {
        const r = await axios.get(
          `https://aerodatabox.p.rapidapi.com/flights/number/${fn}/${date}`,
          { headers: { "X-RapidAPI-Key": process.env.AERODATABOX_KEY, "X-RapidAPI-Host": "aerodatabox.p.rapidapi.com" } }
        );
        if (Array.isArray(r.data) && r.data.length > 0 && r.data[0].aircraft?.reg) {
          return res.json({ reg: r.data[0].aircraft.reg, date });
        }
      } catch(e) {}
    }
    res.json({ reg: "" });
  } catch(e) { res.json({ reg: "" }); }
});


// DeepL Translation
app.post("/translate", async (req, res) => {
  try {
    const { text, target_lang, source_lang } = req.body;
    const response = await fetch("https://api-free.deepl.com/v2/translate", {
      method: "POST",
      headers: {
        "Authorization": `DeepL-Auth-Key ${process.env.DEEPL_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: [text], target_lang: target_lang || "EN", source_lang: source_lang || null }),
    });
    const data = await response.json();
    res.json({ translation: data.translations?.[0]?.text || "" });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
app.listen(PORT, () => {
  console.log(`✈️ Server running on http://localhost:${PORT}`);
});
// ── PEXELS COUNTRY PHOTOS ──────────────────────────────────────
app.get('/country-photos', async (req, res) => {
  const { country } = req.query;
  if (!country) return res.status(400).json({ error: 'country required' });
  try {
    const query = encodeURIComponent(`${country} landmark travel`);
    const response = await fetch(
      `https://api.pexels.com/v1/search?query=${query}&per_page=4&orientation=landscape`,
      { headers: { Authorization: process.env.PEXELS_KEY } }
    );
    const data = await response.json();
    const photos = (data.photos || []).map(p => ({
      url: p.src.large,
      thumb: p.src.medium,
      photographer: p.photographer,
      alt: p.alt,
    }));
    res.json({ photos });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PEXELS COUNTRY PHOTOS ──────────────────────────────────────
app.get('/country-photos', async (req, res) => {
  const { country } = req.query;
  if (!country) return res.status(400).json({ error: 'country required' });
  try {
    const query = encodeURIComponent(`${country} landmark travel`);
    const response = await fetch(
      `https://api.pexels.com/v1/search?query=${query}&per_page=4&orientation=landscape`,
      { headers: { Authorization: process.env.PEXELS_KEY } }
    );
    const data = await response.json();
    const photos = (data.photos || []).map(p => ({
      url: p.src.large,
      thumb: p.src.medium,
      photographer: p.photographer,
      alt: p.alt,
    }));
    res.json({ photos });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Flight time between airports
app.get("/flight-time", async (req, res) => {
  try {
    const { dep, arr } = req.query;
    const r = await axios.get(
      `https://aerodatabox.p.rapidapi.com/flights/airports/iata/${dep}/to/${arr}`,
      { headers: { "X-RapidAPI-Key": process.env.AERODATABOX_KEY, "X-RapidAPI-Host": "aerodatabox.p.rapidapi.com" } }
    );
    res.json(r.data);
  } catch(e) { res.json({ error: true }); }
});
