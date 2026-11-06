/**
 * Tests for the Mic check panel's words (src/app/panels/mic-check.ts): the
 * table keeps only the values with a recommendation, formats each in its own
 * unit, and the section verdicts talk about the mic and never the singing.
 */
import { describe, expect, it } from 'vitest';
import { describeSection, tuningRows } from '../src/app/panels/mic-check';
import type { TakeAnalysis } from '../src/service/types';

function analysis(recommended: Partial<TakeAnalysis['recommended']>): TakeAnalysis {
  return {
    report_text: '',
    findings: [],
    sections: [],
    current: {
      draw_margin_db: 8,
      clarity_threshold: 0.9,
      bleed_match_cents: 30,
      bleed_min_match: 0.6,
      bleed_max_median_cents: 15,
      latency_s: null,
    },
    recommended: {
      draw_margin_db: null,
      clarity_threshold: null,
      bleed_match_cents: null,
      bleed_min_match: null,
      bleed_max_median_cents: null,
      latency_s: null,
      ...recommended,
    },
    notes: [],
  };
}

describe('tuningRows', () => {
  it('is empty when nothing is recommended', () => {
    expect(tuningRows(analysis({}))).toEqual([]);
  });

  it('lists only the values on offer, current beside recommended, in their units', () => {
    const rows = tuningRows(
      analysis({ draw_margin_db: 11.25, bleed_min_match: 0.7, bleed_match_cents: 22.4, latency_s: 0.1234 }),
    );
    expect(rows.map((r) => [r.label, r.current, r.recommended])).toEqual([
      ['Voice level above room noise', '8.0 dB', '11.3 dB'],
      ['Echo match window', '30 cents', '22 cents'],
      ['Share that must match', '60%', '70%'],
      ['Latency', 'not set', '123 ms'],
    ]);
  });
});

describe('describeSection', () => {
  it('names the step and what the mic heard, never how well anyone sang', () => {
    const sung = describeSection({ label: 'sing-along', kind: 'sing', verdict: 'singer', start_s: 15, end_s: 30 });
    expect(sung).toEqual({ name: 'Singing along', verdict: 'Your voice came through' });
    const bleed = describeSection({ label: 'speakers', kind: 'silent', verdict: 'likely_bleed', start_s: 5, end_s: 15 });
    expect(bleed.verdict).toMatch(/through the speakers/);
    const odd = describeSection({ label: 'mystery', kind: 'sing', verdict: 'unclear', start_s: 0, end_s: 1 });
    expect(odd).toEqual({ name: 'mystery', verdict: 'Could not tell' });
  });
});
