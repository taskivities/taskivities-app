/**
 * "Select all" in the switcher's Several mode (src/components/Popover.tsx): ticks every row the search shows in one
 * section, or unticks them all when they're all ticked already. Rows the search hides keep whatever they had.
 */
export const allPicked = (picked: string[], shown: string[]): boolean => shown.length > 0 && shown.every((id) => picked.includes(id));

export const toggleAll = (picked: string[], shown: string[]): string[] =>
  allPicked(picked, shown) ? picked.filter((id) => !shown.includes(id)) : [...picked, ...shown.filter((id) => !picked.includes(id))];
