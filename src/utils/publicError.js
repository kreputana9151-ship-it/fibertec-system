const SENSITIVE_ERROR = /(?:postgres(?:ql)?|sqlstate|database|relation .* does not exist|column .* does not exist|constraint|duplicate key|violates .*|[A-Za-z]:[\\/]|(?:^|\s)\/(?:[^/\s]+\/)+|node_modules[\\/]|src[\\/])/i;

function publicErrorMessage(error, fallback) {
  if (!error || error.code) return fallback;
  const message = typeof error.message === 'string' ? error.message : '';
  return message && !SENSITIVE_ERROR.test(message) ? message : fallback;
}

function publicErrorStatus(error, fallback) {
  if (error && error.code) return 500;
  return error && Number.isInteger(error.status) ? error.status : fallback;
}

module.exports = { publicErrorMessage, publicErrorStatus };
