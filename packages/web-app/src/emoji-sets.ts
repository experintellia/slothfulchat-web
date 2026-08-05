/**
 * The emoji-set catalogue — single source of truth for the emoji-set picker
 * (Settings → Appearance). Imported by both the app (runtime.ts applies the
 * stack + exposes the picker hook) and the analytics catalogue (events.ts
 * derives its `set` vocabulary from here, so the two can never drift).
 *
 * Each set maps to a value for the CSS custom property `--emojifonts` (emoji
 * families only — the theme's `--fonts-default` wraps it with Roboto and the
 * sans-serif fallbacks). `Sloth*` names are OUR lazy @font-face families
 * (static/fonts/emoji-fonts.css, loaded per unicode-range, excluded from the SW
 * precache); bare names are SYSTEM fonts, so the 'native' option downloads
 * nothing. Naming ours `Sloth*` is what lets 'native' still reach the system's
 * own 'Noto Color Emoji' without colliding with our web font of the same face.
 */
export type EmojiSet = {
  id: string
  label: string
  note?: string
  /** fires the once-per-startup `emoji_set` event; see TRACKED_EMOJI_SETS */
  track: boolean
  /** value for the CSS custom property `--emojifonts` */
  fonts: string
}

export const EMOJI_SETS: readonly EmojiSet[] = [
  {
    id: 'standard',
    label: 'Standard',
    note: 'Your device’s own emoji on Apple; Google Noto Color everywhere else.',
    track: false,
    fonts: `'Apple Color Emoji', 'SlothNotoColor'`,
  },
  {
    id: 'noto_color',
    label: 'Google Noto Color',
    track: true,
    fonts: `'SlothNotoColor'`,
  },
  {
    id: 'noto_mono',
    label: 'Google Noto (black & white)',
    track: true,
    fonts: `'SlothNotoMono'`,
  },
  {
    id: 'twemoji',
    label: 'Twemoji',
    track: true,
    fonts: `'SlothTwemoji'`,
  },
  {
    id: 'native',
    label: 'Full native',
    note: 'Whatever emoji your operating system provides — nothing is downloaded.',
    track: true,
    fonts: `'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji', 'Twemoji Mozilla'`,
  },
]

export const DEFAULT_EMOJI_SET = 'standard'

const byId: Record<string, EmojiSet> = Object.fromEntries(EMOJI_SETS.map(s => [s.id, s]))

/** The `--emojifonts` value for a set id; falls back to the default set. */
export function emojiFonts(id: string): string {
  return (byId[id] || byId[DEFAULT_EMOJI_SET]).fonts
}

/** Ids of the sets that fire the once-per-startup `emoji_set` event (every
 * non-default set — 'standard' is never reported). */
export const TRACKED_EMOJI_SETS = EMOJI_SETS.filter(s => s.track).map(s => s.id)
