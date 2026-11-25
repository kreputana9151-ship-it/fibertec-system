function pagination(req, defaultLimit = 500, maxLimit = 1000) {
  const rawLimit = Number(req.query.limit);
  const rawOffset = Number(req.query.offset);
  const limit = Number.isSafeInteger(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, maxLimit)
    : defaultLimit;
  const offset = Number.isSafeInteger(rawOffset) && rawOffset > 0
    ? Math.min(rawOffset, 1000000000)
    : 0;
  return { limit, offset };
}

module.exports = { pagination };
