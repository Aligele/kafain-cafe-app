export default async function handler(req, res) {
  return res.status(200).json({
    url: req.url,
    query: req.query,
    method: req.method,
  });
}
