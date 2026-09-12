/** Pure calculation for the Market compact/expand row disclosure. No Request
 * data is ever dropped: this only decides how many already-loaded rows are
 * visible, never what was fetched from Arkiv. */
export function computeMarketDisclosure({ rowCount, limit, expanded }) {
  const hasHidden = rowCount > limit;
  const visibleCount = !hasHidden || expanded ? rowCount : limit;
  const hiddenCount = rowCount - visibleCount;
  return {
    visibleCount,
    hiddenCount,
    hasHidden,
    buttonLabel: !hasHidden
      ? ''
      : expanded
        ? 'Show fewer requests ↑'
        : `Show ${hiddenCount} more request${hiddenCount === 1 ? '' : 's'} ↓`,
  };
}
