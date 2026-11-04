/**
 * Seeds a demo game with every module against a running server and prints the URLs.
 *
 *   npm run demo            (server on http://localhost:3000, web on http://localhost:5173)
 *   npx tsx scripts/demo.ts http://localhost:3000 http://localhost:5174
 */
import { deflateSync } from 'node:zlib';

const apiBase = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');
const webBase = (process.argv[3] ?? 'http://localhost:5173').replace(/\/$/, '');

async function call<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (!(init.body instanceof FormData)) headers['content-type'] = 'application/json';
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const res = await fetch(`${apiBase}${path}`, { ...init, headers });
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status}: ${body.error ?? JSON.stringify(body)}`);
  return body;
}

/** Tiny dependency-free PNG encoder: coloured shapes to memorise / caption. */
function demoPng(width = 320, height = 200): Buffer {
  const px = Buffer.alloc(width * height * 4, 255);
  const rect = (x0: number, y0: number, w: number, h: number, [r, g, b]: number[]) => {
    for (let y = y0; y < y0 + h; y++)
      for (let x = x0; x < x0 + w; x++) {
        const i = (y * width + x) * 4;
        px[i] = r!;
        px[i + 1] = g!;
        px[i + 2] = b!;
      }
  };
  rect(0, 0, width, height, [245, 240, 225]);
  rect(20, 30, 60, 60, [220, 50, 50]);
  rect(100, 30, 60, 60, [220, 50, 50]);
  rect(180, 30, 60, 60, [220, 50, 50]);
  rect(260, 30, 40, 60, [220, 50, 50]);
  rect(20, 120, 90, 50, [40, 90, 200]);
  rect(130, 120, 50, 50, [40, 160, 80]);
  rect(200, 120, 100, 50, [240, 190, 30]);

  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    px.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const crcTable = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc32 = (buf: Buffer) => {
    let c = -1;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function main(): Promise<void> {
  const health = await call<{ modules: number }>('/api/health');
  console.log(`Server OK (${health.modules} modules)`);

  const { game, hostToken } = await call<{ game: { id: string; code: string }; hostToken: string }>('/api/games', {
    method: 'POST',
    body: JSON.stringify({
      name: "Dabian's 35th Birthday",
      settings: { allowLateJoin: true, tieBreak: 'wins', evaluationPreference: 'module-default', judgeDeadlineSeconds: 60, maxReassignments: 2 },
      branding: { hostName: 'Dabian', accentColor: '#ff6a3d', introText: 'Grab a drink, pick a challenge!', finalText: 'Thanks for playing!' },
    }),
  });
  const token = hostToken;
  const add = (moduleId: string, configuration: Record<string, unknown>, options: Record<string, unknown> = {}) =>
    call(`/api/games/${game.id}/challenges`, { method: 'POST', token, body: JSON.stringify({ moduleId, configuration, ...options }) });

  const form = new FormData();
  form.append('file', new Blob([demoPng()], { type: 'image/png' }), 'shapes.png');
  const media = await call<{ ref: string }>(`/api/games/${game.id}/media`, { method: 'POST', token, body: form });

  // Every challenge opens when the game starts.
  await add('multiple-choice', { question: 'Which planet has the most moons?', options: ['Jupiter', 'Saturn', 'Uranus', 'Neptune'], correctIndex: 1, timeLimit: 20, points: 10 }, { title: 'Space trivia' });
  await add(
    'match-up',
    {
      instructions: 'Match each capital to its country',
      leftTitle: 'Capital',
      rightTitle: 'Country',
      pairs: [
        { left: 'Canberra', right: 'Australia' },
        { left: 'Ottawa', right: 'Canada' },
        { left: 'Bern', right: 'Switzerland' },
        { left: 'Wellington', right: 'New Zealand' },
        { left: 'Ankara', right: 'Turkey' },
      ],
      pointsPerMatch: 2,
    },
    { title: 'Capital match' },
  );
  await add(
    'name-them-all',
    {
      prompt: 'Name the Mars rovers',
      answers: [{ answer: 'Sojourner' }, { answer: 'Spirit' }, { answer: 'Opportunity' }, { answer: 'Curiosity' }, { answer: 'Perseverance' }, { answer: 'Zhurong', alternatives: 'Zhu Rong', points: 3 }],
      pointsEach: 2,
      timeLimit: 60,
    },
    { title: 'Mars rovers' },
  );
  await add('multi-answer', { question: 'How many keys does a standard piano have?', answers: [{ answer: '88', tolerance: 2, unit: 'keys' }], timeLimit: 20 }, { title: 'Piano keys' });
  await add(
    'multi-answer',
    {
      question: 'Name the Benelux capitals',
      answers: [
        { label: 'Belgium', answer: 'Brussels', alternatives: 'Brussel, Bruxelles' },
        { label: 'Netherlands', answer: 'Amsterdam' },
        { label: 'Luxembourg', answer: 'Luxembourg', alternatives: 'Luxemburg' },
      ],
      timeLimit: 45,
      points: 10,
    },
    { title: 'Benelux capitals' },
  );
  await add('closest-number', { question: 'How many golf balls fit in the jar?', correctAnswer: 137, timeLimit: 30, scoring: 'ranked' }, { title: 'The golf ball jar' });
  await add('timed-reaction', { minDelaySeconds: 2, maxDelaySeconds: 6, windowSeconds: 4, maxPoints: 10 }, { title: 'Fastest finger', allowReplay: true });
  await add('stop-the-clock', { targetSeconds: 10, maxPoints: 10, fullPointsMs: 10, zeroPointsMs: 500 }, { title: 'Stop at 10 seconds', allowReplay: true });
  await add('time-estimation', { targetSeconds: 45, maxPoints: 10, fullPointsMs: 500, zeroPointsMs: 10000 }, { title: 'Count to 45' });
  await add('color-match', { rounds: 10 }, { title: 'Color match' });
  await add('image-memory', { image: media.ref, viewSeconds: 8, question: 'How many red squares were there?', options: ['3', '4', '5', '6'], correctIndex: 1, answerSeconds: 15 }, { title: 'Look closely' });
  await add('caption-this', { image: media.ref, prompt: 'Caption this masterpiece', timeLimit: 90, points: 10 }, { title: 'Caption the art' });
  await add('photo-hunt', { task: 'Take a photo of something red in the room', timeLimit: 180, points: 10 }, { title: 'Red alert' });
  await add('majority-vote', { question: 'Pineapple on pizza?', options: ['Obviously yes', 'Absolutely not', 'Only when nobody is watching'], timeLimit: 20 }, { title: 'Pizza debate' });
  await add('blob-war', { points: 10, tapsToMax: 150, maxShare: 0.2 }, { title: 'Blob war' });
  await add('balloon-pop', { intervalMinutes: 1, pointsPerPop: 1 }, { title: 'Balloon pop' });
  await add('group-message', { prompt: 'Write a birthday message for Dabian', wordsPerTurn: 3, visibleWords: 35, turnSeconds: 300, maxTurnsPerPlayer: 10, pointsPerTurn: 1 }, { title: 'Birthday message' });
  await add('secret-word', { maxPoints: 10, pointsPerWord: 2 }, { title: 'Secret words' });
  await add('selfiemotion', { timeLimit: 120, points: 5 }, { title: 'Selfiemotion' });
  await add(
    'fill-in-the-blanks',
    { sentences: [{ text: 'The best thing about this party is ___.' }, { text: '___ and ___ walk into a bar.' }], pointsPerSentence: 2, showNames: true },
    { title: 'Fill in the blanks' },
  );
  await add('report-score', { prompt: 'How many points did you score at darts?', maxPoints: 20, penalty: 5 }, { title: 'Darts' });
  const hot = { category: 'Hot Takes' };
  await add('sliding-scales', { statements: [{ text: 'Maximum acceptable shower time', min: 0, max: 60, step: 1, unit: 'minutes' }, { text: 'Ideal number of pets', min: 0, max: 5 }] }, { title: 'Sliding scales', ...hot });
  await add('rivalries', { statements: [{ left: 'Star Wars', right: 'Star Trek', middle: 'Star Wars and Star Trek are basically the same' }] }, { title: 'Rivalries', ...hot });
  await add('binaries', { statements: [{ text: 'Taylor Swift is overrated' }] }, { title: 'Binaries', ...hot });
  await add('likelihoods', { statements: [{ text: 'Likelihood that the world will end because of climate change' }] }, { title: 'Likelihoods', ...hot });
  await add('agree-to-disagree', { statements: [{ text: 'Pineapple belongs on pizza' }] }, { title: 'Agree to disagree', ...hot });
  await add('prediction', { question: 'Who will give the best sales pitch?', optionsSource: 'players', timeLimit: 30, points: 10 }, { title: 'Pitch predictions' });
  await add('open-performance', { prompt: 'Give your best 30-second sales pitch for a paperclip', instructions: 'Type a catchy title, then perform it live for the host.', timeLimit: 120, points: 10 }, { title: 'Paperclip pitch', evaluationMode: 'host' });

  await call(`/api/games/${game.id}/actions`, { method: 'POST', token, body: JSON.stringify({ action: 'open-lobby' }) });

  console.log('');
  console.log(`Game:       ${game.code}`);
  console.log(`Host:       ${webBase}/host/${game.id}?hostToken=${hostToken}`);
  console.log(`Display:    ${webBase}/display/${game.code}`);
  console.log(`Join:       ${webBase}/join/${game.code}`);
  console.log('');
  console.log('Results stay hidden from players until you press "Reveal results" in the Run tab.');
  console.log('Keep the host token safe; it is the only credential for this game.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
