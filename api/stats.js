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
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');

  try {
    // Total pints ever
    const totalSnap = await db.collection('pint_hashes').count().get();
    const total = totalSnap.data().count;

    // Pints today
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todaySnap = await db.collection('pint_hashes')
      .where('timestamp', '>=', today)
      .count().get();
    const today_count = todaySnap.data().count;

    // Total $CRAIC distributed
    const total_craic = total * 5000;

    // Countries count
    const countriesSnap = await db.collection('leaderboard_countries').count().get();
    const countries_count = countriesSnap.data().count;

    return res.status(200).json({
      total_pints: total,
      today_pints: today_count,
      total_craic,
      countries_count,
    });

  } catch (error) {
    console.error('Stats error:', error);
    return res.status(500).json({ error: error.message });
  }
}
