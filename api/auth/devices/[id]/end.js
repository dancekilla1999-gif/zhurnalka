module.exports = function (req, res) {
  req.query = Object.assign({}, req.query, { id: (req.query && req.query.id) || '' });
  return require('../../../../srv/lib/auth-handlers').authDeviceEnd(req, res);
};
