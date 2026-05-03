const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { lat, lng } = req.query;

  if (!lat || !lng) {
    return res.status(400).json({ error: 'lat and lng are required' });
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Google Maps API key not configured' });
  }

  // ----------------------------------------------------------------
  // Detect if user is in Ireland or Northern Ireland
  // ----------------------------------------------------------------
  let isOnIsland = false;
  try {
    const geoUrl = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${apiKey}`;
    const geoRes = await fetch(geoUrl);
    const geoData = await geoRes.json();
    for (const result of geoData.results || []) {
      for (const component of result.address_components || []) {
        if (component.types.includes('country')) {
          if (component.short_name === 'IE') isOnIsland = true;
          if (component.short_name === 'GB') {
            // Check for Northern Ireland
            for (const c2 of result.address_components) {
              if (c2.long_name.includes('Northern Ireland')) isOnIsland = true;
            }
          }
        }
      }
      if (isOnIsland) break;
    }
  } catch (geoErr) {
    console.error('Geocode error (non-fatal):', geoErr);
  }

  // ----------------------------------------------------------------
  // Search strategy:
  // Ireland — broad search, all bars/pubs/restaurants (they're all Irish)
  // Abroad  — search for Irish pubs specifically
  // ----------------------------------------------------------------
  const radii = [1000, 5000, 20000, 50000];
  const radiusLabels = { 1000: '1km', 5000: '5km', 20000: '20km', 50000: '50km' };

  let results = [];
  let usedRadius = 1000;

  try {
    if (isOnIsland) {
      // Ireland — every pub is Irish so search broadly
      // Use multiple keywords AND no type filter to catch hotels with bars,
      // gastropubs, restaurants, lounges — anything serving alcohol
      const keywordSearches = [
        { keyword: 'bar',      type: 'bar' },
        { keyword: 'pub',      type: 'bar' },
        { keyword: 'gastropub',type: null  },
        { keyword: 'tavern',   type: null  },
        { keyword: 'lounge',   type: 'bar' },
        { keyword: 'bar',      type: null  }, // no type — catches hotels with bars
        { keyword: 'pub',      type: null  }, // no type — catches all pub categories
        { keyword: 'whiskey bar', type: null }, // catches whiskey bars like Dylans
        { keyword: 'nightclub', type: 'night_club' },
      ];

      for (const radius of radii) {
        const allResults = [];
        const seenIds = new Set();

        // Run all searches in parallel
        const searches = keywordSearches.map(({ keyword, type }) => {
          let url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=${radius}&keyword=${encodeURIComponent(keyword)}&key=${apiKey}`;
          if (type) url += `&type=${type}`;
          return fetch(url).then(r => r.json()).catch(() => ({ results: [] }));
        });

        const allData = await Promise.all(searches);
        for (const d of allData) {
          for (const place of d.results || []) {
            if (!seenIds.has(place.place_id)) {
              seenIds.add(place.place_id);
              allResults.push(place);
            }
          }
        }

        results = allResults;
        usedRadius = radius;
        if (results.length >= 3) break;
      }

    } else {
      // Abroad — cast wide net to catch Irish pubs regardless of name
      // Google keyword search covers business name + customer review text
      // So 'guinness' and 'craic' catch pubs that locals describe as Irish
      const irishKeywords = [
        'irish pub',
        'irish bar',
        'guinness',
        'irish whiskey',
        'ireland',
        'craic',
      ];

      for (const radius of [5000, 20000, 50000, 100000]) {
        const allResults = [];
        const seenIds = new Set();

        // Run all keyword searches in parallel for speed
        const searches = irishKeywords.map(keyword => {
          const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=${radius}&keyword=${encodeURIComponent(keyword)}&type=bar&key=${apiKey}`;
          return fetch(url).then(r => r.json()).catch(() => ({ results: [] }));
        });

        // Also search restaurants for irish pub keyword
        const restUrl = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=${radius}&keyword=irish+pub&type=restaurant&key=${apiKey}`;
        searches.push(fetch(restUrl).then(r => r.json()).catch(() => ({ results: [] })));

        const allData = await Promise.all(searches);
        for (const d of allData) {
          for (const place of d.results || []) {
            if (!seenIds.has(place.place_id)) {
              seenIds.add(place.place_id);
              allResults.push(place);
            }
          }
        }

        results = allResults;
        usedRadius = radius;
        if (results.length > 0) break;
      }
    }

    // --- Pull verified pints from Firestore ---
    let verifiedPubs = {};
    try {
      const admin = await import('firebase-admin');
      if (!admin.default.apps.length) {
        admin.default.initializeApp({
          credential: admin.default.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
          }),
        });
      }
      const db = admin.default.firestore();
      const pintsSnap = await db.collection('pint_hashes').get();
      pintsSnap.forEach(doc => {
        const data = doc.data();
        if (data.pub) {
          const key = data.pub.toLowerCase().trim();
          verifiedPubs[key] = (verifiedPubs[key] || 0) + 1;
        }
      });
    } catch (fbErr) {
      console.error('Firestore error (non-fatal):', fbErr);
    }

    // --- Calculate distance and build response ---
    const pubs = results.slice(0, 15).map(place => {
      const pubNameKey = place.name.toLowerCase().trim();
      const pintCount = verifiedPubs[pubNameKey] || 0;
      const verified = pintCount > 0;

      const R = 6371;
      const dLat = ((place.geometry.location.lat - parseFloat(lat)) * Math.PI) / 180;
      const dLng = ((place.geometry.location.lng - parseFloat(lng)) * Math.PI) / 180;
      const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos((parseFloat(lat) * Math.PI) / 180) *
          Math.cos((place.geometry.location.lat * Math.PI) / 180) *
          Math.sin(dLng / 2) *
          Math.sin(dLng / 2);
      const distanceKm = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

      const distanceStr = distanceKm < 1
        ? `${Math.round(distanceKm * 1000)}m away`
        : `${distanceKm.toFixed(1)}km away`;

      const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${place.geometry.location.lat},${place.geometry.location.lng}&destination_place_id=${place.place_id}`;

      return {
        name: place.name,
        address: place.vicinity || '',
        lat: place.geometry.location.lat,
        lng: place.geometry.location.lng,
        rating: place.rating || null,
        total_ratings: place.user_ratings_total || 0,
        open_now: place.opening_hours?.open_now ?? null,
        distance: distanceStr,
        distance_km: distanceKm,
        maps_url: mapsUrl,
        place_id: place.place_id,
        verified,
        pint_count: pintCount,
      };
    });

    // Sort purely by distance — closest first always
    pubs.sort((a, b) => a.distance_km - b.distance_km);

    return res.status(200).json({
      pubs,
      search_radius: radiusLabels[usedRadius] || `${usedRadius/1000}km`,
      expanded: usedRadius > 1000,
      is_on_island: isOnIsland,
    });

  } catch (err) {
    console.error('find-pubs error:', err);
    return res.status(500).json({ error: 'Failed to find pubs', detail: err.message });
  }
}
