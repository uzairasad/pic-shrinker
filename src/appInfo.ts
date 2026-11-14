export const APP_NAME = 'Pic Shrinker';
export const APP_VERSION: string = __APP_VERSION__;
export const AUTHOR = 'Uzair Asad';

export const PROJECT_LINKS = {
  website: 'https://uzairasad.github.io/pic-shrinker/',
  source: 'https://github.com/uzairasad/pic-shrinker',
  issues: 'https://github.com/uzairasad/pic-shrinker/issues',
  license: 'https://github.com/uzairasad/pic-shrinker/blob/main/LICENSE',
  notices: 'https://github.com/uzairasad/pic-shrinker/blob/main/THIRD-PARTY-NOTICES.md',
} as const;

export type ProjectLink = keyof typeof PROJECT_LINKS;
