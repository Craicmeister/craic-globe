export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600');

  const mapboxToken = process.env.MAPBOX_TOKEN;

  if (!mapboxToken) {
    return res.status(500).json({ error: 'Mapbox token not configured' });
  }

  return res.status(200).json({ mapboxToken });
}
