const { load, shorten } = require('../lib/store');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const id = String(req.query?.id || '');
  if (!/^[a-f0-9]{32}$/.test(id)) return res.status(400).json({ state: 'expired' });

  try {
    const s = await load(id);
    if (!s) return res.status(404).json({ state: 'expired' });
    if (s.state === 'done') await shorten(id, 60); // the ID only lingers a minute after it is shown
    return res.status(200).json(s);
  } catch {
    return res.status(500).json({ state: 'error', error: 'Could not read the session status.' });
  }
};
