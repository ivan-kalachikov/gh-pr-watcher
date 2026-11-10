const svg = (body, { fill = false } = {}) =>
  `<svg class="icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" ${
    fill ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"'
  }>${body}</svg>`;

export const icons = {
  pr: svg(
    '<circle cx="4" cy="3.5" r="1.75"/><circle cx="4" cy="12.5" r="1.75"/><circle cx="12" cy="12.5" r="1.75"/>' +
      '<path d="M4 5.25v5.5M12 10.75V6.5A2 2 0 0 0 10 4.5H7.5M9 3 7.5 4.5 9 6"/>',
  ),
  check: svg('<path d="M3 8.5 6.5 12 13 4.5"/>'),
  x: svg('<path d="M4 4l8 8M12 4l-8 8"/>'),
  comment: svg('<path d="M2.5 3.5h11v7.25H8l-3 2.5v-2.5H2.5z"/>'),
  eye: svg('<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>'),
  dot: svg('<circle cx="8" cy="8" r="4"/>', { fill: true }),
  ring: svg('<circle cx="8" cy="8" r="3.5"/>'),
  refresh: svg('<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3"/>'),
  settings: svg(
    '<path d="M2 4h7M12 4h2M2 12h2M7 12h7M2 8h3M8 8h6"/><circle cx="10.5" cy="4" r="1.5"/><circle cx="5.5" cy="12" r="1.5"/><circle cx="6.5" cy="8" r="1.5"/>',
  ),
  checkAll: svg('<path d="M1.5 8.5 5 12l6.5-7.5M8 11.5l.5.5L15 4.5"/>'),
  chevron: svg('<path d="M4 6l4 4 4-4"/>'),
  search: svg('<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/>'),
  lock: svg('<rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>'),
  warn: svg('<path d="M8 2 14.5 13.5h-13z"/><path d="M8 6.5v3M8 11.5v.01"/>'),
};
