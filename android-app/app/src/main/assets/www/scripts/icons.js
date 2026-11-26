(function (root) {
  const SVG_ATTRS = 'viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  const FILL_ATTRS = 'viewBox="0 0 24 24" width="16" height="16" fill="currentColor"';

  const ICONS = {
    home: `<svg ${SVG_ATTRS}><path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>`,
    search: `<svg ${SVG_ATTRS}><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`,
    video: `<svg ${SVG_ATTRS}><rect x="2" y="5" width="15" height="14" rx="2"/><path d="m17 10 5-3v10l-5-3z"/></svg>`,
    library: `<svg ${SVG_ATTRS}><path d="M4 19.5v-15"/><path d="M9 19.5v-15"/><path d="m14 5 6 14.5"/></svg>`,
    sliders: `<svg ${SVG_ATTRS}><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="2" y1="14" x2="6" y2="14"/><line x1="10" y1="8" x2="14" y2="8"/><line x1="18" y1="16" x2="22" y2="16"/></svg>`,
    download: `<svg ${SVG_ATTRS}><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>`,
    play: `<svg ${FILL_ATTRS}><polygon points="6,4 20,12 6,20"/></svg>`,
    pause: `<svg ${FILL_ATTRS}><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>`,
    prev: `<svg ${FILL_ATTRS}><path d="M6 5h2v14H6zM9.5 12 19 18V6z"/></svg>`,
    next: `<svg ${FILL_ATTRS}><path d="M16 5h2v14h-2zM5 18l9.5-6L5 6z"/></svg>`,
    shuffle: `<svg ${SVG_ATTRS}><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>`,
    repeat: `<svg ${SVG_ATTRS}><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`,
    heart: `<svg ${SVG_ATTRS}><path d="M19.5 12.57 12 20l-7.5-7.43a5 5 0 0 1 7.5-6.57 5 5 0 0 1 7.5 6.57z"/></svg>`,
    heartFilled: `<svg ${FILL_ATTRS}><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`,
    volume: `<svg ${SVG_ATTRS}><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`,
    lyrics: `<svg ${SVG_ATTRS}><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>`,
    queue: `<svg ${SVG_ATTRS}><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="15" y2="12"/><line x1="3" y1="18" x2="12" y2="18"/><polygon points="17 14 22 17 17 20" fill="currentColor" stroke="none"/></svg>`,
    moon: `<svg ${SVG_ATTRS}><path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z"/></svg>`,
    expand: `<svg ${SVG_ATTRS}><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`,
    plus: `<svg ${SVG_ATTRS}><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
    folder: `<svg ${SVG_ATTRS}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`,
    trash: `<svg ${SVG_ATTRS}><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>`,
    music: `<svg ${SVG_ATTRS}><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`,
    clock: `<svg ${SVG_ATTRS}><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>`,
    close: `<svg ${SVG_ATTRS}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    chevronDown: `<svg ${SVG_ATTRS}><polyline points="6 9 12 15 18 9"/></svg>`,
    arrowLeft: `<svg ${SVG_ATTRS}><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>`,
    moreVert: `<svg ${FILL_ATTRS}><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>`,
    sort: `<svg ${SVG_ATTRS}><path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="m21 8-4-4-4 4"/><path d="M17 4v16"/></svg>`,
    pin: `<svg ${FILL_ATTRS}><path d="M16 3l5 5-2 2-2-1-4 4v5l-2 2-3-5-5 3-1-1 3-5-5-3 2-2h5l4-4-1-2 2-2z"/></svg>`,
    plusCircle: `<svg ${SVG_ATTRS}><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>`,
    checkCircle: `<svg ${FILL_ATTRS}><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm-1.1 14.2L6.7 12l1.4-1.4 2.8 2.8 5.6-5.6 1.4 1.4z"/></svg>`,
    listPlus: `<svg ${SVG_ATTRS}><path d="M11 12H3"/><path d="M16 6H3"/><path d="M16 18H3"/><path d="M18 9v6"/><path d="M21 12h-6"/></svg>`
  };

  root.YumaIcons = ICONS;
})(typeof window !== 'undefined' ? window : globalThis);
