import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const db = getFirestore();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate');

  try {
    // Bumped limit from 200 → 1000
    const snapshot = await db.collection('pint_hashes')
      .limit(1000)
      .get();

    const pints = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      // FIX: don't drop records missing pub_lat/pub_lng — they're valid verifications.
      // Only skip if there's genuinely no location at all (no pub coords AND no place_id).
      if (!data.pub_lat && !data.pub_lng && !data.place_id) return;
      pints.push({
        id:               doc.id,
        pub:              data.pub,
        display_name:     data.display_name || '',
        pub_lat:          data.pub_lat || null,
        pub_lng:          data.pub_lng || null,
        place_id:         data.place_id,
        google_maps_url:  data.google_maps_url || '',
        pub_address:      data.pub_address || '',
        pub_website:      data.pub_website || '',
        pub_phone:        data.pub_phone || '',
        pub_rating:       data.pub_rating || '',
        pub_total_ratings: data.pub_total_ratings || 0,
        county:           data.county || '',
        country:          data.country || '',
        country_code:     data.country_code || '',
        timestamp:        data.timestamp?.toDate?.()?.toISOString() || '',
        pub_place_photo:  data.pub_place_photo || '',
        tx_hash:          data.tx_hash || '',
      });
    });

    // Get leaderboard data
    const [countiesSnap, countriesSnap, pubsSnap] = await Promise.all([
      db.collection('leaderboard_counties').orderBy('count', 'desc').limit(10).get(),
      db.collection('leaderboard_countries').orderBy('count', 'desc').limit(10).get(),
      db.collection('leaderboard_pubs').orderBy('count', 'desc').limit(10).get(),
    ]);

    const leaderboards = {
      counties:  [],
      countries: [],
      pubs:      [],
      users:     [],
    };

    countiesSnap.forEach(doc  => leaderboards.counties.push({ name: doc.id, ...doc.data() }));
    countriesSnap.forEach(doc => leaderboards.countries.push({ name: doc.id, ...doc.data() }));
    pubsSnap.forEach(doc      => leaderboards.pubs.push({ name: doc.id, ...doc.data() }));

    // Build users leaderboard from pint_hashes grouped by display_name only
    // — never use session IDs or doc.id as fallback
    const userCounts = {};
    pints.forEach(p => {
      if (!p.display_name) return;
      userCounts[p.display_name] = (userCounts[p.display_name] || 0) + 1;
    });
    leaderboards.users = Object.entries(userCounts)
      .map(([name, count]) => ({ name, count, display_name: name }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return res.status(200).json({
      pints,
      leaderboards,
      total: pints.length,
    });

  } catch (error) {
    console.error('Firestore error:', error);
    return res.status(500).json({ error: error.message });
  }
}
