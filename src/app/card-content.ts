/**
 * Gathers what a report card says into the plain content the picture is laid
 * out from (card-layout.ts): the skin's title and name, the song, the date,
 * the stars and personal-best lines and the card's own sentences. The
 * sentences come from the ReportView the card is drawn from, so the picture
 * says what the panel says. Learning mode only.
 */
import { copyFor } from '../skins';
import type { Skin } from '../skins/types';
import type { CardContent } from './card-layout';
import { localDateString } from './card-layout';
import type { ReportView } from './report';

/** What the card content is made from. */
export interface CardSource {
  view: ReportView;
  songName: string;
  createdAt: number;
  /** The stars line and the personal-best line, each '' when not due. */
  stars: string;
  personalBest: string;
  skin: Skin;
}

/** The content of the picture of a report card. */
export function cardContentOf(source: CardSource): CardContent {
  const { view, skin } = source;
  const lines: string[] = [];
  if (view.melodyShare) lines.push(view.melodyShare);
  if (view.coverage) lines.push(view.coverage);
  if (view.hasMelody) {
    lines.push(view.timing);
    for (const phrase of view.phrases) lines.push(`Worst phrase: ${phrase.text}`);
    lines.push(view.range);
  }
  if (view.freestyle !== null) lines.push(view.freestyle.summary);
  return {
    title: copyFor(skin, 'reportTitle'),
    songName: source.songName.replace(/\.[a-z0-9]{2,5}$/i, ''),
    date: localDateString(source.createdAt),
    stars: source.stars,
    personalBest: source.personalBest,
    headline: view.headline,
    lines: lines.filter((l) => l !== ''),
    skinName: `encore, ${skin.name} skin`,
  };
}
