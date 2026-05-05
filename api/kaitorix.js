module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const jan = req.query.jan || '';

  return res.status(200).json({
    ok: true,
    message: 'APIは動いています',
    jan,
    checkedAt: new Date().toISOString()
  });
};
