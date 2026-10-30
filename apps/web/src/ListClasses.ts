export const headClass =
  "sticky top-0 z-raised flex h-band items-center gap-2.5 bg-head pr-1.5 pl-3.5 shadow-under-g-line backdrop-blur-md";
export const headNameClass =
  "m-0 font-display text-lg leading-tight font-extrabold tracking-tight whitespace-nowrap";
export const headMetaClass = "truncate text-sm text-ink-3";
export const headActionClass =
  "ml-auto h-7.5 flex-none rounded-full px-3.5 text-xs font-semibold shadow-ring-g-line transition-tint-ring hover:bg-ink hover:text-island hover:shadow-none active:scale-press";

export const emptyClass = "px-3.5 py-7";
export const emptyBigClass = "m-0 font-sans text-base leading-snug font-semibold text-ink-2";
export const emptySubClass = "mx-0 mt-1.5 mb-0 text-sm text-ink-3";

export const rowsClass = "m-0 list-none px-0 pt-1.5 pb-18";
export const rowLinkClass =
  "grid grid-cols-row items-baseline gap-x-3 gap-y-px rounded-2xl px-3.5 py-3 text-ink-2 no-underline focus-visible:outline-offset-inset";
export const rowAvatarClass = "mt-0.5 text-av-lg";
export const rowMetaClass =
  "col-start-2 col-end-4 min-w-0 self-center truncate pr-20 text-xs text-ink-3";

type RowState = { unread: boolean; selected: boolean };

export const rowClass = (selected: boolean) =>
  `row group relative rounded-2xl transition-bg not-first:before:absolute not-first:before:top-0 not-first:before:right-3.5 not-first:before:left-14.5 not-first:before:h-px not-first:before:bg-g-line ${selected ? "sel bg-island elevation-row" : "hover:bg-g-hover"}`;

export const rowAvClass = ({ unread, selected }: RowState, hue: number | undefined) =>
  `relative col-start-1 row-start-1 self-start ${unread ? `after:absolute after:top-0 after:-left-1 after:size-2.75 after:rounded-circle ${hue === undefined ? "after:bg-ink" : "after:bg-tag"} ${selected ? "after:shadow-halo-island" : "after:shadow-halo-ground group-hover:after:shadow-halo-g-hover"}` : ""}`;

export const rowTitleClass = ({ unread, selected }: RowState) =>
  `col-start-2 row-start-1 min-w-0 truncate text-base ${unread ? "font-bold text-ink" : selected ? "font-medium text-ink" : "font-medium text-ink-2"}`;

export const rowTimeClass = (unread: boolean) =>
  `col-start-3 row-start-1 min-w-0 truncate text-right text-xs tabular-nums ${unread ? "font-semibold text-ink" : "text-ink-3"}`;

export const rowLineClass = (unread: boolean) =>
  `col-start-2 col-end-4 min-w-0 truncate text-sm ${unread ? "text-ink-2" : "text-ink-3"}`;
