function manilaToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const part = type => parts.find(item => item.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function installedDateError(value, today = manilaToday()) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return 'Invalid installed date.';
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    return 'Invalid installed date.';
  }
  if (value < '2020-01-01') {
    return 'Installed date cannot be earlier than January 1, 2020.';
  }
  if (value > today) {
    return 'Installed date cannot be in the future (Asia/Manila).';
  }
  return null;
}

module.exports = { manilaToday, installedDateError };
