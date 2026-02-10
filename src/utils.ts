export const runWithConcurrency = async <T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> => {
  const results: R[] = [];
  let index = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const currentIndex = index++;
      results[currentIndex] = await worker(items[currentIndex]);
    }
  });

  await Promise.all(runners);
  return results;
};

export const formatHours = (value: number | null): string => {
  if (value === null) return "-";
  if (value < 1) return `${Math.round(value * 60)}m`;
  return `${value.toFixed(1)}h`;
};

export const formatPercent = (value: number | null): string => {
  if (value === null) return "-";
  return `${(value * 100).toFixed(1)}%`;
};
