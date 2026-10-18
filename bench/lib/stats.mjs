// Order statistics used by every cell. stdev is the sample standard deviation;
// q1/q3 use linear interpolation (same convention as numpy's default percentile).
export function quantile(sorted, q) {
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos); const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function stats(values, unit) {
  if (!values.length) throw new Error('stats() needs at least one sample');
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((s, x) => s + x, 0) / n;
  const stdev = n > 1 ? Math.sqrt(sorted.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
  const r = (x) => Math.round(x * 1000) / 1000;
  return { unit, n, median: r(quantile(sorted, 0.5)), min: r(sorted[0]), max: r(sorted[n - 1]), mean: r(mean), stdev: r(stdev),
    q1: r(quantile(sorted, 0.25)), q3: r(quantile(sorted, 0.75)) };
}
