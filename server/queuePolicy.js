function selectNextQueuedBattle(queueRows = []) {
  if (!Array.isArray(queueRows) || queueRows.length === 0) return null;

  const pfpCandidate = queueRows.find((row) => row && Boolean(row.is_pfp));
  const bantahCandidate = queueRows.find((row) => row && !Boolean(row.is_pfp));

  if (!pfpCandidate && !bantahCandidate) return queueRows[0] || null;
  if (!pfpCandidate) return bantahCandidate || queueRows[0];
  if (!bantahCandidate) return pfpCandidate || queueRows[0];

  const pfpCount = queueRows.filter((row) => row && Boolean(row.is_pfp)).length;
  const bantahCount = queueRows.filter((row) => row && !Boolean(row.is_pfp)).length;

  if (pfpCount >= bantahCount * 3) {
    return bantahCandidate;
  }

  return pfpCandidate;
}

module.exports = {
  selectNextQueuedBattle,
};
