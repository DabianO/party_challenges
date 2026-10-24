import { describe, expect, it } from 'vitest';
import type { PublishedStanding } from '@challenge/contract';
import { diffStandings } from '../src/standings.ts';

const s = (displayName: string, rank: number, total: number): PublishedStanding => ({ playerId: displayName.toLowerCase(), displayName, rank, total, completed: 1, series: [0, total] });
const texts = (prev: PublishedStanding[] | null, next: PublishedStanding[]) => diffStandings(prev, next, 1).map((i) => i.text);

describe('diffStandings', () => {
  it('announces the leader on the first publication (nothing when nobody scored)', () => {
    expect(texts(null, [s('Ada', 1, 10), s('Bea', 2, 5)])).toEqual(['Ada leads the race']);
    expect(texts(null, [s('Ada', 1, 10), s('Bea', 1, 10)])).toEqual(['Ada and Bea share the lead']);
    expect(texts(null, [s('Ada', 1, 0), s('Bea', 1, 0)])).toEqual([]);
  });

  it('reports overtakes and a new leader, best rank first', () => {
    const prev = [s('Ada', 1, 30), s('Bea', 2, 20), s('Cyd', 3, 10), s('Dex', 4, 5)];
    const next = [s('Cyd', 1, 35), s('Ada', 2, 30), s('Dex', 3, 25), s('Bea', 4, 20)];
    const items = diffStandings(prev, next, 1);
    expect(items.map((i) => i.text)).toEqual(['Cyd takes the lead from Ada and Bea', 'Dex moves up to #3, passing Bea']);
    expect(items[0]).toMatchObject({ kind: 'lead', playerId: 'cyd', rank: 1, previousRank: 3, passed: ['Ada', 'Bea'] });
    expect(items[1]).toMatchObject({ kind: 'overtake', previousRank: 4 });
  });

  it('handles ties, newcomers and summarises long lists', () => {
    expect(texts([s('Ada', 1, 30), s('Bea', 2, 20), s('Cyd', 3, 10)], [s('Ada', 1, 30), s('Cyd', 2, 20), s('Bea', 2, 20)])).toEqual(['Cyd draws level with Bea at #2']);
    expect(texts([s('Ada', 1, 30), s('Bea', 2, 20)], [s('Ada', 1, 30), s('Bea', 1, 30)])).toEqual(['Bea draws level for the lead with Ada']);
    expect(texts([s('Ada', 1, 30)], [s('Ada', 1, 30), s('Gus', 2, 5), s('Hal', 3, 0)])).toEqual(['Gus joins the race at #2']);
    const many = [s('A', 1, 50), s('B', 2, 40), s('C', 3, 30), s('D', 4, 20), s('E', 5, 10)];
    expect(texts(many, [s('E', 1, 60), s('A', 2, 50), s('B', 3, 40), s('C', 4, 30), s('D', 5, 20)])).toEqual(['E takes the lead from A, B and 2 others']);
  });

  it('ignores rank changes caused only by players leaving', () => {
    expect(texts([s('Ada', 1, 30), s('Bea', 2, 20), s('Cyd', 3, 10)], [s('Bea', 1, 20), s('Cyd', 2, 10)])).toEqual([]);
  });
});
